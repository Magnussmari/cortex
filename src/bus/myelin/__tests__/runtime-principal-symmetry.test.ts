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
// IAW Phase F-3d (cortex#666) — per-link {network_id} symmetry (design §7.8).
// =============================================================================
//
// For each federated leaf link the SUBSCRIBE pattern is `federated.{network_id}.>`
// (the inbound-attribution per-leaf subscription) and the PUBLISH routing keys
// off the same `{network_id}` segment (subject[1]) in `selectLink`. The
// invariant: subscribe-`{network_id}` === publish-`{network_id}` per leaf, so a
// federated round-trip lands on (and is attributed to) the SAME link both ways.

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

describe("MyelinRuntime — per-link {network_id} symmetry (F-3d, cortex#666 §7.8)", () => {
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

  test("subscribe-{network_id} === publish-{network_id} per leaf link", async () => {
    const reg = makeFakeRegistry();
    const RESEARCH_URL = "nats://research:4222";
    const JV_URL = "nats://jv:4222";
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv-collab",
        leaf_node: "nats-leaf-jv",
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: "nats://localhost:4222", name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    expect(runtime.enabled).toBe(true);

    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;

    // SUBSCRIBE side: each leaf subscribes to its OWN network's segment.
    expect(research.subscribePatterns).toEqual(["federated.research-collab.>"]);
    expect(jv.subscribePatterns).toEqual(["federated.jv-collab.>"]);

    // PUBLISH side: a `federated.{network_id}.…` publish routes to the SAME
    // leaf whose subscribe pattern carries that `{network_id}` — and ONLY that
    // leaf (no cross-network leakage).
    await runtime.publishOnSubject!(
      makeEnvelope(),
      "federated.research-collab.system.adapter.degraded",
    );
    await runtime.publishOnSubject!(
      makeEnvelope(),
      "federated.jv-collab.system.adapter.degraded",
    );
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.research-collab.system.adapter.degraded",
    ]);
    expect(jv.publishes.map((p) => p.subject)).toEqual([
      "federated.jv-collab.system.adapter.degraded",
    ]);

    await runtime.stop();
  });
});
