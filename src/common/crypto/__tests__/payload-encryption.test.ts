/**
 * M3 — per-network-key payload encryption (TC-3.1). cortex#1241 / ADR-0019.
 *
 * Security-critical: round-trip, metadata-cleartext, fail-closed (wrong key,
 * tamper, header-lift), keyring (kid select + grace window), missing-key.
 */

import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import {
  NetworkKeyUnavailableError,
  NetworkKeyring,
  PAYLOAD_ENC_ALG,
  isSealedPayload,
  openPayload,
  readMarker,
  sealPayload,
  type NetworkKey,
} from "../payload-encryption";

async function key(kid: string): Promise<NetworkKey> {
  await sodium.ready;
  return { kid, key: sodium.randombytes_buf(32) };
}

function baseEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "andreas.meta-factory.luna",
    type: "dispatch.task.dispatched",
    timestamp: "2026-06-27T00:00:00.000Z",
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 3,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { task: "review PR #42", secret: "do-not-leak", n: 7 },
    ...overrides,
  };
}

describe("sealPayload / openPayload round-trip", () => {
  test("seals then opens, recovering the exact payload", async () => {
    const k = await key("net1/k1");
    const env = baseEnvelope();
    const sealed = await sealPayload(env, "net1", k);
    const keyring = new NetworkKeyring([{ net: "net1", keys: [k] }]);
    const opened = await openPayload(sealed, keyring);
    expect(opened.payload).toEqual(env.payload);
  });

  test("round-trips a nested / structured payload", async () => {
    const k = await key("net1/k1");
    const env = baseEnvelope({
      payload: { a: { b: [1, 2, { c: true }] }, s: "héllo 🌍", z: null },
    });
    const sealed = await sealPayload(env, "net1", k);
    const opened = await openPayload(
      sealed,
      new NetworkKeyring([{ net: "net1", keys: [k] }]),
    );
    expect(opened.payload).toEqual(env.payload);
  });

  test.each(["dispatch.task.dispatched", "dispatch.task.delegated", "dispatch.task.offered"])(
    "all federated dispatch modes (%s) seal + open identically",
    async (type) => {
      const k = await key("net1/k1");
      const env = baseEnvelope({ type, payload: { mode: type } });
      const sealed = await sealPayload(env, "net1", k);
      expect(isSealedPayload(sealed)).toBe(true);
      const opened = await openPayload(
        sealed,
        new NetworkKeyring([{ net: "net1", keys: [k] }]),
      );
      expect(opened.payload).toEqual(env.payload);
    },
  );
});

describe("sealed-envelope shape + cleartext metadata", () => {
  test("marks via extensions.enc { alg, net, kid } and ciphertext+nonce in payload", async () => {
    const k = await key("net1/epoch-2026-06");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    expect(readMarker(sealed)).toEqual({
      alg: PAYLOAD_ENC_ALG,
      net: "net1",
      kid: "net1/epoch-2026-06",
    });
    expect(typeof sealed.payload.ciphertext).toBe("string");
    expect(typeof sealed.payload.nonce).toBe("string");
  });

  test("the cleartext plaintext does NOT survive in the sealed envelope", async () => {
    const k = await key("net1/k1");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    expect(JSON.stringify(sealed)).not.toContain("do-not-leak");
  });

  test("routing/trust metadata stays cleartext + unchanged", async () => {
    const k = await key("net1/k1");
    const env = baseEnvelope({
      correlation_id: "22222222-2222-4222-8222-222222222222",
      target_assistant: "did:mf:sage",
      distribution_mode: "direct",
      originator: { principal: "did:mf:andreas" } as never,
    });
    const sealed = await sealPayload(env, "net1", k);
    expect(sealed.id).toBe(env.id);
    expect(sealed.source).toBe(env.source);
    expect(sealed.type).toBe(env.type);
    expect(sealed.timestamp).toBe(env.timestamp);
    expect(sealed.sovereignty).toEqual(env.sovereignty);
    expect(sealed.correlation_id).toBe(env.correlation_id);
    expect((sealed as unknown as Record<string, unknown>).target_assistant).toBe("did:mf:sage");
    expect((sealed as unknown as Record<string, unknown>).distribution_mode).toBe("direct");
  });

  test("preserves pre-existing extensions alongside enc, and strips enc on open", async () => {
    const k = await key("net1/k1");
    const env = baseEnvelope({ extensions: { trace: "abc" } });
    const sealed = await sealPayload(env, "net1", k);
    expect(sealed.extensions).toMatchObject({ trace: "abc" });
    expect((sealed.extensions!).enc).toBeDefined();
    const opened = await openPayload(
      sealed,
      new NetworkKeyring([{ net: "net1", keys: [k] }]),
    );
    expect(opened.extensions).toEqual({ trace: "abc" });
  });

  test("a clean (no prior extensions) seal→open drops extensions entirely", async () => {
    const k = await key("net1/k1");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    const opened = await openPayload(
      sealed,
      new NetworkKeyring([{ net: "net1", keys: [k] }]),
    );
    expect(opened.extensions).toBeUndefined();
  });

  test("seal is idempotent — double-seal returns the already-sealed envelope", async () => {
    const k = await key("net1/k1");
    const once = await sealPayload(baseEnvelope(), "net1", k);
    const twice = await sealPayload(once, "net1", k);
    expect(twice).toBe(once);
  });
});

describe("isSealedPayload", () => {
  test("false for a cleartext envelope, true for a sealed one", async () => {
    const k = await key("net1/k1");
    const env = baseEnvelope();
    expect(isSealedPayload(env)).toBe(false);
    expect(isSealedPayload(await sealPayload(env, "net1", k))).toBe(true);
  });

  test("false for a malformed enc marker (wrong alg)", () => {
    const env = baseEnvelope({ extensions: { enc: { alg: "rot13", net: "n", kid: "k" } } });
    expect(isSealedPayload(env)).toBe(false);
  });
});

describe("fail-closed: wrong key, tamper, header-lift", () => {
  test("wrong network key → open throws", async () => {
    const sealed = await sealPayload(baseEnvelope(), "net1", await key("net1/k1"));
    const wrong = await key("net1/k1"); // same kid, different bytes
    const keyring = new NetworkKeyring([{ net: "net1", keys: [wrong] }]);
    await expect(openPayload(sealed, keyring)).rejects.toThrow(/failed to open/);
  });

  test("tampered ciphertext → open throws", async () => {
    const k = await key("net1/k1");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    await sodium.ready;
    const ct = sodium.from_base64(sealed.payload.ciphertext as string, sodium.base64_variants.ORIGINAL);
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    const tampered: Envelope = {
      ...sealed,
      payload: { ...sealed.payload, ciphertext: sodium.to_base64(ct, sodium.base64_variants.ORIGINAL) },
    };
    await expect(
      openPayload(tampered, new NetworkKeyring([{ net: "net1", keys: [k] }])),
    ).rejects.toThrow(/failed to open/);
  });

  test("AAD lift: ciphertext moved onto a different header (id) → open fails", async () => {
    const k = await key("net1/k1");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    const lifted: Envelope = { ...sealed, id: "99999999-9999-4999-8999-999999999999" };
    await expect(
      openPayload(lifted, new NetworkKeyring([{ net: "net1", keys: [k] }])),
    ).rejects.toThrow(/failed to open/);
  });

  test("AAD lift: ciphertext moved onto a different classification → open fails", async () => {
    const k = await key("net1/k1");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    const lifted: Envelope = {
      ...sealed,
      sovereignty: { ...sealed.sovereignty, classification: "public" },
    };
    await expect(
      openPayload(lifted, new NetworkKeyring([{ net: "net1", keys: [k] }])),
    ).rejects.toThrow(/failed to open/);
  });

  test("AAD lift: ciphertext moved onto a different type → open fails", async () => {
    const k = await key("net1/k1");
    const sealed = await sealPayload(baseEnvelope(), "net1", k);
    const lifted: Envelope = { ...sealed, type: "dispatch.task.delegated" };
    await expect(
      openPayload(lifted, new NetworkKeyring([{ net: "net1", keys: [k] }])),
    ).rejects.toThrow(/failed to open/);
  });
});

describe("keyring: kid select + grace window + missing key", () => {
  test("missing network key → NetworkKeyUnavailableError", async () => {
    const sealed = await sealPayload(baseEnvelope(), "net1", await key("net1/k1"));
    const empty = new NetworkKeyring([]);
    await expect(openPayload(sealed, empty)).rejects.toBeInstanceOf(NetworkKeyUnavailableError);
  });

  test("wrong kid present but no match → NetworkKeyUnavailableError (fail closed)", async () => {
    const sealed = await sealPayload(baseEnvelope(), "net1", await key("net1/k1"));
    const otherEpoch = await key("net1/k2");
    const keyring = new NetworkKeyring([{ net: "net1", keys: [otherEpoch] }]);
    await expect(openPayload(sealed, keyring)).rejects.toBeInstanceOf(NetworkKeyUnavailableError);
  });

  test("grace window: previous key still opens an envelope sealed before rotation", async () => {
    const kOld = await key("net1/k1");
    const kNew = await key("net1/k2");
    // Sealed with the OLD key (in-flight before rotation).
    const sealedOld = await sealPayload(baseEnvelope(), "net1", kOld);
    // Member rotated: current = kNew, grace-retained previous = kOld.
    const keyring = new NetworkKeyring([{ net: "net1", keys: [kNew, kOld] }]);
    const opened = await openPayload(sealedOld, keyring);
    expect(opened.payload).toEqual(baseEnvelope().payload);
    // And `current()` is the new sealing key.
    expect(keyring.current("net1")?.kid).toBe("net1/k2");
  });

  test("resolve returns undefined for unknown network / unknown kid", () => {
    const keyring = new NetworkKeyring([
      { net: "net1", keys: [{ kid: "net1/k1", key: new Uint8Array(32) }] },
    ]);
    expect(keyring.resolve("net1", "net1/k1")?.kid).toBe("net1/k1");
    expect(keyring.resolve("net1", "nope")).toBeUndefined();
    expect(keyring.resolve("other", "net1/k1")).toBeUndefined();
    expect(keyring.has("net1")).toBe(true);
    expect(keyring.has("other")).toBe(false);
  });
});
