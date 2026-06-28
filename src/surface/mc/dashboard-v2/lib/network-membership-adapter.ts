/**
 * MC-A1 (cortex#1275) — pure presentation adapter for the networks-as-first-class
 * roster panel. Maps the `/api/networks` DTO into render-ready badge/label shapes.
 *
 * Kept out of the React tree so the mapping is unit-testable without a DOM — the
 * panel component consumes the output. Mirrors `network-graph-adapter`'s
 * pure-projection pattern. Carries NO membership logic of its own (the verdict
 * is computed server-side from the admission rows, ADR-0018 Q3); this is purely
 * verdict → visual.
 */

import type {
  MembershipVerdict,
  NetworkMembershipDTO,
  RosterStatus,
  RosterScope,
} from "../../api/networks";

/** Visual tone for a verdict badge — maps to a CSS class on the panel. */
export type VerdictTone = "ok" | "warn" | "danger" | "pending";

/** A render-ready verdict badge. */
export interface VerdictBadge {
  label: string;
  tone: VerdictTone;
  /** Tooltip / aria description. */
  title: string;
}

/**
 * Map a membership verdict → badge. Deterministic + total over the union, so the
 * compiler enforces a case for every verdict (a new verdict won't silently fall
 * through).
 */
export function verdictBadge(verdict: MembershipVerdict): VerdictBadge {
  switch (verdict) {
    case "admitted-present":
      return {
        label: "present",
        tone: "ok",
        title: "Admitted to the roster and observed present",
      };
    case "admitted-absent":
      return {
        label: "absent",
        tone: "warn",
        title: "Admitted to the roster but not observed present",
      };
    case "present-but-unadmitted":
      return {
        label: "unadmitted",
        tone: "danger",
        title:
          "Observed present but on no admitted roster — an anomaly (stale roster or un-admitted peer)",
      };
    case "pending":
      return {
        label: "pending",
        tone: "pending",
        title: "Admission request pending — not yet admitted",
      };
  }
}

/** A human label + tone for the roster read's availability. */
export interface RosterStatusBadge {
  label: string;
  tone: VerdictTone;
  title: string;
}

/**
 * Map a network's `roster_status` (+ `roster_scope`) → a small status chip so it
 * is clear at a glance whether a roster is live + authoritative or self-only /
 * degraded — the registry-Q3 reality is surfaced honestly, never hidden.
 */
export function rosterStatusBadge(
  status: RosterStatus,
  scope: RosterScope | null,
): RosterStatusBadge {
  switch (status) {
    case "ok":
      return scope === "complete"
        ? { label: "roster: complete", tone: "ok", title: "Authoritative admitted roster" }
        : {
            label: "roster: self-only",
            tone: "warn",
            title:
              "Only this stack's own admission is known; peer roster not yet enumerable",
          };
    case "unreachable":
      return {
        label: "registry unreachable",
        tone: "warn",
        title: "Could not reach the registry — showing self membership only",
      };
    case "unauthorized":
      return {
        label: "not authorized",
        tone: "warn",
        title: "This stack is not authorized to read the full roster",
      };
    case "not_configured":
      return {
        label: "roster source pending",
        tone: "warn",
        title:
          "Live admission-rows read not wired (A1) — pending A2 + registry ADR-0018 Q3 roster fix",
      };
  }
}

/** Per-verdict counts for a network's member set (for the panel summary). */
export interface MembershipSummary {
  present: number;
  absent: number;
  unadmitted: number;
  pending: number;
  total: number;
}

/** Tally a network's members by verdict — pure, for the panel header summary. */
export function summarizeMembership(
  net: Pick<NetworkMembershipDTO, "members">,
): MembershipSummary {
  const summary: MembershipSummary = {
    present: 0,
    absent: 0,
    unadmitted: 0,
    pending: 0,
    total: net.members.length,
  };
  for (const m of net.members) {
    switch (m.verdict) {
      case "admitted-present":
        summary.present += 1;
        break;
      case "admitted-absent":
        summary.absent += 1;
        break;
      case "present-but-unadmitted":
        summary.unadmitted += 1;
        break;
      case "pending":
        summary.pending += 1;
        break;
    }
  }
  return summary;
}
