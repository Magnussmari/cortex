/**
 * F-3d (cortex#666): MyelinRuntime inbound `sourceLink` attribution tests.
 *
 * F-3d threads WHICH pool link (and therefore which federation network)
 * delivered an inbound envelope through to the runtime's `onEnvelope`
 * handlers as an additive trailing `sourceLink` arg. The design
 * (`docs/design-multi-network.md` §3.3 / §7 row 7) requires:
 *
 *   (a) inbound on a LEAF link  → handler receives sourceLink = that leaf_node;
 *   (b) inbound on the PRIMARY  → handler receives sourceLink = "primary";
 *   (c) single-link deployment  → unchanged: a 2-arg `(env, subject)` handler
 *       still works (the third arg is optional + trailing);
 *   (d) ADR 0001 (supersedes cortex#661): leaf-delivered federated traffic fans
 *       out tagged with the delivering leaf's `sourceLink`. The network is no
 *       longer on the wire (subjects carry `federated.{principal}.{stack}.…`),
 *       so the cortex#661 network→leaf anti-spoof drop is retired; the
 *       cross-principal TRUST decision (was the SENDER a legitimate peer on a
 *       network owning this leaf?) is the verify layer's job (TC-2d, keyed off
 *       `sourceLink`), not the runtime's.
 *
 * Unlike `runtime-linkpool.test.ts` (publish routing — its fake subscribe
 * blocks forever), this file uses a DELIVERABLE fake connection whose
 * subscription async-iterator can be fed a message, so we can drive inbound
 * delivery on a specific link and assert the attribution the handler sees.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ConnectionOptions,
  NatsConnection,
  Status,
  Subscription,
} from "nats";
import type { AgentConfig } from "../../../common/types/config";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import { startMyelinRuntime } from "../runtime";

function makeConfig(natsBlock: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "luna", displayName: "Luna" },
    nats: natsBlock,
  } as unknown as AgentConfig;
}

/**
 * A fake NATS connection whose subscriptions can be FED inbound messages.
 * `deliver(pattern, subject, payload)` pushes a `{ subject, data }` message
 * into the matching subscription's async-iterator queue, which the
 * NatsSubscription consume loop picks up exactly as a real broker delivery.
 */
function makeDeliverableConn() {
  const subscribePatterns: string[] = [];
  const publishes: { subject: string; payload: string | Uint8Array }[] = [];

  // Per-pattern message queues + waiters so we can deliver after the consume
  // loop has started awaiting.
  interface SubChannel {
    queue: { subject: string; data: Uint8Array }[];
    waiter: ((m: { subject: string; data: Uint8Array } | null) => void) | null;
    closed: boolean;
  }
  const channels = new Map<string, SubChannel>();

  // Status stream that ENDS on drain() (mirrors runtime-linkpool's fake) so
  // NatsLink.close()'s status-loop join resolves promptly instead of waiting
  // out the 2s watchdog.
  const statusListeners = new Set<(s: Status | null) => void>();
  const status = () =>
    (async function* () {
      const queue: (Status | null)[] = [];
      let waiter: ((s: Status | null) => void) | null = null;
      const listener = (s: Status | null) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(s);
        } else {
          queue.push(s);
        }
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
    const chan: SubChannel = { queue: [], waiter: null, closed: false };
    channels.set(pattern, chan);
    const iterator = (async function* () {
      while (true) {
        if (chan.queue.length > 0) {
          const next = chan.queue.shift()!;
          yield next;
          continue;
        }
        if (chan.closed) return;
        const next = await new Promise<{ subject: string; data: Uint8Array } | null>(
          (r) => (chan.waiter = r),
        );
        if (next === null) return;
        yield next;
      }
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => {
        chan.closed = true;
        chan.waiter?.(null);
      }),
      closed: Promise.resolve(),
    } as unknown as Subscription;
  });

  const drain = mock(async () => {
    for (const chan of channels.values()) {
      chan.closed = true;
      chan.waiter?.(null);
    }
    // End the status stream so the link's status-loop join resolves.
    for (const l of statusListeners) l(null);
  });

  const publish = mock((subject: string, payload: string | Uint8Array) => {
    publishes.push({ subject, payload });
  });

  const nc = { status, subscribe, drain, publish } as unknown as NatsConnection;

  /** Push one inbound message into the subscription bound to `pattern`. */
  const deliver = (pattern: string, subject: string, payloadObj: unknown) => {
    const chan = channels.get(pattern);
    if (!chan) throw new Error(`no subscription bound to pattern "${pattern}"`);
    const data = new TextEncoder().encode(JSON.stringify(payloadObj));
    const msg = { subject, data };
    if (chan.waiter) {
      const w = chan.waiter;
      chan.waiter = null;
      w(msg);
    } else {
      chan.queue.push(msg);
    }
  };

  return { nc, subscribe, subscribePatterns, publishes, deliver };
}

/** Per-URL deliverable fake registry — mirrors runtime-linkpool's shape. */
function makeFakeRegistry() {
  const byUrl = new Map<string, ReturnType<typeof makeDeliverableConn>>();
  const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
    const url = (opts.servers as string[])[0] ?? "<no-url>";
    let conn = byUrl.get(url);
    if (!conn) {
      conn = makeDeliverableConn();
      byUrl.set(url, conn);
    }
    return conn.nc;
  };
  return { connectImpl, forUrl: (url: string) => byUrl.get(url), byUrl };
}

const PRIMARY_URL = "nats://localhost:4222";
const RESEARCH_URL = "nats://research:4222";
const JV_URL = "nats://jv:4222";

function makeNetwork(
  overrides: Partial<PolicyFederatedNetwork>,
): PolicyFederatedNetwork {
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

/** A schema-valid envelope object (what the wire carries; validated on delivery). */
function makeEnvelope(
  overrides: Partial<{ id: string; type: string; classification: string }> = {},
) {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    source: "metafactory.grove.local",
    type: overrides.type ?? "system.adapter.degraded",
    timestamp: "2026-06-04T12:00:00.000Z",
    sovereignty: {
      classification: (overrides.classification ?? "federated") as
        | "local"
        | "federated"
        | "public",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any" as const,
    },
    payload: { adapter_id: "discord-luna" },
  };
}

describe("MyelinRuntime inbound sourceLink attribution (F-3d, cortex#666)", () => {
  let logs: { kind: "log" | "info" | "warn" | "error"; msg: string }[];
  let restore: () => void;

  beforeEach(() => {
    logs = [];
    const o = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => logs.push({ kind: "log", msg: a.map(String).join(" ") });
    console.info = (...a: unknown[]) => logs.push({ kind: "info", msg: a.map(String).join(" ") });
    console.warn = (...a: unknown[]) => logs.push({ kind: "warn", msg: a.map(String).join(" ") });
    console.error = (...a: unknown[]) => logs.push({ kind: "error", msg: a.map(String).join(" ") });
    restore = () => {
      console.log = o.log;
      console.info = o.info;
      console.warn = o.warn;
      console.error = o.error;
    };
  });
  afterEach(() => restore());

  // (a) Inbound on a LEAF link → sourceLink = that leaf's leaf_node.
  //     ADR 0001: the leaf subscribes to THIS stack's own identity,
  //     `federated.{my-principal}.{my-stack}.>` (not the per-network segment).
  test("(a) inbound on a leaf link tags sourceLink = the leaf's leaf_node", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl: reg.connectImpl,
        federatedNetworks: networks,
        principal: "metafactory",
        stack: "default",
      },
    );
    expect(runtime.enabled).toBe(true);

    const seen: { subject: string; sourceLink?: string }[] = [];
    runtime.onEnvelope((_env, subject, sourceLink) => {
      seen.push({ subject, sourceLink });
    });

    const research = reg.forUrl(RESEARCH_URL)!;
    // ADR 0001 — the leaf subscribes to traffic addressed to THIS stack:
    // `federated.{my-principal}.{my-stack}.>`.
    expect(research.subscribePatterns).toContain("federated.metafactory.default.>");

    research.deliver(
      "federated.metafactory.default.>",
      "federated.metafactory.default.system.adapter.degraded",
      makeEnvelope(),
    );
    // Let the async consume loop + validate + fan-out settle.
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual([
      {
        subject: "federated.metafactory.default.system.adapter.degraded",
        sourceLink: "nats-leaf-research",
      },
    ]);

    await runtime.stop();
  });

  // (b) Inbound on the PRIMARY link → sourceLink = "primary".
  test("(b) inbound on the primary link tags sourceLink = \"primary\"", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({
        url: PRIMARY_URL,
        name: "cortex",
        subjects: ["local.{principal}.>"],
      }),
      { connectImpl: reg.connectImpl, principal: "metafactory" },
    );
    expect(runtime.enabled).toBe(true);

    const seen: { subject: string; sourceLink?: string }[] = [];
    runtime.onEnvelope((_env, subject, sourceLink) => {
      seen.push({ subject, sourceLink });
    });

    const primary = reg.forUrl(PRIMARY_URL)!;
    // Primary subscribed to the resolved `local.metafactory.>` pattern.
    expect(primary.subscribePatterns).toContain("local.metafactory.>");

    primary.deliver(
      "local.metafactory.>",
      "local.metafactory.system.adapter.degraded",
      makeEnvelope({ classification: "local" }),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual([
      {
        subject: "local.metafactory.system.adapter.degraded",
        sourceLink: "primary",
      },
    ]);

    await runtime.stop();
  });

  // (c) Single-link deployment → an existing 2-arg handler still works.
  test("(c) single-link: a legacy (env, subject) 2-arg handler keeps working", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({
        url: PRIMARY_URL,
        name: "cortex",
        subjects: ["local.{principal}.>"],
      }),
      { connectImpl: reg.connectImpl, principal: "metafactory" },
      // NB: federatedNetworks omitted — pure single-link deployment.
    );
    expect(runtime.enabled).toBe(true);
    // Exactly one physical link — the primary.
    expect(reg.byUrl.size).toBe(1);

    // A handler with the OLD 2-arg shape. The optional trailing `sourceLink`
    // is invisible to it — it never reads a third arg. TypeScript accepts the
    // narrower 2-arg function where the 3-arg `EnvelopeHandler` is expected
    // (parameter bivariance on the extra trailing param) — that IS the
    // back-compat guarantee under test, so no cast is needed.
    const seen: { subject: string }[] = [];
    runtime.onEnvelope((_env, subject) => {
      seen.push({ subject });
    });

    const primary = reg.forUrl(PRIMARY_URL)!;
    primary.deliver(
      "local.metafactory.>",
      "local.metafactory.system.adapter.degraded",
      makeEnvelope({ classification: "local" }),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual([{ subject: "local.metafactory.system.adapter.degraded" }]);

    await runtime.stop();
  });

  // (d) ADR 0001 (supersedes cortex#661) — leaf-delivered federated traffic
  //     fans out tagged with the DELIVERING leaf's sourceLink. The network is no
  //     longer on the wire, so the cortex#661 network→leaf "spoof drop" is
  //     retired: every leaf subscribes to THIS stack's own identity
  //     (`federated.{my-principal}.{my-stack}.>`), and the cross-principal TRUST
  //     decision (was the SENDER a legitimate peer on a network owning this
  //     leaf?) belongs to the verify layer (TC-2d, keyed off `sourceLink`), NOT
  //     the runtime. This test pins that the runtime attributes (never drops)
  //     leaf-delivered federated traffic and tags the correct leaf.
  test("(d) ADR 0001: leaf-delivered federated traffic fans out tagged with the delivering leaf's sourceLink (no network-spoof drop)", async () => {
    const reg = makeFakeRegistry();
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
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl: reg.connectImpl,
        federatedNetworks: networks,
        principal: "metafactory",
        stack: "default",
      },
    );
    expect(runtime.enabled).toBe(true);

    const seen: { subject: string; sourceLink?: string }[] = [];
    runtime.onEnvelope((_env, subject, sourceLink) => {
      seen.push({ subject, sourceLink });
    });

    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;
    // Both leaves carry the SAME inbound interest — this stack's own identity.
    expect(research.subscribePatterns).toContain("federated.metafactory.default.>");
    expect(jv.subscribePatterns).toContain("federated.metafactory.default.>");

    // Deliver the SAME stack-addressed subject on each leaf. Each fans out with
    // the DELIVERING leaf's sourceLink — the attribution TC-2d keys its
    // per-network peer-pubkey lookup off. No drop.
    research.deliver(
      "federated.metafactory.default.>",
      "federated.metafactory.default.system.adapter.degraded",
      makeEnvelope(),
    );
    jv.deliver(
      "federated.metafactory.default.>",
      "federated.metafactory.default.system.adapter.degraded",
      makeEnvelope(),
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(seen).toEqual([
      {
        subject: "federated.metafactory.default.system.adapter.degraded",
        sourceLink: "nats-leaf-research",
      },
      {
        subject: "federated.metafactory.default.system.adapter.degraded",
        sourceLink: "nats-leaf-jv",
      },
    ]);
    // No spoof-drop logging under ADR 0001.
    expect(logs.some((l) => l.msg.includes("DROPPING spoofed envelope"))).toBe(false);

    await runtime.stop();
  });
});
