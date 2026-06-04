/**
 * F-3b (cortex#659): MyelinRuntime LinkPool tests.
 *
 * The runtime backs EVERY publish/subscribe, so the back-compat invariant
 * is load-bearing: with ZERO per-network `nats:` configured, the pool has
 * ONLY the primary link and behaviour is byte-identical to the pre-F-3b
 * single-link runtime. These tests cover the design (`docs/design-multi-
 * network.md` §7) matrix:
 *
 *   (a) zero networks → single primary link, publishes route to primary
 *       (back-compat proof).
 *   (b) a `federated.{net}.*` publish routes to that net's leaf link
 *       (per-link publish capture).
 *   (c) `local.*` / `public.*` always → primary even with leaves present.
 *   (d) `federated.{unknown}.*` → routing error + NO publish.
 *   (e) per-link dedupe (the cortex#491 `boundByPattern` is per-link).
 *   (+) negative leakage (§5 cardinal): `federated.{B}.*` never on link A.
 *   (+) `stop()` drains + closes ALL pool links.
 *
 * Uses the `MyelinRuntimeOptions.connectImpl` fake-link seam — no real
 * `nats-server`. A PER-URL fake registry lets each test assert WHICH link
 * saw WHICH publish: `connectImpl` receives `ConnectionOptions.servers[0]`
 * (the url), so the fake routes by url to a distinct recording connection.
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
import { startMyelinRuntime, type RoutingError } from "../runtime";

function makeConfig(natsBlock: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "luna", displayName: "Luna" },
    nats: natsBlock,
  } as unknown as AgentConfig;
}

/** One fake NATS connection that records its own publishes + subscribes. */
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
    let iteratorResolve: (() => void) | null = null;
    const iteratorDone = new Promise<void>((r) => {
      iteratorResolve = r;
    });
    // eslint-disable-next-line require-yield
    const iterator = (async function* () {
      await iteratorDone;
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => {
        iteratorResolve?.();
      }),
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
  return { nc, subscribe, subscribePatterns, publishes, publish, drain };
}

/**
 * A per-URL fake registry. `connectImpl` branches on the connect url so
 * each physical link gets its own recording connection — the test then
 * asserts which url (i.e. which link) saw which publish.
 */
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
  return {
    connectImpl,
    /** Fetch the recording connection for a url (created on connect). */
    forUrl: (url: string) => byUrl.get(url),
    byUrl,
  };
}

const PRIMARY_URL = "nats://localhost:4222";
const RESEARCH_URL = "nats://research:4222";
const JV_URL = "nats://jv:4222";

/** Minimal valid `PolicyFederatedNetwork` fixture. */
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

/** Federated envelope whose derived subject we control via an explicit publishOnSubject. */
function makeEnvelope(
  overrides: Partial<{ id: string; type: string; classification: string }> = {},
) {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    source: "metafactory.grove.local",
    type: overrides.type ?? "system.adapter.degraded",
    timestamp: "2026-06-04T12:00:00.000Z",
    sovereignty: {
      classification: (overrides.classification ?? "local") as
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

describe("MyelinRuntime LinkPool (F-3b, cortex#659)", () => {
  let logs: { kind: "log" | "info" | "warn" | "error"; msg: string }[];
  let restore: () => void;

  beforeEach(() => {
    logs = [];
    const o = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
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

  // (a) BACK-COMPAT PROOF — zero per-network nats: ⇒ single primary link,
  //     all publishes route to it, byte-identical to today.
  test("(a) back-compat: zero federated networks ⇒ single primary link; all publishes route to primary", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: ["local.{principal}.>"] }),
      { connectImpl: reg.connectImpl, stack: "default" },
      // NB: federatedNetworks omitted entirely.
    );
    expect(runtime.enabled).toBe(true);
    // Exactly ONE physical link was opened.
    expect(reg.byUrl.size).toBe(1);
    const primary = reg.forUrl(PRIMARY_URL)!;
    expect(primary).toBeDefined();

    // local.* publish → primary, with the SAME subject the pre-F-3b runtime
    // produced (`local.{principal-from-source}.{stack}.{type}`).
    await runtime.publish(makeEnvelope({ type: "system.adapter.degraded" }));
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.default.system.adapter.degraded",
    ]);

    // A federated envelope with NO leaf in the pool still rides primary —
    // byte-identical to the single-link runtime (no routing error, no skip)
    // because the primary-only pool has no separate federated routing.
    await runtime.publish(
      makeEnvelope({ classification: "federated", type: "system.adapter.degraded" }),
    );
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.default.system.adapter.degraded",
      "federated.metafactory.default.system.adapter.degraded",
    ]);
    // No routing error was logged in the back-compat case.
    expect(logs.some((l) => l.msg.includes("unknown_network_in_publish_subject"))).toBe(false);

    await runtime.stop();
  });

  // (b) federated.{net}.* routes to that net's leaf link.
  test("(b) federated.{net}.* publish routes to that network's leaf link", async () => {
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
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    expect(runtime.enabled).toBe(true);
    // Two physical links: primary + the research leaf.
    expect(reg.byUrl.size).toBe(2);
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.research-collab.system.adapter.degraded",
    );
    // Landed on the research leaf ONLY.
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.research-collab.system.adapter.degraded",
    ]);
    expect(primary.publishes).toEqual([]);

    await runtime.stop();
  });

  // (c) local.* / public.* always → primary even with leaves present.
  test("(c) local.* and public.* always route to primary even with leaf links present", async () => {
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
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    await runtime.publishOnSubject!(makeEnvelope(), "local.metafactory.system.x");
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "public" }),
      "public.system.x",
    );
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.system.x",
      "public.system.x",
    ]);
    // The leaf saw NONE of it.
    expect(research.publishes).toEqual([]);

    await runtime.stop();
  });

  // (d) federated.{unknown}.* → routing error + NO publish.
  test("(d) federated.{unknown}.* emits routing error and does NOT publish (skip)", async () => {
    const reg = makeFakeRegistry();
    const routingErrors: RoutingError[] = [];
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
        onRoutingError: (info) => routingErrors.push(info),
      },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", id: "deadbeef-id" }),
      "federated.no-such-net.system.x",
    );

    // Routing error fired with the canonical reason; NOTHING published.
    expect(routingErrors).toEqual([
      {
        reason: "unknown_network_in_publish_subject",
        subject: "federated.no-such-net.system.x",
        networkId: "no-such-net",
        envelopeId: "deadbeef-id",
      },
    ]);
    expect(primary.publishes).toEqual([]);
    expect(research.publishes).toEqual([]);

    await runtime.stop();
  });

  // (+) NEGATIVE LEAKAGE (§5 cardinal): federated.{B}.* never on link A.
  test("(+) negative leakage: a federated.{jv}.* publish never appears on the research leaf", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv",
        leaf_node: "nats-leaf-jv",
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    expect(reg.byUrl.size).toBe(3); // primary + research + jv
    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;

    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.jv.system.x",
    );
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.research-collab.system.y",
    );

    // jv traffic hit jv only; research traffic hit research only.
    expect(jv.publishes.map((p) => p.subject)).toEqual(["federated.jv.system.x"]);
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.research-collab.system.y",
    ]);
    // CARDINAL: jv's subject never leaked onto the research leaf's wire.
    expect(research.publishes.some((p) => p.subject.startsWith("federated.jv."))).toBe(false);

    await runtime.stop();
  });

  // (+) two networks SHARING a leaf_node ⇒ ONE physical link (de-dup key).
  test("(+) two networks sharing a leaf_node share one physical leaf link", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "shared-leaf",
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "research-collab-2",
        leaf_node: "shared-leaf",
        // Second declaration omits nats: (rides the first's link) — the
        // F-3a cross-validator guarantees consistency.
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    // primary + ONE shared leaf = 2 links (not 3).
    expect(reg.byUrl.size).toBe(2);
    const shared = reg.forUrl(RESEARCH_URL)!;

    // Both network ids route to the SAME leaf.
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.research-collab.system.a",
    );
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.research-collab-2.system.b",
    );
    expect(shared.publishes.map((p) => p.subject)).toEqual([
      "federated.research-collab.system.a",
      "federated.research-collab-2.system.b",
    ]);

    await runtime.stop();
  });

  // (e) per-link dedupe — the cortex#491 boundByPattern is per-link
  //     (primary-bound in F-3b). A duplicate self-subscribe to a pattern a
  //     boot subscriber already bound returns the SAME subscriber.
  test("(e) per-link dedupe: duplicate primary subscribe returns the existing subscriber (no double-bind)", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({
        url: PRIMARY_URL,
        name: "cortex",
        subjects: ["local.metafactory.system.>"],
      }),
      { connectImpl: reg.connectImpl },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    // Boot subscribed once.
    expect(primary.subscribePatterns).toEqual(["local.metafactory.system.>"]);

    // Self-subscribe the SAME resolved pattern — must NOT create a second
    // NATS subscription (dedupe via the primary link's boundByPattern).
    const sub = await runtime.subscribe!("local.metafactory.system.>");
    expect(sub).not.toBeNull();
    expect(primary.subscribePatterns).toEqual(["local.metafactory.system.>"]);
    expect(
      logs.some((l) => l.msg.includes("skipping duplicate subscribe")),
    ).toBe(true);

    await runtime.stop();
  });

  // (+) stop() drains + closes ALL pool links.
  test("(+) stop() drains and closes every pool link", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv",
        leaf_node: "nats-leaf-jv",
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;

    await runtime.stop();

    // Each link's underlying connection was drained on close().
    expect(primary.drain).toHaveBeenCalled();
    expect(research.drain).toHaveBeenCalled();
    expect(jv.drain).toHaveBeenCalled();
  });

  // (+) a leaf that fails to connect at boot does NOT take the runtime down
  //     (degrade-don't-crash seam — full lifecycle is F-3c). Its network's
  //     publishes then resolve to the unknown-network skip.
  test("(+) leaf connect failure degrades (runtime stays enabled on primary); that network's publishes skip", async () => {
    const routingErrors: RoutingError[] = [];
    // A registry whose JV url throws on connect, but primary + research succeed.
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === JV_URL) throw new Error("leaf down");
      let conn = byUrl.get(url);
      if (!conn) {
        conn = makeFakeConn();
        byUrl.set(url, conn);
      }
      return conn.nc;
    };
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv",
        leaf_node: "nats-leaf-jv",
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl, federatedNetworks: networks, onRoutingError: (i) => routingErrors.push(i) },
    );
    // Primary up ⇒ runtime enabled despite the dead jv leaf.
    expect(runtime.enabled).toBe(true);
    expect(logs.some((l) => l.kind === "error" && l.msg.includes("nats-leaf-jv"))).toBe(true);

    const research = byUrl.get(RESEARCH_URL)!;
    // research traffic still routes fine.
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.research-collab.system.a",
    );
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.research-collab.system.a",
    ]);
    // jv traffic skips (its leaf never made it into the pool).
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.jv.system.b",
    );
    expect(routingErrors.map((e) => e.networkId)).toEqual(["jv"]);

    await runtime.stop();
  });
});
