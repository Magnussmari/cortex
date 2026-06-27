/**
 * C-1257 (PR7/#1225, ADR-0013 Model B) — the pure orchestration behind
 * `cortex network make-live <stack>`: the daemon-switch step that LANDS a
 * provisioned stack onto its own sovereign agents account.
 *
 * `cortex network provision` is non-disruptive — it mints the account tree
 * (`ANDREAS_<STACK>_FED` + `ANDREAS_<STACK>_AGENTS`) and writes `stack.nats_infra`
 * but NEVER switches the running daemon. make-live closes that gap:
 *
 *   1. mint the daemon's bus creds UNDER the agents account, at `nats.credsPath`
 *      (the very file the daemon authenticates with — `connection.ts`).
 *   2. teach the local NATS server the new account — append its JWT to
 *      `resolver_preload` (MEMORY resolver) in the nats config (default
 *      `~/.config/nats/local.conf`). Keyed on the account pubkey: pure addition,
 *      never disturbs the other stacks' accounts already there (multi-stack safe).
 *   3. restart the NATS server so the MEMORY resolver loads the new account
 *      (a SIGHUP reload does NOT pick up resolver_preload — a hard restart is
 *      required; verified empirically, see docs/design-make-live-daemon-switch.md).
 *   4. restart the cortex daemon so it reconnects with the new creds under the
 *      agents account.
 *
 * make-live is NETWORK-AGNOSTIC: it lands the daemon on its agents account for
 * BOTH a local stack (no network) and a federated one (where `cortex network
 * join` then renders the leaf on the FED account). It NEVER touches
 * `policy.federated` / `payload_key` / any encryption block, so a federated
 * stack's confidentiality setup survives the account swap by construction.
 *
 * This module is PURE over injected ports — zero fs / arc / nsc / launchctl. The
 * live adapters live in `network-make-live-adapters.ts`. cortex NEVER runs nsc
 * (ADR-0013 invariant): the account JWT comes from `arc nats export-account` and
 * the creds from `arc nats add-bot`.
 *
 * ## Idempotency
 *
 * Every step is ensure-shaped, gated on cheap filesystem reads:
 *   - resolver: append iff the agents pubkey is ABSENT (idempotent, keyed on key).
 *   - creds: (re-)mint iff this is a first migration (resolver did not yet carry
 *     the account) OR the creds file is missing OR `--force`. A converged re-run
 *     (resolver already carries the account AND the creds file exists) mints
 *     nothing and restarts nothing.
 *   - restarts: the nats-server restarts only when the resolver changed; the
 *     daemon restarts only when the creds changed (or the nats-server did).
 *
 * ## Dry-run vs apply
 *
 * Dry-run (the DEFAULT-safe posture) computes the plan from config + filesystem
 * and mutates NOTHING. `--apply` executes mint → resolver → nats restart →
 * daemon restart, fail-fast (any port failure aborts and surfaces how far it got).
 */

// =============================================================================
// Ports
// =============================================================================

/** Mint the daemon's bus creds under the agents account (composes `arc nats add-bot`). */
export interface CredsMintPort {
  /**
   * Mint a `.creds` for `botName` under `account`, written to `credsPath`
   * (`chmod 600`), backing up any existing creds to `<credsPath>.bak-makelive`
   * first. `force` overwrites an existing user. Returns the user's pubkey.
   */
  mint(opts: { botName: string; account: string; credsPath: string; force: boolean }): Promise<
    | { ok: true; credsPath: string; userPubkey: string }
    | { ok: false; reason: string }
  >;
}

/** Export an account's JWT (composes `arc nats export-account`). */
export interface AccountExportPort {
  exportAccount(account: string): Promise<
    | { ok: true; pubKey: string; jwt: string; seedPath: string | null }
    | { ok: false; reason: string }
  >;
}

/** Append an account to the nats-server `resolver_preload` (MEMORY resolver). */
export interface ResolverPreloadPort {
  /** Is `accountPubkey` already present in the resolver_preload of `natsConfigPath`? */
  hasAccount(natsConfigPath: string, accountPubkey: string): boolean;
  /**
   * Append a labelled `<pubkey>: <jwt>` block inside resolver_preload, backing
   * up the config first. Idempotent: no-op (`changed:false`) when present.
   */
  appendAccount(opts: {
    natsConfigPath: string;
    accountName: string;
    accountPubkey: string;
    accountJwt: string;
  }): { ok: true; changed: boolean } | { ok: false; reason: string };
}

/** Restart the nats-server + the cortex daemon (composes launchctl/systemctl). */
export interface ServiceRestartPort {
  /** Hard-restart the nats-server bound to `natsConfigPath` (loads new resolver_preload). */
  restartNats(natsConfigPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Restart the cortex daemon loading `cortexConfigPath` (reconnect with new creds). */
  restartDaemon(cortexConfigPath: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface MakeLivePorts {
  creds: CredsMintPort;
  accountExport: AccountExportPort;
  resolver: ResolverPreloadPort;
  restart: ServiceRestartPort;
}

// =============================================================================
// Inputs + state + result
// =============================================================================

/** Observable pre-make-live state (read from config + filesystem). */
export interface MakeLiveState {
  /** Does the daemon's connection creds file (`nats.credsPath`) exist on disk? */
  credsFileExists: boolean;
  /** Does the nats config's resolver_preload already carry the agents account pubkey? */
  resolverHasAccount: boolean;
}

export interface MakeLiveInputs {
  principal: string;
  stackSlug: string;
  stackId: string;
  /** `ANDREAS_<STACK>_AGENTS` — the account name to land the daemon on. */
  agentsAccountName: string;
  /** `stack.nats_infra.agents_account` pubkey (provision wrote it). REQUIRED. */
  agentsAccountPubkey: string;
  /** `nats.name` — the bot/user name minted under the agents account. */
  botName: string;
  /** `nats.credsPath` — the daemon's connection creds (where new creds land). */
  credsPath: string;
  /** Path to the cortex config the daemon loads (for daemon-restart discovery). */
  cortexConfigPath: string;
  /** Path to the nats-server config carrying resolver_preload (default local.conf). */
  natsConfigPath: string;
  force: boolean;
  apply: boolean;
  state: MakeLiveState;
}

export type StepStatus = "mint" | "wire" | "restart" | "ok";

export interface PlanItem {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface MakeLiveResult {
  ok: boolean;
  reason?: string;
  applied: boolean;
  plan: PlanItem[];
  steps: string[];
}

// =============================================================================
// Plan (pure)
// =============================================================================

/**
 * Decide which steps are NEEDED from observable state. A first migration is
 * signalled by the resolver NOT yet carrying the agents account; on that path
 * the creds are (re-)minted even if a (stale, old-account) creds file exists.
 */
export function planMakeLive(inputs: MakeLiveInputs): {
  credsNeeded: boolean;
  resolverNeeded: boolean;
  natsRestartNeeded: boolean;
  daemonRestartNeeded: boolean;
  plan: PlanItem[];
} {
  const { force, state } = inputs;
  const resolverNeeded = force || !state.resolverHasAccount;
  // First migration (resolver absent) ⇒ mint regardless of a stale creds file.
  const credsNeeded = force || !state.resolverHasAccount || !state.credsFileExists;
  const natsRestartNeeded = resolverNeeded;
  const daemonRestartNeeded = credsNeeded || natsRestartNeeded;

  const plan: PlanItem[] = [
    {
      step: "resolver_preload account",
      status: resolverNeeded ? "wire" : "ok",
      detail: `${inputs.agentsAccountName} (${inputs.agentsAccountPubkey}) → ${inputs.natsConfigPath}`,
    },
    {
      step: "nats-server restart",
      status: natsRestartNeeded ? "restart" : "ok",
      detail: inputs.natsConfigPath,
    },
    {
      step: "bus creds (agents account)",
      status: credsNeeded ? "mint" : "ok",
      detail: `${inputs.botName} @ ${inputs.agentsAccountName} → ${inputs.credsPath}`,
    },
    {
      step: "cortex daemon restart",
      status: daemonRestartNeeded ? "restart" : "ok",
      detail: inputs.cortexConfigPath,
    },
  ];
  return { credsNeeded, resolverNeeded, natsRestartNeeded, daemonRestartNeeded, plan };
}

function renderPlanLine(item: PlanItem): string {
  return `[${item.status.padEnd(8)}] ${item.step.padEnd(28)} ${item.detail}`;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Land a provisioned stack's daemon onto its agents account. Pure over `ports`;
 * NEVER throws (port failures surface as `{ ok: false, reason }`).
 *
 * Dry-run (`apply === false`): returns the plan; mutates nothing.
 * Apply: resolver append → creds mint → nats restart → daemon restart, fail-fast.
 */
export async function makeLiveStack(
  inputs: MakeLiveInputs,
  ports: MakeLivePorts,
): Promise<MakeLiveResult> {
  // Guard: the agents account must have been provisioned first.
  if (inputs.agentsAccountPubkey === "") {
    return {
      ok: false,
      applied: false,
      plan: [],
      reason:
        "stack.nats_infra.agents_account is not set — run `cortex network provision " +
        `${inputs.stackSlug} --apply` + "` first to mint the account tree.",
      steps: [],
    };
  }

  const { credsNeeded, resolverNeeded, natsRestartNeeded, daemonRestartNeeded, plan } =
    planMakeLive(inputs);
  const planLines = plan.map(renderPlanLine);

  if (!inputs.apply) {
    return {
      ok: true,
      applied: false,
      plan,
      steps: [
        ...planLines,
        "",
        credsNeeded || resolverNeeded
          ? "Re-run with --apply to land the daemon on its agents account."
          : "Already live on the agents account — nothing to do (re-run with --force to re-mint).",
      ],
    };
  }

  const steps: string[] = [];

  // 1. Teach the NATS server the agents account (append to resolver_preload).
  if (resolverNeeded) {
    const exported = await ports.accountExport.exportAccount(inputs.agentsAccountName);
    if (!exported.ok) return fail(plan, steps, `export-account failed: ${exported.reason}`);
    const appended = ports.resolver.appendAccount({
      natsConfigPath: inputs.natsConfigPath,
      accountName: inputs.agentsAccountName,
      accountPubkey: inputs.agentsAccountPubkey,
      accountJwt: exported.jwt,
    });
    if (!appended.ok) return fail(plan, steps, `resolver_preload append failed: ${appended.reason}`);
    steps.push(
      appended.changed
        ? `resolver_preload: appended ${inputs.agentsAccountName} (${inputs.agentsAccountPubkey})`
        : `resolver_preload: ${inputs.agentsAccountName} already present (no-op)`,
    );
  } else {
    steps.push(`resolver_preload: ${inputs.agentsAccountName} already present (no-op)`);
  }

  // 2. Restart the nats-server so the MEMORY resolver loads the new account.
  //    Done BEFORE minting the daemon's new creds so there is never a window
  //    where the creds on disk name an account the running server doesn't yet
  //    know (which would surface a transient own-auth Authorization Violation if
  //    the live daemon reconnected in that window). Both the OLD shared account
  //    and the new agents account coexist in the resolver across this restart,
  //    so the still-running daemon (on its OLD creds) reconnects cleanly.
  if (natsRestartNeeded) {
    const r = await ports.restart.restartNats(inputs.natsConfigPath);
    if (!r.ok) return fail(plan, steps, `nats-server restart failed: ${r.reason}`);
    steps.push(`nats-server restarted (loaded ${inputs.agentsAccountName} into MEMORY resolver)`);
  }

  // 3. Mint the daemon's bus creds under the agents account (server now knows it).
  if (credsNeeded) {
    const minted = await ports.creds.mint({
      botName: inputs.botName,
      account: inputs.agentsAccountName,
      credsPath: inputs.credsPath,
      force: inputs.force,
    });
    if (!minted.ok) return fail(plan, steps, `creds mint failed: ${minted.reason}`);
    steps.push(`bus creds minted: ${inputs.botName} @ ${inputs.agentsAccountName} → ${minted.credsPath} (chmod 600)`);
  } else {
    steps.push(`bus creds present (untouched): ${inputs.credsPath}`);
  }

  // 4. Restart the cortex daemon so it reconnects with the new creds.
  if (daemonRestartNeeded) {
    const r = await ports.restart.restartDaemon(inputs.cortexConfigPath);
    if (!r.ok) return fail(plan, steps, `cortex daemon restart failed: ${r.reason}`);
    steps.push(`cortex daemon restarted — reconnecting under ${inputs.agentsAccountName}`);
  }

  if (!credsNeeded && !resolverNeeded) {
    steps.push("");
    steps.push("Already live on the agents account — nothing changed.");
  } else {
    steps.push("");
    steps.push(`Landed ${inputs.stackId} on ${inputs.agentsAccountName}.`);
    steps.push(
      "Verify: the nats-server /connz?auth=true shows this stack's connection under the agents account, " +
        "and the daemon log carries 0 own-auth Authorization Violation.",
    );
  }

  return { ok: true, applied: true, plan, steps };
}

function fail(plan: PlanItem[], steps: string[], reason: string): MakeLiveResult {
  // Surface the steps accumulated so far so a mid-pipeline abort shows how far
  // make-live got (mirrors network-provision-lib's fail()).
  return { ok: false, reason, applied: true, plan, steps };
}
