/**
 * G1d / T1 (cortex#1139, ADR-0013 Model B) — the pure orchestration behind
 * `cortex network provision <stack>`: the one-command sovereign account-topology
 * setup. Stands up a principal's OWN nsc account tree so a stack can federate.
 *
 * The pipeline (ensure-shaped, idempotent end-to-end; ADR-0013 §Decision-4
 * "make standing up your own nsc operator trivial"):
 *
 *   1. ensure the NSC operator        (arc nats init-operator)   — per principal
 *   2. ensure the federation account  (arc nats add-account)     — per stack, leaf-bound
 *   3. ensure the per-stack agents account (arc nats add-account)— ADR-0012 isolation
 *   4. ensure the stack signing seed  (provision-stack generate) — chmod 600, no-clobber
 *   5. wire federated.> export/import (arc nats add-federation-export) — fed → agents
 *   6. write stack.nats_infra back    (account, agents_account, creds_path) + nkey_seed_path
 *
 * After this the stack is ready for `cortex network join` — only the two
 * irreducible two-party steps remain (the leaf shared secret + hub topology
 * agreement). The operator-mode `.conf` render + bus restart are LEFT TO JOIN
 * (render-only here; join already performs the O-3 conversion + #821 health
 * probe), so this verb is non-disruptive.
 *
 * This module is PURE over injected ports — zero fs / arc / nsc. The live
 * adapters live in `network-provision-adapters.ts`; the arc account-tree seam is
 * {@link OperatorProvisioningPort} (operator-provisioning.ts) + the existing
 * {@link FederationWiringPort}. cortex NEVER runs nsc itself (ADR-0013 invariant).
 *
 * ## Idempotency & no-clobber
 *
 * Every step is ensure-shaped: present ⇒ no-op (rendered `[ok]`), absent ⇒ mint.
 * State is read from CONFIG + filesystem, so a converged re-run shells zero mint
 * calls (arc init-operator / add-account are themselves idempotent, but we skip
 * them when config already carries the resolved pubkeys). The signing seed is
 * NEVER overwritten without `--force` — an existing seed is left untouched
 * (no-clobber); `--force` is a deliberate rotation that re-mints it.
 *
 * ## Dry-run vs apply
 *
 * Dry-run (the DEFAULT-safe posture) computes the plan from config + filesystem
 * state and mutates NOTHING — it never shells the account-tree mint verbs (which
 * have no dry-run mode in arc). `--apply` executes the mints + wiring + config
 * write-back, fail-fast: the whole plan is validated before the first mutation,
 * and any arc failure aborts BEFORE the config write so no half-provisioned
 * config block is left behind.
 */

import type { FederationWiringPort } from "./network-ports";
import type { OperatorProvisioningPort } from "./operator-provisioning";

// =============================================================================
// Name derivation — nsc operator + account names from {principal}/{slug}
// =============================================================================

/** nsc account names are strict UPPER_SNAKE (`[A-Z][A-Z0-9_]+`, arc's guard). */
const ACCOUNT_NAME_RE = /^[A-Z][A-Z0-9_]+$/;
/** nsc operator names permit a slightly wider charset (`[A-Za-z][A-Za-z0-9_-]*`). */
const OPERATOR_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** UPPER_SNAKE a `{principal}` / `{slug}` segment (lowercase + hyphen → `_`). */
function upperSnake(segment: string): string {
  return segment.toUpperCase().replace(/-/g, "_");
}

/**
 * Derive the nsc operator + the two account names for a stack. The operator is
 * per-principal (`OP_<PRINCIPAL>`); the federation + agents accounts are
 * per-stack (`<PRINCIPAL>_<STACK>_FED` / `_AGENTS`) so a principal's second
 * stack mints DISTINCT accounts (ADR-0012 isolation — never shared).
 */
export function deriveProvisionNames(
  principal: string,
  slug: string,
): { ok: true; operatorName: string; federationAccountName: string; agentsAccountName: string } | { ok: false; reason: string } {
  const operatorName = `OP_${upperSnake(principal)}`;
  const base = `${upperSnake(principal)}_${upperSnake(slug)}`;
  const federationAccountName = `${base}_FED`;
  const agentsAccountName = `${base}_AGENTS`;
  if (!OPERATOR_NAME_RE.test(operatorName)) {
    return { ok: false, reason: `derived nsc operator name "${operatorName}" is invalid (principal "${principal}")` };
  }
  for (const n of [federationAccountName, agentsAccountName]) {
    if (!ACCOUNT_NAME_RE.test(n)) {
      return { ok: false, reason: `derived account name "${n}" is invalid (must be UPPER_SNAKE)` };
    }
  }
  return { ok: true, operatorName, federationAccountName, agentsAccountName };
}

// =============================================================================
// Ports
// =============================================================================

/** Signing-identity seam (composes `provision-stack generate` / generateStackIdentity). */
export interface SigningIdentityPort {
  /** Is a signing seed already present at `seedPath`? Drives the dry-run plan. */
  exists(seedPath: string): boolean;
  /** Mint a fresh signing seed (`chmod 600`); `force` clobbers an existing one. */
  generate(opts: { seedPath: string; force: boolean }):
    | { ok: true; nkeyPub: string; fingerprint: string }
    | { ok: false; reason: string };
}

/** Config write-back seam — persists the resolved `stack.nats_infra` fields. */
export interface ProvisionConfigWritePort {
  write(fields: {
    account: string;
    agentsAccount: string;
    credsPath: string;
    seedPath: string;
    nkeyPub?: string;
  }): { ok: true } | { ok: false; reason: string };
}

/** The full port bundle the orchestrator depends on. */
export interface ProvisionPorts {
  operator: OperatorProvisioningPort;
  signing: SigningIdentityPort;
  federationWiring: FederationWiringPort;
  configWrite: ProvisionConfigWritePort;
}

// =============================================================================
// Inputs + state + result
// =============================================================================

/** Observable pre-provision state (read from config + filesystem). */
export interface ProvisionState {
  /** `stack.nats_infra.account` (the leaf-bound federation account `A…` pubkey), if set. */
  federationAccount: string | undefined;
  /** `stack.nats_infra.agents_account` (`A…` pubkey), if set. */
  agentsAccount: string | undefined;
  /** Does the signing seed file exist on disk? */
  signingSeedExists: boolean;
}

export interface ProvisionInputs {
  principal: string;
  stackSlug: string;
  stackId: string;
  operatorName: string;
  federationAccountName: string;
  agentsAccountName: string;
  /** `stack.nkey_seed_path` — where the signing seed is / will be written. */
  seedPath: string;
  /** Conventional leaf `.creds` path recorded in config (minted at join). */
  credsPath: string;
  force: boolean;
  apply: boolean;
  state: ProvisionState;
}

export type PlanStatus = "mint" | "generate" | "wire" | "ok";

export interface PlanItem {
  step: string;
  status: PlanStatus;
  detail: string;
}

export interface ProvisionResult {
  ok: boolean;
  reason?: string;
  applied: boolean;
  plan: PlanItem[];
  /** Human-readable plan/result lines for the CLI renderer. */
  steps: string[];
  /** The resolved fields (present on a successful apply). */
  resolved?: { account: string; agentsAccount: string; credsPath: string; seedPath: string };
}

// =============================================================================
// Plan builder (pure)
// =============================================================================

/**
 * Compute the ensure-plan from observable state. Each step is `[ok]` when
 * already present, `[mint]`/`[generate]` when absent (or always, under
 * `--force`). The `federated.>` wiring is always a converge step (arc is
 * idempotent). The operator is treated as present iff the federation account is
 * (an account cannot exist without its operator).
 */
export function buildProvisionPlan(inputs: ProvisionInputs): PlanItem[] {
  const { force, state } = inputs;
  const operatorPresent = !force && state.federationAccount !== undefined;
  const fedPresent = !force && state.federationAccount !== undefined;
  const agentsPresent = !force && state.agentsAccount !== undefined;
  const signingPresent = !force && state.signingSeedExists;

  return [
    {
      step: "nsc operator",
      status: operatorPresent ? "ok" : "mint",
      detail: inputs.operatorName,
    },
    {
      step: "federation account",
      status: fedPresent ? "ok" : "mint",
      detail: fedPresent ? `${inputs.federationAccountName} (${state.federationAccount})` : inputs.federationAccountName,
    },
    {
      step: "agents account",
      status: agentsPresent ? "ok" : "mint",
      detail: agentsPresent ? `${inputs.agentsAccountName} (${state.agentsAccount})` : inputs.agentsAccountName,
    },
    {
      step: "signing seed",
      status: signingPresent ? "ok" : "generate",
      detail: inputs.seedPath,
    },
    {
      step: "federated.> export/import",
      status: "wire",
      detail: `${inputs.federationAccountName} → ${inputs.agentsAccountName}`,
    },
    {
      step: "stack.nats_infra write-back",
      status: "wire",
      detail: "account, agents_account, creds_path, nkey_seed_path",
    },
  ];
}

/** Render a plan item as a CLI line (`[mint ] nsc operator   OP_ANDREAS`). */
function renderPlanLine(item: PlanItem): string {
  const tag = item.status.padEnd(8);
  return `[${tag}] ${item.step.padEnd(28)} ${item.detail}`;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Provision a stack's sovereign account topology. Pure over `ports`; NEVER
 * throws (port failures surface as `{ ok: false, reason }`).
 *
 * Dry-run (`apply === false`): returns the plan; mutates nothing.
 * Apply: executes mints + wiring + config write-back, fail-fast (validate the
 * full plan, then mutate; abort before the config write on any arc failure).
 */
export async function provisionStack(
  inputs: ProvisionInputs,
  ports: ProvisionPorts,
): Promise<ProvisionResult> {
  const plan = buildProvisionPlan(inputs);
  const planLines = plan.map(renderPlanLine);

  if (!inputs.apply) {
    return {
      ok: true,
      applied: false,
      plan,
      steps: [
        ...planLines,
        "",
        "Re-run with --apply to execute.",
        "AFTER this: exchange the leaf shared secret + agree hub topology with your peer, then `cortex network join <network>`.",
      ],
    };
  }

  const { force, state } = inputs;
  const steps: string[] = [];

  // The pubkeys we resolve (minted-or-existing) and write back to config.
  let resolvedAccount = state.federationAccount;
  let resolvedAgents = state.agentsAccount;
  let resolvedNkeyPub: string | undefined;

  const operatorNeeded = force || state.federationAccount === undefined;
  const fedNeeded = force || state.federationAccount === undefined;
  const agentsNeeded = force || state.agentsAccount === undefined;
  const signingNeeded = force || !state.signingSeedExists;

  // 1. NSC operator (per principal). Idempotent in arc; skipped when the
  //    federation account already exists (it cannot exist without its operator).
  if (operatorNeeded) {
    const r = await ports.operator.initOperator({ name: inputs.operatorName, force });
    if (!r.ok) return fail(plan, planLines, `init-operator failed: ${r.reason}`);
    steps.push(`nsc operator ${r.alreadyExisted && !r.created ? "present" : r.created ? "minted" : "ensured"}: ${r.operator}`);
  } else {
    steps.push(`nsc operator present: ${inputs.operatorName}`);
  }

  // 2. Federation account (leaf-bound, per stack).
  if (fedNeeded) {
    const r = await ports.operator.addAccount({ name: inputs.federationAccountName });
    if (!r.ok) return fail(plan, planLines, `add-account (federation) failed: ${r.reason}`);
    resolvedAccount = r.pubKey;
    steps.push(`federation account ${r.created ? "minted" : "present"}: ${r.account} (${r.pubKey})`);
  } else {
    steps.push(`federation account present: ${resolvedAccount}`);
  }

  // 3. Per-stack agents account (ADR-0012 isolation).
  if (agentsNeeded) {
    const r = await ports.operator.addAccount({ name: inputs.agentsAccountName });
    if (!r.ok) return fail(plan, planLines, `add-account (agents) failed: ${r.reason}`);
    resolvedAgents = r.pubKey;
    steps.push(`agents account ${r.created ? "minted" : "present"}: ${r.account} (${r.pubKey})`);
  } else {
    steps.push(`agents account present: ${resolvedAgents}`);
  }

  // 4. Signing seed (chmod 600, no-clobber unless --force).
  if (signingNeeded) {
    const r = ports.signing.generate({ seedPath: inputs.seedPath, force });
    if (!r.ok) return fail(plan, planLines, `signing-seed generate failed: ${r.reason}`);
    resolvedNkeyPub = r.nkeyPub;
    steps.push(`signing seed ${force ? "rotated" : "generated"}: ${inputs.seedPath} (chmod 600)`);
  } else {
    steps.push(`signing seed present (untouched): ${inputs.seedPath}`);
  }

  // Defensive: both account pubkeys must be resolved before wiring/write-back.
  if (resolvedAccount === undefined || resolvedAgents === undefined) {
    return fail(plan, planLines, "internal: account pubkeys unresolved after mint (should not happen)");
  }

  // 5. Wire the local-side federated.> export/import (fed-account → agents-account).
  const wire = await ports.federationWiring.wireLocalFederation({
    federationAccount: resolvedAccount,
    agentsAccount: resolvedAgents,
    apply: true,
  });
  if (!wire.ok) return fail(plan, planLines, `federation wiring failed: ${wire.reason}`);
  steps.push(`federated.> export/import: ${wire.note ?? "wired"}`);

  // 6. Write the resolved nats_infra fields back to the stack config.
  const written = ports.configWrite.write({
    account: resolvedAccount,
    agentsAccount: resolvedAgents,
    credsPath: inputs.credsPath,
    seedPath: inputs.seedPath,
    ...(resolvedNkeyPub !== undefined && { nkeyPub: resolvedNkeyPub }),
  });
  if (!written.ok) return fail(plan, planLines, `config write-back failed: ${written.reason}`);
  steps.push("stack.nats_infra written (account, agents_account, creds_path, nkey_seed_path)");

  steps.push("");
  steps.push("Ready for `cortex network join <network>` — remaining: leaf shared secret + hub topology (two-party, out-of-band).");

  return {
    ok: true,
    applied: true,
    plan,
    steps,
    resolved: {
      account: resolvedAccount,
      agentsAccount: resolvedAgents,
      credsPath: inputs.credsPath,
      seedPath: inputs.seedPath,
    },
  };
}

function fail(plan: PlanItem[], planLines: string[], reason: string): ProvisionResult {
  return { ok: false, reason, applied: true, plan, steps: planLines };
}
