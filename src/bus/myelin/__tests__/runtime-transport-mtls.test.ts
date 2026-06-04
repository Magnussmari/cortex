/**
 * TC-4d / TC-4e (#627 Phase 4) — MyelinRuntime LinkPool transport-mTLS wiring.
 *
 * Asserts that the `transportMtls` posture threads the built `tls` block into
 * the nats.js connect options for BOTH the primary link AND each federated
 * leaf link, and that the federated-leaf-without-TLS advisory fires:
 *
 *   - mtls off (default) → NO `tls` on any connect opts (back-compat: the
 *     connect options are byte-identical to the pre-TC-4d path).
 *   - mtls on → `tls` (cert/key/ca contents) present on primary + leaf opts.
 *   - federated leaf without TLS (mtls off, nats:// leaf) → the structured
 *     cleartext sink fires for that leaf.
 *
 * Uses the `connectImpl` fake-link seam to capture each link's `ConnectionOptions`
 * — no real `nats-server`, no real TLS handshake. Cert material is throwaway PEM
 * text in a temp dir (the builder reads bytes, it does not parse X.509).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type {
  ConnectionOptions,
  NatsConnection,
  Status,
  Subscription,
} from "nats";
import type { AgentConfig } from "../../../common/types/config";
import type { PolicyFederatedNetwork } from "../../../common/types/cortex-config";
import type { FederatedCleartextWarning } from "../../../common/config/transport-mtls";
import { startMyelinRuntime } from "../runtime";

let testDir: string;
let certPath: string;
let keyPath: string;
let caPath: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cortex-runtime-mtls-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  certPath = join(testDir, "client.crt");
  keyPath = join(testDir, "client.key");
  caPath = join(testDir, "ca.crt");
  writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nCRT\n-----END CERTIFICATE-----\n");
  writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n");
  chmodSync(keyPath, 0o600);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Fake NATS connection — only the surface `startMyelinRuntime` touches. The
 * status loop AND every subscriber iterator terminate on `drain()` so
 * `runtime.stop()` resolves promptly (no 5s status-loop close timeout).
 */
function makeFakeConn(): NatsConnection {
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
  const subscribe = mock(() => {
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
  const publish = mock(() => {});
  return { status, subscribe, drain, publish } as unknown as NatsConnection;
}

/** A connectImpl that records the ConnectionOptions of every link it opens. */
function makeRecordingConnect(): {
  connectImpl: (opts: ConnectionOptions) => Promise<NatsConnection>;
  opts: ConnectionOptions[];
} {
  const opts: ConnectionOptions[] = [];
  const connectImpl = async (o: ConnectionOptions): Promise<NatsConnection> => {
    opts.push(o);
    return makeFakeConn();
  };
  return { connectImpl, opts };
}

function makeConfig(url: string): AgentConfig {
  return {
    agent: { name: "luna", displayName: "Luna" },
    nats: { url, name: "cortex", subjects: [] },
  } as unknown as AgentConfig;
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

describe("MyelinRuntime transport mTLS (TC-4d/4e)", () => {
  test("mtls off → NO tls on the primary connect opts (back-compat)", async () => {
    const { connectImpl, opts } = makeRecordingConnect();
    const runtime = await startMyelinRuntime(makeConfig("nats://localhost:4222"), {
      connectImpl,
      transportMtls: { mode: "off", paths: { cert_path: certPath, key_path: keyPath } },
    });
    expect(runtime.enabled).toBe(true);
    expect(opts).toHaveLength(1);
    expect(opts[0]).not.toHaveProperty("tls");
    await runtime.stop();
  });

  test("transportMtls omitted entirely → NO tls (zero-config default)", async () => {
    const { connectImpl, opts } = makeRecordingConnect();
    const runtime = await startMyelinRuntime(makeConfig("nats://localhost:4222"), {
      connectImpl,
    });
    expect(opts[0]).not.toHaveProperty("tls");
    await runtime.stop();
  });

  test("mtls on → tls (cert/key/ca) present on the PRIMARY connect opts", async () => {
    const { connectImpl, opts } = makeRecordingConnect();
    const runtime = await startMyelinRuntime(makeConfig("nats://localhost:4222"), {
      connectImpl,
      transportMtls: {
        mode: "on",
        paths: { cert_path: certPath, key_path: keyPath, ca_path: caPath },
      },
    });
    expect(opts).toHaveLength(1);
    const tls = (opts[0] as { tls?: { cert?: string; key?: string; ca?: string } }).tls;
    expect(tls).toBeDefined();
    expect(tls?.cert).toContain("BEGIN CERTIFICATE");
    expect(tls?.key).toContain("BEGIN PRIVATE KEY");
    expect(tls?.ca).toContain("BEGIN CERTIFICATE");
    // Hard line — no skip-verify on the wire opts.
    expect(tls).not.toHaveProperty("rejectUnauthorized");
    await runtime.stop();
  });

  test("mtls on → tls present on BOTH primary AND each federated leaf opts", async () => {
    const { connectImpl, opts } = makeRecordingConnect();
    const network = makeNetwork({
      id: "research-collab",
      leaf_node: "nats-leaf-research",
      nats: { url: "nats://research:4222", name: "cortex-research" },
    });
    const runtime = await startMyelinRuntime(makeConfig("nats://localhost:4222"), {
      connectImpl,
      federatedNetworks: [network],
      transportMtls: {
        mode: "on",
        paths: { cert_path: certPath, key_path: keyPath, ca_path: caPath },
      },
    });
    // Two links: primary + the one federated leaf — both carry tls.
    expect(opts).toHaveLength(2);
    for (const o of opts) {
      const tls = (o as { tls?: { cert?: string } }).tls;
      expect(tls).toBeDefined();
      expect(tls?.cert).toContain("BEGIN CERTIFICATE");
    }
    await runtime.stop();
  });

  test("federated leaf without TLS → cleartext warning sink fires (TC-4e)", async () => {
    const { connectImpl } = makeRecordingConnect();
    const warnings: FederatedCleartextWarning[] = [];
    const network = makeNetwork({
      id: "research-collab",
      leaf_node: "nats-leaf-research",
      // nats:// (not tls://) leaf + mtls off ⇒ cleartext federated leg.
      nats: { url: "nats://research:4222", name: "cortex-research" },
    });
    const runtime = await startMyelinRuntime(makeConfig("nats://localhost:4222"), {
      connectImpl,
      federatedNetworks: [network],
      transportMtls: {
        mode: "off",
        onFederatedCleartext: (info) => warnings.push(info),
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.leafId).toBe("nats-leaf-research");
    expect(warnings[0]?.networkId).toBe("research-collab");
    expect(warnings[0]?.safeUrl).toContain("research");
    await runtime.stop();
  });

  test("federated leaf on a tls:// URL → NO cleartext warning", async () => {
    const { connectImpl } = makeRecordingConnect();
    const warnings: FederatedCleartextWarning[] = [];
    const network = makeNetwork({
      id: "research-collab",
      leaf_node: "nats-leaf-research",
      nats: { url: "tls://research:4222", name: "cortex-research" },
    });
    const runtime = await startMyelinRuntime(makeConfig("nats://localhost:4222"), {
      connectImpl,
      federatedNetworks: [network],
      transportMtls: { mode: "off", onFederatedCleartext: (info) => warnings.push(info) },
    });
    expect(warnings).toHaveLength(0);
    await runtime.stop();
  });
});
