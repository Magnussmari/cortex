/**
 * MC-I1.S6 (#848, ADR-0005 §4) — project `system.agent.heartbeat` envelopes
 * into a liveness touch on the projected session.
 *
 * A heartbeat says "agent X is still working on task Y" (cortex#361). The
 * dispatch-lifecycle projection (S4) keys its session on `correlation_id` (the
 * heartbeat's `payload.correlation_id` / envelope `correlation_id` is the SAME
 * value the review consumer / dispatch handler stamps on the lifecycle
 * envelopes), so a heartbeat JOINS onto the dispatch anchor's session.
 *
 * **Storage decision (stated in the PR): events-table write, NO schema change.**
 * The brief prefers avoiding a `sessions.last_activity` column + REBUILD_MIGRATIONS
 * when the data can ride an existing surface. A heartbeat lands as an `events`
 * row (type `system.agent.heartbeat`) on the joined session — the working grid's
 * recent-events feed already carries the session's last activity, so "Echo last
 * seen 4s ago" derives from the newest heartbeat event's timestamp + the
 * payload's `last_activity_ms_ago`. No new column, no migration.
 *
 * Idempotency: each heartbeat is a distinct tick (the `iteration` counter), so
 * we DON'T dedupe on envelope id — a redelivered heartbeat with the same
 * `(correlation_id, iteration)` is collapsed to one row (latest wins per tick).
 *
 * No-op when no dispatch anchor exists for the correlation_id: a heartbeat for a
 * task MC never saw projected (e.g. the `started` was lost AND no terminal has
 * arrived) has nothing to touch. We do NOT synthesise an anchor from a heartbeat
 * — the lifecycle envelopes own anchor creation; a heartbeat is liveness ON TOP.
 *
 * Non-throwing: malformed payloads / unjoinable heartbeats return null.
 */

import type { Database } from "bun:sqlite";

import { insertEvent } from "../db/events";

const HEARTBEAT_TYPE = "system.agent.heartbeat";
const ANCHOR_TASK_PREFIX = "mc-dispatch-task-";

export interface ProjectableHeartbeatEnvelope {
  id?: string;
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface HeartbeatProjectionResult {
  /** MC session the liveness touch landed on. */
  sessionId: string;
  /** The heartbeat tick iteration. */
  iteration: number;
  /** ms since last activity, echoed from the payload. */
  lastActivityMsAgo: number;
  /** The MC event id created (or updated). */
  eventId: string;
}

function anchorTaskId(correlationId: string): string {
  return `${ANCHOR_TASK_PREFIX}${correlationId}`;
}

/**
 * Project one `system.agent.heartbeat` envelope into a liveness touch. Returns
 * null for a non-heartbeat type, a malformed payload, or an unjoinable
 * heartbeat (no projected dispatch anchor).
 */
export function projectHeartbeat(
  db: Database,
  envelope: ProjectableHeartbeatEnvelope,
): HeartbeatProjectionResult | null {
  if (envelope.type !== HEARTBEAT_TYPE) return null;

  const rawPayload: unknown = envelope.payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  // correlation_id is the dispatch anchor key (envelope-level OR payload — both
  // carry it per cortex#361; prefer the envelope field, fall back to payload).
  const correlationId =
    asString(envelope.correlation_id) ?? asString(payload.correlation_id);
  if (correlationId === null) return null;

  const agentId = asString(payload.agent_id) ?? "agent";
  const phase = asString(payload.phase) ?? "thinking";
  const iteration = asNumber(payload.iteration) ?? 0;
  const lastActivityMsAgo = asNumber(payload.last_activity_ms_ago) ?? 0;

  const txn = db.transaction((): HeartbeatProjectionResult | null => {
    const sessionId = findAnchorSession(db, correlationId);
    if (sessionId === null) {
      // Unjoinable — the lifecycle anchor isn't projected yet. Liveness rides
      // on top of the anchor; we don't synthesise one from a heartbeat.
      return null;
    }

    const eventPayload: Record<string, unknown> = {
      agent_id: agentId,
      phase,
      iteration,
      last_activity_ms_ago: lastActivityMsAgo,
      correlation_id: correlationId,
    };

    // Collapse to one row per (session, iteration): a redelivered tick updates
    // the existing row's payload rather than appending a duplicate. Distinct
    // ticks (new iteration) append fresh, giving the grid a monotonic liveness
    // trail without unbounded growth on redelivery.
    const existing = db
      .query(
        `SELECT id FROM events
         WHERE session_id = ? AND type = ?
           AND json_extract(payload, '$.iteration') = ?
         LIMIT 1`,
      )
      .get(sessionId, HEARTBEAT_TYPE, iteration) as { id: string } | null;

    if (existing !== null) {
      db.query(
        `UPDATE events SET payload = ?, timestamp = ? WHERE id = ?`,
      ).run(
        JSON.stringify(eventPayload),
        new Date().toISOString(),
        existing.id,
      );
      return { sessionId, iteration, lastActivityMsAgo, eventId: existing.id };
    }

    const ev = insertEvent(db, {
      sessionId,
      type: HEARTBEAT_TYPE,
      payload: eventPayload,
    });
    return { sessionId, iteration, lastActivityMsAgo, eventId: ev.id };
  });

  return txn();
}

function findAnchorSession(db: Database, correlationId: string): string | null {
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
