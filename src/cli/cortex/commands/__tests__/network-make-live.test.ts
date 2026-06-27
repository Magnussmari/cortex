/**
 * C-1257 — tests for the pure make-live orchestration behind
 * `cortex network make-live <stack>` (the daemon-switch). All arc/fs/launchctl
 * effects are injected ports recording their calls — no real arc/nsc/fs/services.
 *
 * The anti-rot guard (sibling of the #255 provision-integration guard): asserts
 * the daemon-switch contract end-to-end against a faithful fake — creds minted
 * under the agents account, the agents JWT appended to resolver_preload exactly
 * once, both services restarted ONLY when state changed (and in the right order:
 * nats BEFORE the daemon), idempotent re-runs, and that the orchestrator never
 * touches the stack config (so encryption / federated config survives).
 */
import { describe, test, expect } from "bun:test";

import {
  makeLiveStack,
  planMakeLive,
  type MakeLiveInputs,
  type MakeLivePorts,
  type MakeLiveState,
} from "../network-make-live-lib";
import { insertIntoResolverPreload, findNatsServerDescriptor } from "../network-make-live-adapters";
import type { DaemonLocatorIO } from "../daemon-locator";

const AGENTS_PUB = "A" + "R".repeat(55);
const AGENTS_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBQVJSIn0.sig";

function makeInputs(state: MakeLiveState, over?: Partial<MakeLiveInputs>): MakeLiveInputs {
  return {
    principal: "andreas",
    stackSlug: "work",
    stackId: "andreas/work",
    agentsAccountName: "ANDREAS_WORK_AGENTS",
    agentsAccountPubkey: AGENTS_PUB,
    botName: "cortex-work",
    credsPath: "~/.config/nats/cortex-work.creds",
    cortexConfigPath: "/Users/x/.config/cortex/work/work.yaml",
    natsConfigPath: "~/.config/nats/local.conf",
    force: false,
    apply: true,
    state,
    ...over,
  };
}

/** Spy ports recording every effectful call in order. */
function makePorts(over?: {
  resolverHas?: boolean;
  exportFails?: boolean;
  mintFails?: boolean;
}): { ports: MakeLivePorts; calls: string[] } {
  const calls: string[] = [];
  const ports: MakeLivePorts = {
    creds: {
      mint: async ({ botName, account, credsPath }) => {
        calls.push(`mint:${botName}@${account}->${credsPath}`);
        if (over?.mintFails) return { ok: false, reason: "add-bot boom" };
        return { ok: true, credsPath, userPubkey: "U" + "Z".repeat(55) };
      },
    },
    accountExport: {
      exportAccount: async (account) => {
        calls.push(`export:${account}`);
        if (over?.exportFails) return { ok: false, reason: "export boom" };
        return { ok: true, pubKey: AGENTS_PUB, jwt: AGENTS_JWT, seedPath: null };
      },
    },
    resolver: {
      hasAccount: () => over?.resolverHas ?? false,
      appendAccount: ({ accountPubkey }) => {
        calls.push(`resolver-append:${accountPubkey}`);
        return { ok: true, changed: true };
      },
    },
    restart: {
      restartNats: async () => {
        calls.push("restart-nats");
        return { ok: true };
      },
      restartDaemon: async () => {
        calls.push("restart-daemon");
        return { ok: true };
      },
    },
  };
  return { ports, calls };
}

// ── plan ──────────────────────────────────────────────────────────────────────

describe("planMakeLive", () => {
  test("first migration (resolver absent) needs every step", () => {
    const p = planMakeLive(makeInputs({ credsFileExists: true, resolverHasAccount: false }));
    expect(p.resolverNeeded).toBe(true);
    expect(p.credsNeeded).toBe(true); // re-mint even though a (stale) creds file exists
    expect(p.natsRestartNeeded).toBe(true);
    expect(p.daemonRestartNeeded).toBe(true);
  });

  test("converged (resolver present + creds file present) needs nothing", () => {
    const p = planMakeLive(makeInputs({ credsFileExists: true, resolverHasAccount: true }));
    expect(p.resolverNeeded).toBe(false);
    expect(p.credsNeeded).toBe(false);
    expect(p.natsRestartNeeded).toBe(false);
    expect(p.daemonRestartNeeded).toBe(false);
  });

  test("--force re-mints everything even when converged", () => {
    const p = planMakeLive(makeInputs({ credsFileExists: true, resolverHasAccount: true }, { force: true }));
    expect(p.resolverNeeded).toBe(true);
    expect(p.credsNeeded).toBe(true);
  });
});

// ── apply: ordering + completeness (the anti-rot guard) ─────────────────────────

describe("makeLiveStack — apply", () => {
  test("first migration: resolver → nats restart → creds → daemon restart, in order", async () => {
    const { ports, calls } = makePorts();
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);

    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    // The exact execution order — nats-server BEFORE the daemon so the creds
    // never name an account the running server hasn't loaded yet.
    expect(calls).toEqual([
      `export:ANDREAS_WORK_AGENTS`,
      `resolver-append:${AGENTS_PUB}`,
      "restart-nats",
      `mint:cortex-work@ANDREAS_WORK_AGENTS->~/.config/nats/cortex-work.creds`,
      "restart-daemon",
    ]);
  });

  test("idempotent: converged re-run mints nothing and restarts nothing", async () => {
    const { ports, calls } = makePorts({ resolverHas: true });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: true }), ports);

    expect(res.ok).toBe(true);
    expect(calls).toEqual([]); // zero effects
    expect(res.steps.join("\n")).toContain("Already live");
  });

  test("guard: missing agents_account fails fast (run provision first)", async () => {
    const { ports, calls } = makePorts();
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }, { agentsAccountPubkey: "" }),
      ports,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("provision");
    expect(calls).toEqual([]); // nothing mutated
  });

  test("export failure aborts BEFORE any creds mint or restart", async () => {
    const { ports, calls } = makePorts({ exportFails: true });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("export-account");
    expect(calls).toEqual([`export:ANDREAS_WORK_AGENTS`]); // no mint, no restart
  });

  test("dry-run mutates nothing", async () => {
    const { ports, calls } = makePorts();
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }, { apply: false }), ports);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ── resolver_preload insertion (multi-stack safety) ─────────────────────────────

describe("insertIntoResolverPreload", () => {
  const CONF = [
    "resolver: MEMORY",
    "",
    "resolver_preload: {",
    "  // Account \"ANDREAS_AGENTS\"",
    "  AOLD: eyJold",
    "  // Account \"SYS\"",
    "  ASYS: eyJsys",
    "}",
    "",
    "http: \"127.0.0.1:8222\"",
  ].join("\n");

  test("inserts before the closing brace, preserving existing accounts", () => {
    const out = insertIntoResolverPreload(CONF, "  // Account \"NEW\"\n  ANEW: eyJnew\n");
    expect(out).not.toBeNull();
    // existing accounts untouched
    expect(out).toContain("AOLD: eyJold");
    expect(out).toContain("ASYS: eyJsys");
    // new account landed INSIDE the block (before the closing brace, before http)
    const idxNew = out!.indexOf("ANEW: eyJnew");
    const idxClose = out!.indexOf("\n}");
    const idxHttp = out!.indexOf("http:");
    expect(idxNew).toBeGreaterThan(0);
    expect(idxNew).toBeLessThan(idxClose);
    expect(idxClose).toBeLessThan(idxHttp);
  });

  test("returns null when there is no resolver_preload block", () => {
    expect(insertIntoResolverPreload("listen: 127.0.0.1:4222\n", "x")).toBeNull();
  });
});

// ── nats-server descriptor discovery (restart the RIGHT server) ─────────────────

describe("findNatsServerDescriptor", () => {
  const plist = (program: string, configArg: string) =>
    `<plist><dict><key>ProgramArguments</key><array>` +
    `<string>${program}</string><string>-js</string><string>-c</string><string>${configArg}</string>` +
    `</array></dict></plist>`;

  function io(files: Record<string, string>): DaemonLocatorIO {
    return {
      listDir: (dir) => Object.keys(files).filter((f) => f.startsWith(dir)).map((f) => f.slice(dir.length + 1)),
      readFile: (p) => files[p] ?? (() => { throw new Error("ENOENT"); })(),
      exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(p)),
    };
  }

  test("matches the plist running nats-server -c <natsConfig>", () => {
    const dir = "/la";
    const files = {
      [`${dir}/homebrew.mxcl.nats-server.plist`]: plist("/opt/homebrew/opt/nats-server/bin/nats-server", "/home/x/.config/nats/local.conf"),
      [`${dir}/ai.meta-factory.cortex.work.plist`]: plist("bun", "/home/x/.config/cortex/work/work.yaml"),
    };
    const found = findNatsServerDescriptor({
      platform: "darwin",
      natsConfigPath: "/home/x/.config/nats/local.conf",
      launchAgentsDir: dir,
      systemdUserDir: "/sd",
      io: io(files),
    });
    expect(found).toBe(`${dir}/homebrew.mxcl.nats-server.plist`);
  });

  test("returns undefined when no nats-server plist references the config", () => {
    const dir = "/la";
    const files = { [`${dir}/other.plist`]: plist("/usr/bin/redis", "/etc/redis.conf") };
    const found = findNatsServerDescriptor({
      platform: "darwin",
      natsConfigPath: "/home/x/.config/nats/local.conf",
      launchAgentsDir: dir,
      systemdUserDir: "/sd",
      io: io(files),
    });
    expect(found).toBeUndefined();
  });
});
