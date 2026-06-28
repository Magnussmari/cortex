/**
 * MC-A1 (cortex#1275) — pure membership-reconciliation logic for the MC Network
 * view's "networks as first-class trust groups" surface.
 *
 * A network is a **roster of admitted principals** (CONTEXT.md §188; ADR-0015 /
 * ADR-0018). The registry is the **source of truth** for that roster: its
 * `members[]` come from ADMITTED admission rows, NOT from announced capabilities
 * (ADR-0018 Q3). Capabilities are an orthogonal facet — what an admitted member
 * *offers*, never the thing that *confers* membership. This module therefore
 * NEVER reads or considers capabilities; it reconciles the admitted **roster
 * (intent)** against observed **presence (reality)** into a per-member
 * **membership verdict**.
 *
 * ## The reconciliation (intent ⋈ reality)
 *
 *   - **intent**  — the admitted-principal roster (from the registry; the
 *     endpoint injects the local/serving principal too, since a joined stack is
 *     itself a member).
 *   - **reality** — which principals we actually observe present, derived from
 *     the in-memory agent-presence registry. Presence is keyed by the
 *     **verified origin** `{principal}` (the ADR-0003 roster identity), NEVER an
 *     attacker-controlled wire token (mirrors `network-graph-adapter`'s
 *     origin-grouping rule).
 *
 * The verdict per member:
 *   - `admitted-present`        — on the roster AND observed present.
 *   - `admitted-absent`         — on the roster but not observed present.
 *   - `present-but-unadmitted`  — observed present (federated) but on no roster
 *                                 — an ANOMALY worth surfacing (e.g. a stale
 *                                 roster, or a hand-pinned static peer with no
 *                                 registry admission).
 *   - `pending`                 — a pending admission request, not yet admitted.
 *                                 (A1 has no pending source — the registry
 *                                 roster carries ADMITTED rows only — so the
 *                                 endpoint passes none; the verdict exists so
 *                                 A2/A3/B build on a complete model.)
 *
 * Pure + dependency-light: no I/O, no bus, no registry client. The only import
 * is the structural presence-record TYPE from the sibling `/api/agents`
 * contract, so the reality-derivation helper can read a snapshot. Trivially
 * unit-testable.
 */

import type { AgentPresenceSnapshotRecord } from "./agents";

/**
 * The reconciled standing of one principal against a network's admitted roster.
 * See the module header for the precise semantics of each value.
 */
export type MembershipVerdict =
  | "admitted-present"
  | "admitted-absent"
  | "present-but-unadmitted"
  | "pending";

/** One reconciled roster member: a principal + its membership verdict. */
export interface MembershipMember {
  /** The member principal id (the roster is principal-keyed; ADR-0018 Q3). */
  principal: string;
  /** Reconciled standing of this principal against the roster ⋈ presence. */
  verdict: MembershipVerdict;
  /**
   * Stacks of this principal observed present (verified-origin-keyed), sorted +
   * deduped. Empty for an absent or pending-without-presence member. Presence
   * detail only — never a session interior (ADR-0007).
   */
  presentStacks: string[];
}

/** Inputs to {@link reconcileNetworkMembership} — one network's intent ⋈ reality. */
export interface ReconcileMembershipInput {
  /**
   * Admitted principal ids for THIS network (the registry roster = source of
   * truth, ADR-0018 Q3). The endpoint injects the serving principal here too: a
   * joined stack is itself an admitted member of the network. Order is
   * preserved in the output (deduped first-seen).
   */
  admitted: readonly string[];
  /**
   * Reality: principal → the stacks of that principal observed present. Keyed by
   * the VERIFIED origin principal (never a wire token). A principal is "present"
   * iff it has a non-empty entry here.
   */
  presentStacksByPrincipal: ReadonlyMap<string, readonly string[]>;
  /**
   * Principals with a PENDING admission request (B2 source). Empty in A1 — the
   * registry roster carries ADMITTED rows only. A pending principal that is also
   * admitted is treated as admitted (the roster wins).
   */
  pending?: readonly string[];
  /**
   * Foreign principals present that THIS network should consider for the
   * `present-but-unadmitted` anomaly. The endpoint supplies only principals
   * admitted to NO joined network, so a peer admitted on another network is not
   * falsely flagged as an anomaly here. A present principal already in
   * `admitted` / `pending` is never an anomaly.
   */
  anomalyCandidates?: readonly string[];
}

/**
 * Reconcile one network's admitted roster (intent) against observed presence
 * (reality) into a per-member verdict list.
 *
 * Ordering is deterministic + stable: admitted members first (first-seen roster
 * order), then pending (input order), then anomalies (input order). Each
 * principal appears at most once — admitted ⊐ pending ⊐ anomaly precedence.
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function reconcileNetworkMembership(
  input: ReconcileMembershipInput,
): MembershipMember[] {
  const { admitted, presentStacksByPrincipal } = input;
  const pending = input.pending ?? [];
  const anomalyCandidates = input.anomalyCandidates ?? [];

  const seen = new Set<string>();
  const members: MembershipMember[] = [];

  const stacksOf = (principal: string): string[] => {
    const stacks = presentStacksByPrincipal.get(principal);
    if (stacks === undefined || stacks.length === 0) return [];
    // Sorted + deduped for a deterministic, render-stable detail.
    return [...new Set(stacks)].sort();
  };
  const isPresent = (principal: string): boolean =>
    stacksOf(principal).length > 0;

  // 1) Admitted roster (intent). Present → admitted-present, else admitted-absent.
  for (const principal of admitted) {
    if (seen.has(principal)) continue;
    seen.add(principal);
    const presentStacks = stacksOf(principal);
    members.push({
      principal,
      verdict: presentStacks.length > 0 ? "admitted-present" : "admitted-absent",
      presentStacks,
    });
  }

  // 2) Pending admission requests not already admitted (roster wins on overlap).
  for (const principal of pending) {
    if (seen.has(principal)) continue;
    seen.add(principal);
    members.push({
      principal,
      verdict: "pending",
      presentStacks: stacksOf(principal),
    });
  }

  // 3) Anomalies — present but on no roster + not pending. Surfaced so a stale
  //    roster or an un-admitted hand-pinned peer is VISIBLE, never silently
  //    rendered as a member.
  for (const principal of anomalyCandidates) {
    if (seen.has(principal)) continue;
    if (!isPresent(principal)) continue; // only present principals are anomalies
    seen.add(principal);
    members.push({
      principal,
      verdict: "present-but-unadmitted",
      presentStacks: stacksOf(principal),
    });
  }

  return members;
}

/**
 * Derive the presence reality map — principal → present stacks — from an
 * agent-presence snapshot.
 *
 * Trust rule (mirrors `network-graph-adapter.originScope`): a principal/stack is
 * taken from the record's VERIFIED ORIGIN — `localPrincipal` + the record's own
 * stack for a `"local"` agent, or the chain-verified `{principal,stack}` for a
 * `"foreign"` agent — NEVER the wire `principal`/`stack` fields (which a peer
 * could spoof). Only `state: "online"` records count as present (a known-offline
 * agent is not live presence).
 *
 * Returns a map keyed by verified principal → sorted unique present stacks.
 */
export function derivePresentStacksByPrincipal(
  records: readonly AgentPresenceSnapshotRecord[],
  localPrincipal: string,
): Map<string, string[]> {
  const byPrincipal = new Map<string, Set<string>>();
  for (const r of records) {
    if (r.state !== "online") continue;
    const principal = r.origin === "local" ? localPrincipal : r.origin.principal;
    const stack = r.origin === "local" ? r.stack : r.origin.stack;
    let stacks = byPrincipal.get(principal);
    if (stacks === undefined) {
      stacks = new Set<string>();
      byPrincipal.set(principal, stacks);
    }
    stacks.add(stack);
  }
  const out = new Map<string, string[]>();
  for (const [principal, stacks] of byPrincipal) {
    out.set(principal, [...stacks].sort());
  }
  return out;
}

/**
 * The set of FOREIGN principals (cross-principal — not the serving principal)
 * observed present. The endpoint subtracts the union of all admitted rosters
 * from this to compute each network's anomaly candidates. Local + same-principal
 * sibling presence is the serving stack itself, never a federated anomaly, so
 * the serving principal is excluded.
 */
export function foreignPresentPrincipals(
  presentStacksByPrincipal: ReadonlyMap<string, readonly string[]>,
  localPrincipal: string,
): string[] {
  const out: string[] = [];
  for (const principal of presentStacksByPrincipal.keys()) {
    if (principal === localPrincipal) continue;
    out.push(principal);
  }
  return out.sort();
}
