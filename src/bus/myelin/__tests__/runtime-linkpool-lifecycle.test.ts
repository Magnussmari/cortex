/**
 * F-3c (cortex#662): MyelinRuntime LinkPool degrade-don't-crash lifecycle.
 *
 * F-3b built the pool + subject-routed publish; F-3c adds the RATIFIED
 * (OD-F3-2) degrade-don't-crash lifecycle: a federated leaf that fails to
 * connect at boot must NOT crash cortex — the network goes dark / fails
 * closed, cortex boots normally (`enabled === true`, primary unaffected),
 * and a bounded background reconnect brings the leaf up when it returns,
 * after which routing to that network resumes. `stop()` cancels any pending
 * reconnect timer (no leaked timer / no post-stop reconnect).
 *
 * Test matrix (design §7 + the F-3c acceptance):
 *   (a) leaf unreachable at boot → runtime starts, enabled=true, primary
 *       works, that network's `federated.*` publishes skip (fail-closed).
 *   (b) the down leaf becomes reachable → background reconnect attaches it →
 *       its publishes now route to it.
 *   (c) zero networks → no lifecycle machinery engages; byte-identical to
 *       today (no timer scheduled, no reconnect, single primary link).
 *   (d) stop() cancels a pending reconnect timer — no leaked timer, no
 *       post-stop reconnect (the timer callback is a no-op after stop()).
 *
 * Uses the `MyelinRuntimeOptions.connectImpl` fake-link seam (no real
 * `nats-server`) PLUS the F-3c `reconnectTimer` seam to drive the backoff
 * deterministically: the test captures the scheduled callback and fires it
 * by hand, so reconnect happens without real wall-clock waits.
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

const PRIMARY_URL = "nats://localhost:4222";
const RESEARCH_URL = "nats://research:4222";

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

/**
 * A controllable timer seam. Captures each scheduled `(cb, ms)` so the test
 * can fire it on demand (deterministic backoff) and assert pending/cleared
 * state. Handles are opaque integers; `clearTimer` marks them cancelled so a
 * later `fireNext()` won't run a cleared callback.
 */
function makeControlledTimer() {
  // Object handles (the runtime's `ReconnectTimerHandle` is a non-null
  // object). Each call returns a fresh marker we can key on for clear/fire.
  const pending = new Map<object, { cb: () => void; ms: number }>();
  const setTimer = (cb: () => void, ms: number): object => {
    const handle = {};
    pending.set(handle, { cb, ms });
    return handle;
  };
  const clearTimer = (handle: object): void => {
    pending.delete(handle);
  };
  return {
    seam: { setTimer, clearTimer },
    /** Number of timers currently scheduled (not yet fired or cleared). */
    pendingCount: () => pending.size,
    /** The delay (ms) of the single pending timer, for backoff assertions. */
    onlyPendingMs: () => {
      const vals = [...pending.values()];
      if (vals.length !== 1) {
        throw new Error(`expected exactly 1 pending timer, got ${vals.length}`);
      }
      return vals[0]!.ms;
    },
    /**
     * Fire the oldest pending timer (FIFO) and return a promise that settles
     * after its async work drains. Removes it from `pending` first (mirrors a
     * real one-shot timer).
     */
    fireNext: async (): Promise<void> => {
      const [handle] = pending.keys();
      if (handle === undefined) throw new Error("no pending timer to fire");
      const entry = pending.get(handle)!;
      pending.delete(handle);
      entry.cb();
      // Let the async reconnect attempt (NatsLink.connect → attach) settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe("MyelinRuntime LinkPool lifecycle (F-3c, cortex#662)", () => {
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

  // (a) DEGRADE-DON'T-CRASH: leaf unreachable at boot → runtime starts,
  //     enabled=true, primary works, that network's publishes skip.
  test("(a) leaf unreachable at boot → runtime enabled (primary up); that network's federated publishes skip (fail-closed)", async () => {
    const timer = makeControlledTimer();
    const routingErrors: RoutingError[] = [];
    // primary connects; the research leaf always throws.
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === RESEARCH_URL) throw new Error("leaf down at boot");
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
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl,
        federatedNetworks: networks,
        onRoutingError: (i) => routingErrors.push(i),
        reconnectTimer: timer.seam,
      },
    );

    // Boot did NOT crash: primary up ⇒ runtime enabled.
    expect(runtime.enabled).toBe(true);
    // A background reconnect was scheduled for the down leaf.
    expect(timer.pendingCount()).toBe(1);
    // The boot-degradation log named the dark leaf.
    expect(
      logs.some((l) => l.kind === "error" && l.msg.includes("nats-leaf-research")),
    ).toBe(true);

    const primary = byUrl.get(PRIMARY_URL)!;
    // Primary traffic flows fine.
    await runtime.publishOnSubject!(makeEnvelope(), "local.metafactory.system.x");
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.system.x",
    ]);

    // The down network's federated publish FAILS CLOSED — routing error, no
    // publish anywhere (never leaks onto primary).
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", id: "down-leaf-id" }),
      "federated.research-collab.system.y",
    );
    expect(routingErrors).toEqual([
      {
        reason: "unknown_network_in_publish_subject",
        subject: "federated.research-collab.system.y",
        networkId: "research-collab",
        envelopeId: "down-leaf-id",
      },
    ]);
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.system.x",
    ]);

    await runtime.stop();
  });

  // (b) BACKGROUND RECONNECT: the down leaf becomes reachable → reconnect
  //     attaches it → its publishes now route to it.
  test("(b) down leaf becomes reachable → background reconnect attaches it → its federated publishes route to it", async () => {
    const timer = makeControlledTimer();
    const routingErrors: RoutingError[] = [];
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    // The research leaf fails the FIRST connect, succeeds afterward.
    let researchAttempts = 0;
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === RESEARCH_URL) {
        researchAttempts++;
        if (researchAttempts === 1) throw new Error("leaf down at boot");
      }
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
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl,
        federatedNetworks: networks,
        onRoutingError: (i) => routingErrors.push(i),
        reconnectTimer: timer.seam,
        reconnectBackoff: { initialMs: 5, maxMs: 100, factor: 2 },
      },
    );
    expect(runtime.enabled).toBe(true);
    // First reconnect scheduled at the initial backoff.
    expect(timer.pendingCount()).toBe(1);
    expect(timer.onlyPendingMs()).toBe(5);

    // Fire the scheduled reconnect — the leaf now connects + attaches.
    await timer.fireNext();
    expect(researchAttempts).toBe(2); // boot attempt + 1 reconnect.
    expect(timer.pendingCount()).toBe(0); // success ⇒ no further retry scheduled.
    expect(
      logs.some((l) => l.msg.includes('leaf "nats-leaf-research" reconnected')),
    ).toBe(true);

    // The leaf is now in the pool — its federated publishes route to it.
    const research = byUrl.get(RESEARCH_URL)!;
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated" }),
      "federated.research-collab.system.z",
    );
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.research-collab.system.z",
    ]);
    // No NEW routing error for that network after recovery.
    expect(routingErrors).toEqual([]);

    await runtime.stop();
  });

  // (b2) BOUNDED BACKOFF: a reconnect that keeps failing doubles the delay
  //      (capped at maxMs) and reschedules — it does NOT spin.
  test("(b2) repeated reconnect failures use bounded exponential backoff (double, capped) and reschedule", async () => {
    const timer = makeControlledTimer();
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === RESEARCH_URL) throw new Error("still down");
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
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl,
        federatedNetworks: networks,
        reconnectTimer: timer.seam,
        reconnectBackoff: { initialMs: 10, maxMs: 40, factor: 2 },
      },
    );
    // initial: 10ms
    expect(timer.onlyPendingMs()).toBe(10);
    await timer.fireNext(); // fails → reschedule at 20ms
    expect(timer.pendingCount()).toBe(1);
    expect(timer.onlyPendingMs()).toBe(20);
    await timer.fireNext(); // fails → reschedule at 40ms (cap)
    expect(timer.onlyPendingMs()).toBe(40);
    await timer.fireNext(); // fails → reschedule, capped at 40ms (not 80)
    expect(timer.onlyPendingMs()).toBe(40);

    await runtime.stop();
    // After stop(), the pending timer is cancelled.
    expect(timer.pendingCount()).toBe(0);
  });

  // (c) BACK-COMPAT: zero networks ⇒ no lifecycle machinery engages.
  test("(c) zero federated networks ⇒ no reconnect timer scheduled; single primary link; unchanged", async () => {
    const timer = makeControlledTimer();
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      let conn = byUrl.get(url);
      if (!conn) {
        conn = makeFakeConn();
        byUrl.set(url, conn);
      }
      return conn.nc;
    };
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: ["local.{principal}.>"] }),
      { connectImpl, stack: "default", reconnectTimer: timer.seam },
      // NB: federatedNetworks omitted entirely.
    );
    expect(runtime.enabled).toBe(true);
    // NO lifecycle machinery: no reconnect timer was ever scheduled.
    expect(timer.pendingCount()).toBe(0);
    // Exactly one physical link.
    expect(byUrl.size).toBe(1);
    const primary = byUrl.get(PRIMARY_URL)!;
    // Publishes route to primary exactly as today.
    await runtime.publish(makeEnvelope({ type: "system.adapter.degraded" }));
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.default.system.adapter.degraded",
    ]);

    await runtime.stop();
    // Still no timer (stop() didn't schedule one either).
    expect(timer.pendingCount()).toBe(0);
  });

  // (d) stop() cancels a pending reconnect timer — no leaked timer, no
  //     post-stop reconnect.
  test("(d) stop() cancels the pending reconnect timer (no leaked timer, no post-stop reconnect)", async () => {
    const timer = makeControlledTimer();
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    let researchAttempts = 0;
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === RESEARCH_URL) {
        researchAttempts++;
        throw new Error("leaf down");
      }
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
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl,
        federatedNetworks: networks,
        reconnectTimer: timer.seam,
        reconnectBackoff: { initialMs: 5 },
      },
    );
    // A reconnect timer is pending (leaf down at boot).
    expect(timer.pendingCount()).toBe(1);
    const attemptsBeforeStop = researchAttempts; // 1 boot attempt only.

    // stop() must cancel the pending timer.
    await runtime.stop();
    expect(timer.pendingCount()).toBe(0);

    // Belt-and-braces: even if a stale handle WERE fired post-stop, the
    // reconnect callback re-checks `stopped` and is a no-op — no further
    // connect attempt happens. (Our controlled timer already removed the
    // handle on clear, so fireNext would throw "no pending timer"; assert the
    // attempt count is frozen at the boot attempt either way.)
    expect(researchAttempts).toBe(attemptsBeforeStop);
  });

  // (d2) a reconnect callback that fires AFTER stop() (race) does NOT
  //      re-connect or re-schedule — the `stopped` guard makes it a no-op.
  test("(d2) reconnect callback racing past stop() is a no-op (stopped guard)", async () => {
    // Capture the scheduled callback so we can invoke it AFTER stop(),
    // simulating a timer that had already fired into the microtask queue.
    let capturedCb: (() => void) | null = null;
    const seam = {
      setTimer: (cb: () => void, _ms: number): object => {
        capturedCb = cb;
        return {};
      },
      clearTimer: (_handle: object): void => {
        // Intentionally DO NOT drop capturedCb — we want to fire it post-stop
        // to prove the runtime's own `stopped` guard (not the timer clear)
        // makes the callback inert.
      },
    };
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    let researchAttempts = 0;
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === RESEARCH_URL) {
        researchAttempts++;
        throw new Error("leaf down");
      }
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
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl, federatedNetworks: networks, reconnectTimer: seam },
    );
    expect(capturedCb).not.toBeNull();
    const attemptsAfterBoot = researchAttempts; // 1 boot attempt.

    await runtime.stop();

    // Fire the captured callback AFTER stop(): the `stopped` guard inside the
    // callback short-circuits before any reconnect attempt.
    capturedCb!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(researchAttempts).toBe(attemptsAfterBoot); // no new connect attempt.
  });
});
