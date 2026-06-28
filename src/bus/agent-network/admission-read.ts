/**
 * MC-A1 (cortex#1275) — the **admission-rows** read: the ADR-0018 Q3 source of
 * truth for network membership.
 *
 * ## Why this exists (and why NOT `roster-read.ts`)
 *
 * A network is a **roster of admitted principals** (CONTEXT.md §188). ADR-0018
 * **Q3** is emphatic: the roster `members[]` are sourced from **ADMITTED
 * admission rows**, *not* from announced capabilities — "capabilities are an
 * orthogonal facet … never the thing that confers membership."
 *
 * The existing registry roster read (`roster-read.ts` → `resolveNetworkRoster`,
 * #1086) consumes `GET /networks/{id}/roster`, whose `members[]` the registry
 * STILL documents as **capability-derived**
 * (`src/services/network-registry/src/types.ts` `NetworkRoster`: "membership is
 * implicit: a principal is in a network if any of their capabilities lists that
 * network"). Building a *membership* verdict on that read would conflate
 * capability with membership — exactly the bug class ADR-0015/0018 warn against.
 * So this module deliberately reads the **admission rows** instead, keyed on the
 * `AdmissionStatus` (`PENDING | ADMITTED | REJECTED | REVOKED`).
 *
 * The Q3-correct *peer* roster read (registry `members[] ← ADMITTED rows`, or an
 * equivalent member-accessible admitted-roster endpoint) is a **registry-side
 * prerequisite** that has not yet landed: today a non-admin member can read only
 * its OWN admission rows (`GET /admission-requests/mine`, a signed PoP read);
 * the FULL roster list (`GET /admission-requests?status=…`) is admin-gated. This
 * module therefore models that reality explicitly via {@link AdmissionRowsResult}
 * `scope` (`"complete"` admin/authoritative vs `"self"` member-PoP) so the
 * caller knows whether a present-but-unlisted principal is a real anomaly
 * (`complete`) or simply unknowable from a self-only read (`self`).
 *
 * ## Reuse target
 *
 * `resolveAdmittedRoster` + the {@link AdmissionRowsProvider} seam are the clean,
 * reusable foundation the admission-state slice (A2, #1276) and the Pier/PENDING
 * queue (B1, #1278) build on — not an inline read. The seam is injected so the
 * orchestration is unit-testable with a fake provider and carries no transport,
 * crypto, or auth specifics itself.
 */

/**
 * Admission lifecycle status, mirroring the registry's `AdmissionStatus`
 * (`src/services/network-registry/src/types.ts`). Re-declared on the consumer
 * side (the registry is a separate deploy target — same redeclare rationale as
 * `src/common/registry/types.ts`).
 */
export type AdmissionStatus = "PENDING" | "ADMITTED" | "REJECTED" | "REVOKED";

/**
 * One admission row, narrowed to the membership-relevant fields. A row binds a
 * principal to a network at a status. `network_id === null` is a network-less
 * registration row (registered-but-not-joined) — never a member of any specific
 * network, so {@link resolveAdmittedRoster} ignores it.
 */
export interface AdmissionRow {
  principal_id: string;
  network_id: string | null;
  status: AdmissionStatus;
}

/**
 * Outcome of a {@link AdmissionRowsProvider} read. Never throws — every failure
 * is a discriminated `ok:false` so a long-running view/reconciler branches
 * without try/catch.
 *
 * `scope` on success distinguishes the two member-readable surfaces:
 *   - `"complete"` — the rows are the FULL network roster (admin-authoritative).
 *     A present principal NOT in the admitted set is a real anomaly.
 *   - `"self"` — the rows are only the caller's OWN admission rows (member PoP
 *     read). The roster is NOT fully known; anomaly detection MUST be suppressed.
 */
export type AdmissionRowsResult =
  | { ok: true; rows: AdmissionRow[]; scope: "complete" | "self" }
  | {
      ok: false;
      reason: "unreachable" | "unauthorized" | "not_configured";
      detail: string;
    };

/**
 * The injected admission-rows read seam. The concrete implementations
 * (self-PoP `/admission-requests/mine`; admin-list `GET /admission-requests`)
 * live with their transport/crypto; this interface is all the orchestration —
 * and the MC endpoint — depend on. Never throws.
 */
export interface AdmissionRowsProvider {
  readAdmissionRows(networkId: string): Promise<AdmissionRowsResult>;
}

/** The reconciled admitted/pending roster for one network, from admission rows. */
export interface AdmittedRoster {
  /** Principal ids whose admission row for this network is `ADMITTED`. */
  admitted: string[];
  /** Principal ids whose admission row for this network is `PENDING`. */
  pending: string[];
  /**
   * True when the underlying read was the COMPLETE roster (admin-authoritative).
   * False for a SELF-only member read — the caller MUST NOT treat a present
   * non-admitted principal as an anomaly, since the roster is not fully known.
   */
  authoritative: boolean;
}

/** Outcome of {@link resolveAdmittedRoster}. Never throws. */
export type ResolveAdmittedRosterResult =
  | { ok: true; roster: AdmittedRoster }
  | {
      ok: false;
      reason: "unreachable" | "unauthorized" | "not_configured";
      detail: string;
    };

function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolve "who is ADMITTED / PENDING on `networkId`" from the **admission rows**
 * (ADR-0018 Q3 source of truth), via the injected provider.
 *
 * Filters to rows for THIS network (drops network-less registration rows),
 * projects `ADMITTED` → `admitted[]` and `PENDING` → `pending[]` (deduped,
 * first-seen order), and carries the read's `scope` through to
 * `authoritative`. `REJECTED` / `REVOKED` rows are NOT members and are dropped.
 *
 * Pure over its injected provider — no transport, crypto, or auth here.
 */
export async function resolveAdmittedRoster(
  networkId: string,
  provider: AdmissionRowsProvider,
): Promise<ResolveAdmittedRosterResult> {
  const res = await provider.readAdmissionRows(networkId);
  if (!res.ok) {
    return { ok: false, reason: res.reason, detail: res.detail };
  }
  const forNetwork = res.rows.filter((r) => r.network_id === networkId);
  const admitted = dedupePreserveOrder(
    forNetwork.filter((r) => r.status === "ADMITTED").map((r) => r.principal_id),
  );
  const pending = dedupePreserveOrder(
    forNetwork.filter((r) => r.status === "PENDING").map((r) => r.principal_id),
  );
  return {
    ok: true,
    roster: { admitted, pending, authoritative: res.scope === "complete" },
  };
}
