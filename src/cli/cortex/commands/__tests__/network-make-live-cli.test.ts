/**
 * C-1257 — CLI tests for `cortex network make-live <stack>`. The config reader +
 * make-live ports are both injected; the read-only state probes are made
 * deterministic by pointing --nats-config / --creds at nonexistent paths (absent
 * ⇒ "needs migration"), so no real disk / arc / launchctl is touched.
 */
import { describe, test, expect } from "bun:test";

import { dispatchNetwork, type MakeLivePortsFactory } from "../network";
import type { ConfigReader } from "../network-derive";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import type { MakeLivePorts } from "../network-make-live-lib";

const AGENTS_PUB = "A" + "R".repeat(55);
const AGENTS_JWT = "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJBQVJSIn0.sig";

function loaded(partial: Partial<LoadedConfig>): LoadedConfig {
  return { config: {} as AgentConfig, inlineAgents: [], ...partial };
}
function reader(cfg: LoadedConfig): ConfigReader {
  return () => cfg;
}

const ABSENT_NATS = "/nonexistent-makelive-test/local.conf";
const ABSENT_CREDS = "/nonexistent-makelive-test/cortex-work.creds";

/** A fully-provisioned local stack (nats_infra.agents_account set). */
const PROVISIONED = loaded({
  principal: { id: "andreas" },
  config: { nats: { name: "cortex-work", credsPath: ABSENT_CREDS } } as unknown as AgentConfig,
  stack: {
    id: "andreas/work",
    nkey_seed_path: "~/.config/nats/cortex-work.nk",
    nats_infra: {
      account: "A" + "B".repeat(55),
      agents_account: AGENTS_PUB,
      creds_path: "~/.config/nats/work.creds",
    },
  },
});

/** An un-provisioned stack (no nats_infra account tree). */
const UNPROVISIONED = loaded({
  principal: { id: "andreas" },
  config: { nats: { name: "cortex-work", credsPath: ABSENT_CREDS } } as unknown as AgentConfig,
  stack: { id: "andreas/work", nkey_seed_path: "~/.config/nats/cortex-work.nk" },
});

function fakeFactory(): { factory: MakeLivePortsFactory; calls: string[]; mutates: boolean[] } {
  const calls: string[] = [];
  const mutates: boolean[] = [];
  const factory: MakeLivePortsFactory = (mutate) => {
    mutates.push(mutate);
    const ports: MakeLivePorts = {
      creds: {
        mint: async ({ account, credsPath }) => {
          calls.push(`mint:${account}`);
          return { ok: true, credsPath, userPubkey: "U" + "Z".repeat(55) };
        },
      },
      accountExport: {
        exportAccount: async (account) => {
          calls.push(`export:${account}`);
          return { ok: true, pubKey: AGENTS_PUB, jwt: AGENTS_JWT, seedPath: null };
        },
      },
      resolver: {
        hasAccount: () => false,
        appendAccount: () => { calls.push("resolver-append"); return { ok: true, changed: true }; },
      },
      restart: {
        restartNats: async () => { calls.push("restart-nats"); return { ok: true }; },
        restartDaemon: async () => { calls.push("restart-daemon"); return { ok: true }; },
      },
    };
    return ports;
  };
  return { factory, calls, mutates };
}

function run(argv: string[], cfg: LoadedConfig, factory: MakeLivePortsFactory) {
  return dispatchNetwork(argv, reader(cfg), undefined, undefined, undefined, factory);
}

describe("cortex network make-live — dry-run (default)", () => {
  test("prints the plan, mutates nothing", async () => {
    const { factory, calls, mutates } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("ANDREAS_WORK_AGENTS");
    expect(res.stdout).toContain("resolver_preload");
    expect(calls).toEqual([]); // dry-run: no effects
    expect(mutates).toEqual([false]); // ports built with mutate=false
  });
});

describe("cortex network make-live — apply", () => {
  test("runs export → resolver → nats restart → creds → daemon restart in order", async () => {
    const { factory, calls, mutates } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS, "--apply"],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(calls).toEqual([
      "export:ANDREAS_WORK_AGENTS",
      "resolver-append",
      "restart-nats",
      "mint:ANDREAS_WORK_AGENTS",
      "restart-daemon",
    ]);
    expect(mutates).toEqual([true]);
  });

  test("un-provisioned stack is a usage error naming provision", async () => {
    const { factory, calls } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS, "--apply"],
      UNPROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("provision");
    expect(calls).toEqual([]);
  });

  test("--apply + --dry-run is a usage error", async () => {
    const { factory } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--apply", "--dry-run"],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });
});
