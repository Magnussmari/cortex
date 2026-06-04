/**
 * IAW Phase A.3 follow-up (cortex#130 item 1) — pin the subscribe/publish
 * `{principal}` symmetry invariant.
 *
 * Subscribe-side substitutes `{principal}` in NATS subject patterns from
 * the boot-resolved `principal.id` at startup via `principalFromConfig`
 * (cortex#429 PR-C — flows in via `MyelinRuntimeOptions.principal`).
 * Publish-side extracts `{principal}` from `envelope.source`'s first
 * segment via `principalFromEnvelope`. For any envelope this stack emits
 * via the system-event helpers (which build `source` as
 * `${principal}.${assistant}.${instance}`), the two MUST return identical
 * strings — otherwise publish/subscribe subjects diverge and round-trips
 * break.
 */
import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import type {
  ConnectionOptions,
  NatsConnection,
  Status,
  Subscription,
} from "nats";

import {
  principalFromConfig,
  principalFromEnvelope,
} from "../envelope-validator";
import { createSystemAdapterDegradedEvent } from "../../system-events";
import { startMyelinRuntime } from "../runtime";
import type { AgentConfig } from "../../../common/types/config";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";

describe("MyelinRuntime — subscribe/publish {principal} symmetry (cortex#130 item 1)", () => {
  test("principalFromConfig and principalFromEnvelope agree for stack-emitted envelopes", () => {
    const principalId = "metafactory";
    const envelope = createSystemAdapterDegradedEvent({
      source: { principal: principalId, agent: "cortex", instance: "local" },
      adapterId: "discord-1",
      platform: "discord",
      disconnectedSince: new Date("2026-05-16T10:00:00.000Z"),
      thresholdMs: 60_000,
    });

    expect(principalFromConfig(principalId)).toBe(principalFromEnvelope(envelope));
  });

  test("principalFromConfig falls back to 'default' when principalId is undefined", () => {
    expect(principalFromConfig(undefined)).toBe("default");
  });

  test("principalFromEnvelope extracts the first dotted segment", () => {
    const envelope = createSystemAdapterDegradedEvent({
      source: { principal: "andreas", agent: "luna", instance: "work" },
      adapterId: "slack-1",
      platform: "slack",
      disconnectedSince: new Date("2026-05-16T10:00:00.000Z"),
      thresholdMs: 60_000,
    });

    expect(principalFromEnvelope(envelope)).toBe("andreas");
    // Sanity: the envelope.source itself has the full multi-segment form.
    expect(envelope.source).toBe("andreas.luna.work");
  });

  test("symmetry holds when principal changes — second stack identity", () => {
    const principalId = "the-metafactory";
    const envelope = createSystemAdapterDegradedEvent({
      source: { principal: principalId, agent: "echo", instance: "local" },
      adapterId: "discord-1",
      platform: "discord",
      disconnectedSince: new Date("2026-05-16T10:00:00.000Z"),
      thresholdMs: 60_000,
    });

    expect(principalFromConfig(principalId)).toBe(principalFromEnvelope(envelope));
    expect(principalFromEnvelope(envelope)).toBe("the-metafactory");
  });
});

// =============================================================================
// IAW Phase F-3d (cortex#666) — per-leaf inbound subscription, ADR 0001 grammar.
// =============================================================================
//
// ADR 0001 (supersedes cortex#661): the network is NEVER on the wire. Each
// federated leaf link subscribes to the traffic addressed to THIS stack —
// `federated.{my-principal}.{my-stack}.>` (the receiving stack's own identity,
// the SAME grammar as the `local.*` subscribe patterns), NOT the per-network
// `federated.{network_id}.>` of cortex#661. Each distinct leaf carries the same
// inbound interest (the stack's identity), and `sourceLink` attribution records
// which leaf delivered an envelope so the verify layer (TC-2d) can do its
// per-network peer-pubkey lookup.

function makeConfig(natsBlock: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "luna", displayName: "Luna" },
    nats: natsBlock,
  } as unknown as AgentConfig;
}

function makeFakeConn() {
  const statusListeners = new Set<(s: Status | null) => void>();
  const subscribePatterns: string[] = [];
  const publishes: { subject: string; payload: string | Uint8Array }[] = [];
  const status = () =>
    (async function* () {
      const queue: (Status | null)[] = [];
      let waiter: ((s: Status | null) => void) | null = null;
      const listener = (s: Status | null) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(s);
        } else queue.push(s);
      };
      statusListeners.add(listener);
      try {
        while (true) {
          if (queue.length > 0) {
            const next = queue.shift()!;
            if (next === null) return;
            yield next;
            continue;
          }
          const next = await new Promise<Status | null>((r) => (waiter = r));
          if (next === null) return;
          yield next;
        }
      } finally {
        statusListeners.delete(listener);
      }
    })();
  const subscribe = mock((pattern: string) => {
    subscribePatterns.push(pattern);
    let resolve: (() => void) | null = null;
    const done = new Promise<void>((r) => (resolve = r));
    // eslint-disable-next-line require-yield
    const iterator = (async function* () {
      await done;
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => resolve?.()),
      closed: Promise.resolve(),
    } as unknown as Subscription;
  });
  const drain = mock(async () => {
    for (const l of statusListeners) l(null);
  });
  const publish = mock((subject: string, payload: string | Uint8Array) => {
    publishes.push({ subject, payload });
  });
  const nc = { status, subscribe, drain, publish } as unknown as NatsConnection;
  return { nc, subscribePatterns, publishes };
}

function makeFakeRegistry() {
  const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
  const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
    const url = (opts.servers as string[])[0] ?? "<no-url>";
    let conn = byUrl.get(url);
    if (!conn) {
      conn = makeFakeConn();
      byUrl.set(url, conn);
    }
    return conn.nc;
  };
  return { connectImpl, forUrl: (url: string) => byUrl.get(url) };
}

function makeNetwork(overrides: Partial<PolicyFederatedNetwork>): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "nats-leaf-research",
    peers: [],
    accept_subjects: [],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 0,
    ...overrides,
  };
}

function makeEnvelope() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "metafactory.grove.local",
    type: "system.adapter.degraded",
    timestamp: "2026-06-04T12:00:00.000Z",
    sovereignty: {
      classification: "federated" as const,
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any" as const,
    },
    payload: { adapter_id: "discord-luna" },
  };
}

function makePeer(principalId: string): PolicyFederatedNetwork["peers"][number] {
  return {
    principal_id: principalId,
    stack_id: `${principalId}/home`,
    principal_pubkey: "U" + "A".repeat(55),
  };
}

describe("MyelinRuntime — per-leaf inbound subscription + publish routing (F-3d, ADR 0001)", () => {
  let restore: () => void;
  beforeEach(() => {
    const o = { log: console.log, info: console.info, error: console.error };
    console.log = () => {};
    console.info = () => {};
    console.error = () => {};
    restore = () => {
      console.log = o.log;
      console.info = o.info;
      console.error = o.error;
    };
  });
  afterEach(() => restore());

  test("each leaf subscribes to federated.{my-principal}.{my-stack}.> and publish routes by target principal via peers[]", async () => {
    const reg = makeFakeRegistry();
    const RESEARCH_URL = "nats://research:4222";
    const JV_URL = "nats://jv:4222";
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv-collab",
        leaf_node: "nats-leaf-jv",
        peers: [makePeer("partner")],
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      {
        connectImpl: reg.connectImpl,
        federatedNetworks: networks,
        // The receiving stack's own identity — ADR 0001 inbound subscribe key.
        principal: "metafactory",
        stack: "default",
      },
    );
    expect(runtime.enabled).toBe(true);

    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;

    // SUBSCRIBE side (ADR 0001): EVERY leaf subscribes to the SAME inbound
    // interest — federated traffic addressed to THIS stack's own identity,
    // `federated.{my-principal}.{my-stack}.>`. The network is NOT on the wire.
    expect(research.subscribePatterns).toEqual(["federated.metafactory.default.>"]);
    expect(jv.subscribePatterns).toEqual(["federated.metafactory.default.>"]);

    // PUBLISH side: a `federated.{target-principal}.{stack}.…` publish routes to
    // the leaf hosting that target principal (resolved from peers[]) — and ONLY
    // that leaf (no cross-network leakage). jcfischer ⇒ research; partner ⇒ jv.
    await runtime.publishOnSubject!(
      makeEnvelope(),
      "federated.jcfischer.host.system.adapter.degraded",
    );
    await runtime.publishOnSubject!(
      makeEnvelope(),
      "federated.partner.host.system.adapter.degraded",
    );
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.jcfischer.host.system.adapter.degraded",
    ]);
    expect(jv.publishes.map((p) => p.subject)).toEqual([
      "federated.partner.host.system.adapter.degraded",
    ]);

    await runtime.stop();
  });
});
