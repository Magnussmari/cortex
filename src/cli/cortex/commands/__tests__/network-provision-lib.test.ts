/**
 * G1d / T1 (cortex#1139) — tests for the pure provision orchestration behind
 * `cortex network provision <stack>`. All arc/fs/nsc effects are injected ports
 * recording their calls — no real nsc/arc/filesystem.
 */
import { describe, test, expect } from "bun:test";

import type { FederationWiringPort } from "../network-ports";
import type { OperatorProvisioningPort } from "../operator-provisioning";
import {
  buildProvisionPlan,
  deriveProvisionNames,
  provisionStack,
  type ProvisionInputs,
  type ProvisionPorts,
  type ProvisionState,
  type SigningIdentityPort,
  type ProvisionConfigWritePort,
} from "../network-provision-lib";

const FED_PUB = "A" + "B".repeat(55);
const AGENTS_PUB = "A" + "C".repeat(55);

/** Spy ports recording every effectful call in order. */
function makePorts(overrides?: {
  operator?: Partial<OperatorProvisioningPort>;
  signing?: Partial<SigningIdentityPort>;
  federationWiring?: Partial<FederationWiringPort>;
  configWrite?: Partial<ProvisionConfigWritePort>;
}): { ports: ProvisionPorts; calls: string[]; written: unknown[] } {
  const calls: string[] = [];
  const written: unknown[] = [];

  const operator: OperatorProvisioningPort = {
    initOperator: async ({ name, force }) => {
      calls.push(`init-operator:${name}${force ? ":force" : ""}`);
      return { ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null };
    },
    addAccount: async ({ name }) => {
      calls.push(`add-account:${name}`);
      const pubKey = name.endsWith("_AGENTS") ? AGENTS_PUB : FED_PUB;
      return { ok: true, account: name, pubKey, created: true, alreadyExisted: false };
    },
    ...overrides?.operator,
  };

  const signing: SigningIdentityPort = {
    exists: () => false,
    generate: ({ seedPath, force }) => {
      calls.push(`signing-generate:${seedPath}${force ? ":force" : ""}`);
      return { ok: true, nkeyPub: "U" + "Z".repeat(55), fingerprint: "fp" };
    },
    ...overrides?.signing,
  };

  const federationWiring: FederationWiringPort = {
    wireLocalFederation: async ({ federationAccount, agentsAccount, apply }) => {
      calls.push(`wire:${federationAccount}->${agentsAccount}:${apply ? "apply" : "dry"}`);
      return { ok: true, note: "export+import wired" };
    },
    ...overrides?.federationWiring,
  };

  const configWrite: ProvisionConfigWritePort = {
    write: (fields) => {
      calls.push("config-write");
      written.push(fields);
      return { ok: true };
    },
    ...overrides?.configWrite,
  };

  return { ports: { operator, signing, federationWiring, configWrite }, calls, written };
}

function baseInputs(over?: Partial<ProvisionInputs>, state?: Partial<ProvisionState>): ProvisionInputs {
  return {
    principal: "andreas",
    stackSlug: "research",
    stackId: "andreas/research",
    operatorName: "OP_ANDREAS",
    federationAccountName: "ANDREAS_RESEARCH_FED",
    agentsAccountName: "ANDREAS_RESEARCH_AGENTS",
    seedPath: "~/.config/nats/andreas-research.seed",
    credsPath: "~/.config/nats/research.creds",
    force: false,
    apply: false,
    state: { federationAccount: undefined, agentsAccount: undefined, signingSeedExists: false, ...state },
    ...over,
  };
}

describe("deriveProvisionNames", () => {
  test("per-stack agents account is distinct from the federation account", () => {
    const r = deriveProvisionNames("andreas", "research");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorName).toBe("OP_ANDREAS");
      expect(r.federationAccountName).toBe("ANDREAS_RESEARCH_FED");
      expect(r.agentsAccountName).toBe("ANDREAS_RESEARCH_AGENTS");
      // ADR-0012 isolation — the two accounts are NOT the same.
      expect(r.federationAccountName).not.toBe(r.agentsAccountName);
    }
  });

  test("a second stack of the same principal mints DIFFERENT accounts", () => {
    const a = deriveProvisionNames("andreas", "research");
    const b = deriveProvisionNames("andreas", "production");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.agentsAccountName).not.toBe(b.agentsAccountName);
    }
  });

  test("hyphens in segments become underscores (UPPER_SNAKE)", () => {
    const r = deriveProvisionNames("andreas-x", "code-review");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorName).toBe("OP_ANDREAS_X");
      expect(r.federationAccountName).toBe("ANDREAS_X_CODE_REVIEW_FED");
    }
  });
});

describe("buildProvisionPlan", () => {
  test("empty stack → 4 ensure actions (operator + 2 accounts + signing) + 2 wire steps", () => {
    const plan = buildProvisionPlan(baseInputs());
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike.map((p) => p.step)).toEqual([
      "nsc operator",
      "federation account",
      "agents account",
      "signing seed",
    ]);
  });

  test("fully-provisioned stack → every account/seed step is [ok]", () => {
    const plan = buildProvisionPlan(
      baseInputs({}, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true }),
    );
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike).toEqual([]);
  });

  test("partial state: operator+fed present, agents absent → only agents mints", () => {
    const plan = buildProvisionPlan(
      baseInputs({}, { federationAccount: FED_PUB, agentsAccount: undefined, signingSeedExists: true }),
    );
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike.map((p) => p.step)).toEqual(["agents account"]);
  });

  test("--force re-mints everything even when present", () => {
    const plan = buildProvisionPlan(
      baseInputs({ force: true }, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true }),
    );
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike.length).toBe(4);
  });
});

describe("provisionStack — dry-run (default)", () => {
  test("records ZERO effectful port calls and does not write config", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(baseInputs({ apply: false }), ports);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(calls).toEqual([]);
    expect(res.steps.some((s) => s.includes("--apply"))).toBe(true);
  });
});

describe("provisionStack — apply on an empty stack", () => {
  test("records the mint/wire/write calls in order", async () => {
    const { ports, calls, written } = makePorts();
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(calls).toEqual([
      "init-operator:OP_ANDREAS",
      "add-account:ANDREAS_RESEARCH_FED",
      "add-account:ANDREAS_RESEARCH_AGENTS",
      "signing-generate:~/.config/nats/andreas-research.seed",
      `wire:${FED_PUB}->${AGENTS_PUB}:apply`,
      "config-write",
    ]);
    // Config write-back carries the minted (distinct) account pubkeys.
    expect(written[0]).toMatchObject({ account: FED_PUB, agentsAccount: AGENTS_PUB });
    expect(res.resolved?.account).toBe(FED_PUB);
    expect(res.resolved?.agentsAccount).toBe(AGENTS_PUB);
  });

  test("the federated.> wire is CROSS-account (distinct from/to)", async () => {
    const { ports, calls } = makePorts();
    await provisionStack(baseInputs({ apply: true }), ports);
    const wire = calls.find((c) => c.startsWith("wire:"));
    expect(wire).toBe(`wire:${FED_PUB}->${AGENTS_PUB}:apply`);
    expect(FED_PUB).not.toBe(AGENTS_PUB);
  });
});

describe("provisionStack — idempotent apply re-run", () => {
  test("fully-provisioned stack → no operator/account/signing mint calls", async () => {
    const { ports, calls } = makePorts({ signing: { exists: () => true } });
    const res = await provisionStack(
      baseInputs({ apply: true }, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).not.toContain("init-operator:OP_ANDREAS");
    expect(calls.some((c) => c.startsWith("add-account:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("signing-generate:"))).toBe(false);
    // Wiring (idempotent) + config write still run to converge.
    expect(calls).toContain(`wire:${FED_PUB}->${AGENTS_PUB}:apply`);
    expect(calls).toContain("config-write");
  });
});

describe("provisionStack — no-clobber & force", () => {
  test("existing signing seed without --force is left untouched (no-clobber)", async () => {
    const { ports, calls } = makePorts({ signing: { exists: () => true } });
    await provisionStack(
      baseInputs({ apply: true }, { federationAccount: undefined, agentsAccount: undefined, signingSeedExists: true }),
      ports,
    );
    // generate is NEVER called when the seed exists and --force is off.
    expect(calls.some((c) => c.startsWith("signing-generate:"))).toBe(false);
  });

  test("--force re-mints the signing seed (clobber) loudly", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(
      baseInputs({ apply: true, force: true }, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).toContain("init-operator:OP_ANDREAS:force");
    expect(calls.some((c) => c.startsWith("signing-generate:") && c.endsWith(":force"))).toBe(true);
  });
});

describe("provisionStack — fail-fast", () => {
  test("an arc add-account failure aborts BEFORE the config write", async () => {
    const { ports, calls } = makePorts({
      operator: {
        initOperator: async ({ name }) => {
          calls.push(`init-operator:${name}`);
          return { ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null };
        },
        addAccount: async ({ name }) => {
          calls.push(`add-account:${name}`);
          return { ok: false, reason: "NSC_COMMAND_FAILED: boom" };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("add-account");
    // No config write-back on a mid-pipeline failure.
    expect(calls).not.toContain("config-write");
  });

  test("a federation-wiring failure aborts before config write", async () => {
    const { ports, calls } = makePorts({
      federationWiring: {
        wireLocalFederation: async () => ({ ok: false, reason: "arc add-federation-export failed" }),
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("wiring");
    expect(calls).not.toContain("config-write");
  });
});
