/**
 * M3 (cortex#1241, ADR-0019) — runtime OUTBOUND seal integration.
 *
 * Proves the publish path seals `federated.*` payloads with the per-network key
 * (encrypt-then-sign: the published envelope carries ciphertext in `payload` AND
 * a fresh `signed_by` stamp over it), leaves `local.*` cleartext, and warns
 * loud-but-not-fatal when encryption is enabled without a key.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NatsConnection, Subscription, Status } from "nats";
import sodium from "libsodium-wrappers";
import type { AgentConfig } from "../../../common/types/config";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type { Envelope } from "../envelope-validator";
import { startMyelinRuntime } from "../runtime";
import {
  NetworkKeyring,
  openPayload,
  readMarker,
} from "../../../common/crypto/payload-encryption";

function makeConfig(natsBlock: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "luna", displayName: "Luna" },
    nats: natsBlock,
  } as unknown as AgentConfig;
}

function makeFakeNats() {
  const publishes: { subject: string; payload: string }[] = [];
  const statusListeners = new Set<(s: Status | null) => void>();
  const status = () =>
    (async function* () {
       
      while (true) {
        const next = await new Promise<Status | null>((r) => {
          statusListeners.add(r);
        });
        if (next === null) return;
        yield next;
      }
    })();
  const subscribe = mock(() => {
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    // eslint-disable-next-line require-yield
    const iterator = (async function* () {
      await p;
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => done()),
      closed: Promise.resolve(),
    } as unknown as Subscription;
  });
  const drain = mock(async () => {
    for (const l of statusListeners) l(null);
  });
  const publish = mock((subject: string, payload: string | Uint8Array) => {
    publishes.push({ subject, payload: payload as string });
  });
  const nc = { status, subscribe, drain, publish } as unknown as NatsConnection;
  return { nc, publishes };
}

async function makeKey(): Promise<{ b64: string; bytes: Uint8Array }> {
  await sodium.ready;
  const bytes = sodium.randombytes_buf(32);
  return { b64: Buffer.from(bytes).toString("base64"), bytes };
}

function network(o: Partial<PolicyFederatedNetwork> & { id: string }): PolicyFederatedNetwork {
  return {
    leaf_node: "leaf-jc",
    peers: [{ principal_id: "jc", stack_id: "jc/host" }],
    accept_subjects: [],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
    ...o,
  };
}

function federatedEnvelope(): Envelope {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "andreas.meta-factory.luna",
    type: "dispatch.task.dispatched",
    timestamp: new Date().toISOString(),
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 3,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { prompt: "confidential", secret: "do-not-leak" },
  };
}

async function signerOpt() {
  const { createUser } = await import("@nats-io/nkeys");
  const kp = createUser();
  const rawSeedBytes = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  return { rawSeedBytes, principal: "did:mf:andreas-meta-factory" };
}

describe("runtime outbound seal", () => {
  let errors: string[];
  let restore: () => void;
  beforeEach(() => {
    errors = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    restore = () => {
      console.error = origError;
    };
  });
  afterEach(() => restore());

  test("seals a federated.* payload (encrypt-then-sign) — ciphertext + signed_by, no plaintext", async () => {
    const key = await makeKey();
    const fake = makeFakeNats();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: async () => fake.nc,
        signer: await signerOpt(),
        federatedNetworks: [
          network({ id: "research", encryption: "enabled", payload_key: key.b64 }),
        ],
      },
    );
    expect(runtime.publishOnSubject).toBeDefined();
    await runtime.publishOnSubject!(
      federatedEnvelope(),
      "federated.jc.host.tasks.review.requested",
    );

    expect(fake.publishes).toHaveLength(1);
    const published = JSON.parse(fake.publishes[0]!.payload) as Envelope;

    // Sealed: extensions.enc marker + ciphertext-in-payload; no cleartext leak.
    expect(readMarker(published)).toEqual({
      alg: "xchacha20poly1305",
      net: "research",
      kid: "research/k1",
    });
    expect(typeof published.payload.ciphertext).toBe("string");
    expect(fake.publishes[0]!.payload).not.toContain("do-not-leak");
    // Signed AFTER sealing (encrypt-then-sign): a stamp over the ciphertext.
    expect(Array.isArray(published.signed_by)).toBe(true);

    // A member holding K recovers the plaintext.
    const opened = await openPayload(
      published,
      new NetworkKeyring([{ net: "research", keys: [{ kid: "research/k1", key: key.bytes }] }]),
    );
    expect(opened.payload).toEqual(federatedEnvelope().payload);

    await runtime.stop();
  });

  test("seals a SELF-addressed federated Offer subject (cortex#1246) — federated.{ownPrincipal}.…", async () => {
    // A federated Offer is published on a self-addressed subject
    // `federated.{ownPrincipal}.{ownStack}.tasks.<cap>` — segment[1] is the
    // offerer's OWN principal, never in its own peers[]. The seal must still
    // engage (resolve by the own network, not a peer). Single encryption-enabled
    // network (the metafactory deployment) is the case that MUST work now.
    const key = await makeKey();
    const fake = makeFakeNats();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: async () => fake.nc,
        signer: await signerOpt(),
        principal: "andreas",
        stack: "meta-factory",
        federatedNetworks: [
          network({ id: "research", encryption: "required", payload_key: key.b64 }),
        ],
      },
    );
    // Self-addressed: target-principal segment == our own principal "andreas".
    await runtime.publishOnSubject!(
      federatedEnvelope(),
      "federated.andreas.meta-factory.tasks.code-review.requested",
    );

    expect(fake.publishes).toHaveLength(1);
    const published = JSON.parse(fake.publishes[0]!.payload) as Envelope;
    // SEALED — extensions.enc marker + ciphertext-only payload, no cleartext.
    expect(readMarker(published)).toEqual({
      alg: "xchacha20poly1305",
      net: "research",
      kid: "research/k1",
    });
    expect(typeof published.payload.ciphertext).toBe("string");
    expect(fake.publishes[0]!.payload).not.toContain("do-not-leak");
    expect(fake.publishes[0]!.payload).not.toContain("confidential");
    // A member holding K recovers the Offer plaintext.
    const opened = await openPayload(
      published,
      new NetworkKeyring([{ net: "research", keys: [{ kid: "research/k1", key: key.bytes }] }]),
    );
    expect(opened.payload).toEqual(federatedEnvelope().payload);
    await runtime.stop();
  });

  test("multi-network self-addressed Offer cannot resolve → cleartext + loud warn-once (cortex#1246)", async () => {
    // On MULTIPLE encryption-enabled networks the seal network is unresolvable
    // from a self-addressed subject alone — we MUST NOT seal with a guessed key.
    // Publish cleartext but warn ONCE so the gap is never silent.
    const key = await makeKey();
    const fake = makeFakeNats();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: async () => fake.nc,
        signer: await signerOpt(),
        principal: "andreas",
        stack: "meta-factory",
        federatedNetworks: [
          network({ id: "research", encryption: "required", payload_key: key.b64 }),
          network({ id: "lab", encryption: "enabled", payload_key: key.b64 }),
        ],
      },
    );
    await runtime.publishOnSubject!(
      federatedEnvelope(),
      "federated.andreas.meta-factory.tasks.code-review.requested",
    );
    await runtime.publishOnSubject!(
      federatedEnvelope(),
      "federated.andreas.meta-factory.tasks.code-review.requested",
    );
    const published = JSON.parse(fake.publishes[0]!.payload) as Envelope;
    expect(readMarker(published)).toBeUndefined(); // cleartext (not sealed with a guessed key)
    const warns = errors.filter((e) => e.includes("could NOT be sealed"));
    expect(warns).toHaveLength(1); // warned, only ONCE despite two publishes
    await runtime.stop();
  });

  test("never seals a local.* payload", async () => {
    const key = await makeKey();
    const fake = makeFakeNats();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: async () => fake.nc,
        signer: await signerOpt(),
        federatedNetworks: [
          network({ id: "research", encryption: "required", payload_key: key.b64 }),
        ],
      },
    );
    await runtime.publishOnSubject!(
      { ...federatedEnvelope(), sovereignty: { ...federatedEnvelope().sovereignty, classification: "local" } },
      "local.andreas.meta-factory.system.tick",
    );
    const published = JSON.parse(fake.publishes[0]!.payload) as Envelope;
    expect(readMarker(published)).toBeUndefined();
    expect(published.payload).toMatchObject({ secret: "do-not-leak" });
    await runtime.stop();
  });

  test("encryption enabled but NO key → loud-but-not-fatal warning + cleartext", async () => {
    const fake = makeFakeNats();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: async () => fake.nc,
        signer: await signerOpt(),
        federatedNetworks: [network({ id: "research", encryption: "required" })], // no payload_key
      },
    );
    await runtime.publishOnSubject!(federatedEnvelope(), "federated.jc.host.tasks.review.requested");
    await runtime.publishOnSubject!(federatedEnvelope(), "federated.jc.host.tasks.review.requested");

    const published = JSON.parse(fake.publishes[0]!.payload) as Envelope;
    expect(readMarker(published)).toBeUndefined(); // cleartext
    // Warned, and only ONCE per network despite two publishes.
    const warns = errors.filter((e) => e.includes("IN THE CLEAR"));
    expect(warns).toHaveLength(1);
    await runtime.stop();
  });

  test("encryption off → cleartext (byte-identical to pre-M3)", async () => {
    const key = await makeKey();
    const fake = makeFakeNats();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: async () => fake.nc,
        signer: await signerOpt(),
        federatedNetworks: [network({ id: "research", encryption: "off", payload_key: key.b64 })],
      },
    );
    await runtime.publishOnSubject!(federatedEnvelope(), "federated.jc.host.tasks.review.requested");
    const published = JSON.parse(fake.publishes[0]!.payload) as Envelope;
    expect(readMarker(published)).toBeUndefined();
    await runtime.stop();
  });
});
