/**
 * MC-I1.S6 (#848) — shared dispatch-anchor join (the #862-review cheap-fold 1).
 *
 * S4's dispatch-lifecycle projection anchors one MC task per dispatch
 * `correlation_id` under the deterministic id `mc-dispatch-task-{correlation_id}`,
 * with a non-cancelled assignment → most-recent session hanging off it. The S6
 * verdict + heartbeat projections JOIN onto that anchor's session by the SAME
 * correlation_id (the review consumer / dispatch handler stamp it on the
 * verdict / heartbeat envelopes too).
 *
 * The `ANCHOR_TASK_PREFIX` constant + the correlation_id→anchor-task→session
 * `SELECT` were copy-pasted across three sites (dispatch-lifecycle.ts,
 * review-verdict.ts, heartbeat.ts) — slightly ironic in a slice whose theme is
 * the `ensureAgentRow` DRY pickup (#861 finding 3). This module is the single
 * home: a schema change to the anchor join (the `agent_task_assignment` /
 * `sessions` shape, or the tiebreak) now lands in ONE place.
 */

import type { Database } from "bun:sqlite";

/**
 * Deterministic MC task id prefix for a dispatch correlation_id. One MC task per
 * dispatch (`dispatch-lifecycle.ts` mints `${ANCHOR_TASK_PREFIX}${correlationId}`
 * on `started`; the verdict / heartbeat joins read it back).
 */
export const ANCHOR_TASK_PREFIX = "mc-dispatch-task-";

/** The deterministic anchor-task id for a correlation_id. */
export function anchorTaskId(correlationId: string): string {
  return `${ANCHOR_TASK_PREFIX}${correlationId}`;
}

/**
 * Find the dispatch anchor's session for a `correlation_id`: the anchor task →
 * its assignment → most-recent session (the `ORDER BY s.started_at DESC, s.id
 * DESC LIMIT 1` tiebreak matches `dispatch-lifecycle.ts`'s own anchor lookup so
 * verdict/heartbeat land on the SAME session the lifecycle projection drives).
 * Returns the session id, or null when no anchor exists for the correlation_id.
 */
export function findAnchorSession(
  db: Database,
  correlationId: string,
): string | null {
  const row = db
    .query(
      `SELECT s.id AS session_id
       FROM agent_task_assignment a
       JOIN sessions s ON s.assignment_id = a.id
       WHERE a.task_id = ?
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT 1`,
    )
    .get(anchorTaskId(correlationId)) as { session_id: string } | null;
  return row ? row.session_id : null;
}
