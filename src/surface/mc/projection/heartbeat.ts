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
 * seen 4s ago" derives from the heartbeat event's timestamp + the payload's
 * `last_activity_ms_ago`.
 *
 * **One latest-heartbeat row per session (#862 review — bounded growth).**
 * Liveness only needs "last seen", and `system.agent.heartbeat` is the busiest
 * event source in the system (a 30 s tick → ~120 rows/hr/session), with NO
 * server-side `events` retention. Appending a fresh row per tick would silently
 * make heartbeats the dominant table writer and grow linearly with session
 * duration (events#864). So we keep EXACTLY ONE heartbeat event per session:
 *   - INSERT when the session has no heartbeat row yet;
 *   - UPDATE that single row in place on every later tick (payload + timestamp
 *     refreshed) — O(1) per session, not O(ticks).
 * The update is GUARDED on `iteration`: an out-of-order OLDER tick (a redelivered
 * or reordered earlier heartbeat) MUST NOT regress the row to stale liveness, so
 * we only overwrite when the incoming `iteration` is `>=` the stored one. (`>=`
 * not `>`: an exact redelivery of the latest tick is idempotently re-applied,
 * which is harmless and keeps the timestamp fresh.)
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
import { findAnchorSession } from "./anchor";

const HEARTBEAT_TYPE = "system.agent.heartbeat";

export interface ProjectableHeartbeatEnvelope {
  id?: string;
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface HeartbeatProjectionResult {
  /** MC session the liveness touch landed on. */
  sessionId: string;
  /** The heartbeat tick iteration now recorded on the session's liveness row. */
  iteration: number;
  /** ms since last activity, echoed from the payload. */
  lastActivityMsAgo: number;
  /** The MC event id created (or updated in place). */
  eventId: string;
}

/**
 * Project one `system.agent.heartbeat` envelope into a liveness touch. Returns
 * null for a non-heartbeat type, a malformed payload, an unjoinable heartbeat
 * (no projected dispatch anchor), or an out-of-order OLDER tick that would
 * regress the session's recorded liveness.
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

    // ONE latest-heartbeat row per session. Find the session's existing
    // heartbeat row (there is at most one — this invariant is maintained here).
    const existing = db
      .query(
        `SELECT id, json_extract(payload, '$.iteration') AS iteration
         FROM events
         WHERE session_id = ? AND type = ?
         LIMIT 1`,
      )
      .get(sessionId, HEARTBEAT_TYPE) as
      | { id: string; iteration: number | null }
      | null;

    if (existing !== null) {
      const storedIteration =
        typeof existing.iteration === "number" ? existing.iteration : -1;
      // Out-of-order OLDER tick → do NOT regress the recorded liveness. `>=`
      // tolerates an exact redelivery of the latest tick (idempotent refresh).
      if (iteration < storedIteration) {
        return { sessionId, iteration: storedIteration, lastActivityMsAgo, eventId: existing.id };
      }
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
