/**
 * MC-I1.S6 (#848, the deferred #861-review finding-3 DRY pickup) — single
 * `agents` upsert helper.
 *
 * Three sites independently INSERT-OR-IGNORE an `agents` row with the same
 * insert-only-name semantics:
 *   - `ensureNamedAgent`  (api/handlers.ts)  — F-20 observed sessions; head/persistent.
 *   - `ensureOrphanAgent` (db/sessions.ts)   — S5 orphan sessions; head/non-persistent.
 *   - S4's dispatch-anchor copy (projection/dispatch-lifecycle.ts) — head/persistent.
 *
 * They differ only in `type` + `persistent` + the name-fallback rule. Folding
 * the SQL into one helper removes the drift surface flagged in the #861 review
 * (finding 3): a schema change to `agents` (a new column, a CHECK) now lands in
 * one place, not three.
 *
 * **Insert-only name (load-bearing).** `ON CONFLICT(id) DO NOTHING` is the
 * shared contract: the FIRST writer lands the display name; subsequent calls
 * never overwrite it, so a principal-edited name survives re-dispatch /
 * re-observation. Every call site relied on this; the helper preserves it.
 */

import type { Database } from "bun:sqlite";

/** The two `agents.type` values the schema's CHECK constraint allows. */
export type AgentRowType = "head" | "hands";

export interface EnsureAgentRowParams {
  /** Stable agent id (PK). */
  id: string;
  /**
   * Display name. Applied ONLY on insert (the `ON CONFLICT DO NOTHING` keeps a
   * principal-edited name from being clobbered). Callers that want a fallback
   * (e.g. "name or the id") resolve it BEFORE calling — the helper stores the
   * string verbatim.
   */
  name: string;
  /** `agents.type` — `head` runs a task, `hands` is a worker/sentinel. */
  type: AgentRowType;
  /**
   * `agents.persistent` flag. `true` for principal-visible/dispatch agents,
   * `false` for per-orphan ephemeral agents. Stored as 1/0.
   */
  persistent: boolean;
}

/**
 * Idempotently insert an `agents` row. No-op when the id already exists (the
 * existing row — including a principal-edited name — is preserved). Returns the
 * id for call-site ergonomics (mirrors the prior helpers' return shape).
 */
export function ensureAgentRow(db: Database, params: EnsureAgentRowParams): string {
  db.query(
    `INSERT INTO agents (id, name, type, persistent)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(params.id, params.name, params.type, params.persistent ? 1 : 0);
  return params.id;
}
