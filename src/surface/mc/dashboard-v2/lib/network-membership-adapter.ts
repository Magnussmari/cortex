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
  NetworkConfidentialityDTO,
  NetworkMembershipDTO,
  PeerAcceptance,
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

// --- MC-A2: per-principal acceptance (the second trust layer) ---------------

/**
 * Stable, non-localized acceptance token — for `data-*` attributes, automation,
 * and tests. Distinct from the human `label`.
 */
export type AcceptanceToken =
  | "self"
  | "accepted-network"
  | "accepted-named"
  | "not-accepted";

/** A render-ready acceptance badge. */
export interface AcceptanceBadge {
  label: string;
  tone: VerdictTone;
  /** Stable token (data-* / tests); never localized. */
  token: AcceptanceToken;
  title: string;
}

/**
 * Map a member's {@link PeerAcceptance} → a badge. Acceptance is the SECOND
 * trust layer (CONTEXT.md §"Joining a network"): admission grants membership,
 * accept-policy CHOOSES whom this principal trusts. `self` and the two accepted
 * variants render quietly (ok/dim); `not-accepted` is surfaced (warn) so a peer
 * that is admitted-but-not-accepted is VISIBLE — you dispatch it no federated
 * work despite it being on the roster. Total over the union (compiler-enforced).
 */
export function acceptanceBadge(accepts: PeerAcceptance): AcceptanceBadge {
  switch (accepts) {
    case "self":
      return {
        label: "you",
        tone: "ok",
        token: "self",
        title: "The serving principal — itself an admitted member",
      };
    case "accepted-network":
      return {
        label: "accepted",
        tone: "ok",
        token: "accepted-network",
        title:
          "Accepted: a federated offering trusts this network's whole roster (accept-policy network:<id>)",
      };
    case "accepted-named":
      return {
        label: "accepted",
        tone: "ok",
        token: "accepted-named",
        title:
          "Accepted: this principal is named in a federated offering's accept-policy (principals:[…])",
      };
    case "not-accepted":
      return {
        label: "not accepted",
        tone: "warn",
        token: "not-accepted",
        title:
          "Admitted to the roster but NOT accepted by this principal — no federated offering admits it (default-deny). You dispatch it no federated work.",
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

// --- MC-A3: per-network confidentiality posture (ADR-0019/0018) -------------

/**
 * Stable, non-localized posture token — for `data-*` attributes, automation, and
 * tests. Distinct from the human `label`.
 */
export type ConfidentialityPostureToken =
  | "encrypted" // enabled + key held — sealed, transition window (cleartext-in still accepted)
  | "encrypted-required" // required + key held — sealed, cleartext-in REJECTED
  | "cleartext" // mode off — signed, not sealed
  | "degraded" // enabled/required but NO key — publishing cleartext-with-warning (the honesty hinge)
  | "unknown"; // posture not reported (older/stale server) — never assume encrypted

/** A render-ready confidentiality badge. */
export interface ConfidentialityBadge {
  label: string;
  tone: VerdictTone;
  /** Stable posture token (data-* / tests); never localized. */
  posture: ConfidentialityPostureToken;
  /** Tooltip / aria description. */
  title: string;
}

/** `(key <kid>)` suffix for a title when a key-id is known; else empty. */
function keyIdSuffix(c: NetworkConfidentialityDTO): string {
  return c.key_id ? ` (key ${c.key_id})` : "";
}

/**
 * Map a network's confidentiality posture → a badge. READ-ONLY HONESTY: it
 * NEVER badges "encrypted" unless a key is actually held. The two load-bearing
 * cases the surface must not blur (ADR-0019):
 *
 *   - `enabled`/`required` but NO key → `degraded` (the runtime publishes
 *     cleartext-with-warning, ADR-0019 §5) — flagged `danger`, never "encrypted".
 *   - posture absent (older/stale server) → `unknown` — never assumed encrypted.
 *
 * Total over the `EncryptionMode` union: the `default` branch assigns `c.mode` to
 * `never`, so adding a mode without a case is a COMPILE error (the project does
 * not set `noImplicitReturns`, so this `never` assignment — not the switch shape —
 * is what enforces totality). The runtime fallback is "unknown", never "encrypted".
 */
export function confidentialityBadge(
  c: NetworkConfidentialityDTO | undefined,
): ConfidentialityBadge {
  if (c === undefined) {
    return {
      label: "encryption: unknown",
      tone: "warn",
      posture: "unknown",
      title:
        "Confidentiality posture not reported by the server — not assumed encrypted (ADR-0019).",
    };
  }
  // Honesty hinge: configured-to-seal but no key ⇒ NOT actually sealing.
  if ((c.mode === "enabled" || c.mode === "required") && !c.key_present) {
    return {
      label: "encryption: no key",
      tone: "danger",
      posture: "degraded",
      title:
        `Network is configured 'encryption: ${c.mode}' but no payload key (K) is present — ` +
        "federated payloads publish in CLEARTEXT with a warning (ADR-0019 §5). Not sealed.",
    };
  }
  switch (c.mode) {
    case "required":
      return {
        label: "encrypted (required)",
        tone: "ok",
        posture: "encrypted-required",
        title:
          `Federated payloads sealed with the per-network key${keyIdSuffix(c)} (ADR-0019); ` +
          "cleartext inbound is REJECTED.",
      };
    case "enabled":
      return {
        label: "encrypted",
        tone: "ok",
        posture: "encrypted",
        title:
          `Federated payloads sealed with the per-network key${keyIdSuffix(c)} (ADR-0019); ` +
          "cleartext-but-signed inbound still accepted (transition window).",
      };
    case "off":
      return {
        label: "cleartext",
        tone: "warn",
        posture: "cleartext",
        title:
          "Federated payloads cross in cleartext (signed, not sealed) — encryption is off (ADR-0019).",
      };
    default: {
      // Exhaustiveness guard: a new EncryptionMode must add a case above, or this
      // assignment fails to compile. Runtime fallback degrades to "unknown" — it
      // NEVER claims "encrypted" for an unrecognized mode (the honesty invariant).
      const _exhaustive: never = c.mode;
      return {
        label: "encryption: unknown",
        tone: "warn",
        posture: "unknown",
        title: `Unrecognized encryption mode '${String(_exhaustive)}' — not assumed encrypted (ADR-0019).`,
      };
    }
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
