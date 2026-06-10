/**
 * MC-I1.S4 (ADR-0005 §3/§4) — tests for the dispatch-lifecycle projection.
 *
 * The projection is the bus→MC seam: it turns `dispatch.task.*` lifecycle
 * envelopes into MC session/assignment/task rows so dispatch-spawned work
 * appears live on the working grid (started) and transitions on terminal —
 * with the authoritative `cc_session_id` backfilled onto the SAME session the
 * S5 ingestor's hook events join onto (not a duplicate orphan).
 *
 * Coverage axes (per the slice brief's TDD list):
 *   1. Full lifecycle started→completed: anchor created, assignment running
 *      then completed, cc_session_id backfilled from the terminal payload.
 *   2. failed / aborted map to their terminal assignment states.
 *   3. Idempotent on redelivered envelopes (same correlation_id) — a second
 *      `started` does not create a second task/agent/assignment/session.
 *   4. Orphan-reconciliation: when the S5 ingestor already orphan-registered
 *      the cc_session_id (hook events raced ahead of the terminal envelope),
 *      the projection adopts the orphan's session + events into the projected
 *      assignment rather than leaving two rows.
 *   5. Resume-divergence: `started` carries the prior session's id, the
 *      terminal carries the authoritative id — terminal wins.
 *   6. Non-dispatch envelope types are ignored.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import { registerOrphanSession } from "../db/sessions";
import { ingestEvents } from "../hooks/ingestor";
import type { RawHookEvent } from "../hooks/types";
import { projectDispatchLifecycle } from "../projection/dispatch-lifecycle";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskCompletedEvent,
  createDispatchTaskFailedEvent,
  createDispatchTaskAbortedEvent,
  type DispatchEventSource,
} from "../../../bus/dispatch-events";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CC_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESUME_PRIOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STARTED_AT = new Date("2026-06-10T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-06-10T12:05:00.000Z");

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

interface SessionRow {
  id: string;
  assignment_id: string;
  cc_session_id: string | null;
  endpoint_kind: string;
  ended_at: string | null;
}

function sessionsFor(db: Database): SessionRow[] {
  return db
    .query(
      `SELECT id, assignment_id, cc_session_id, endpoint_kind, ended_at FROM sessions`,
    )
    .all() as SessionRow[];
}

function assignmentState(db: Database, assignmentId: string): string {
  const row = db
    .query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
    .get(assignmentId) as { state: string } | null;
  if (!row) throw new Error(`assignment ${assignmentId} not found`);
  return row.state;
}

function makeStarted(opts: { ccSessionId?: string } = {}): Envelope {
  return createDispatchTaskStartedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
    ...(opts.ccSessionId !== undefined && { ccSessionId: opts.ccSessionId }),
  });
}

function makeCompleted(opts: { ccSessionId?: string } = {}): Envelope {
  return createDispatchTaskCompletedEvent({
    source: SOURCE,
    taskId: TASK_ID,
    agentId: "cortex",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    resultSummary: "done",
    ...(opts.ccSessionId !== undefined && { ccSessionId: opts.ccSessionId }),
  });
}

function makeRawEvent(eventId: string, ccSessionId: string): RawHookEvent {
  return {
    event_id: eventId,
    event_type: "tool.bash",
    timestamp: new Date().toISOString(),
    session_id: ccSessionId,
    agent_id: "cortex",
    agent_name: "Cortex",
    source: { hook: "PostToolUse", tool_name: "tool.bash" },
    payload: { test: true },
  };
}

describe("projectDispatchLifecycle", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("started creates the anchor: task + agent + assignment(dispatched) + session keyed on correlation_id", () => {
    const res = projectDispatchLifecycle(db, makeStarted());
    expect(res).not.toBeNull();

    const sessions = sessionsFor(db);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    // cc_session_id is PENDING at started for a fresh dispatch (no resume id).
    expect(session.cc_session_id).toBeNull();
    // Dispatch-spawned work is controlled, not observed.
    expect(session.endpoint_kind).toBe("local.process.controlled");

    // Assignment born then driven to running by the started projection so the
    // working grid shows the session as active.
    expect(assignmentState(db, session.assignment_id)).toBe("running");

    // The dispatched agent row exists.
    const agent = db
      .query(`SELECT id FROM agents WHERE id = ?`)
      .get("cortex") as { id: string } | null;
    expect(agent).not.toBeNull();
  });

  it("idempotent on redelivered started (same correlation_id) — no duplicate rows", () => {
    projectDispatchLifecycle(db, makeStarted());
    projectDispatchLifecycle(db, makeStarted());

    expect(sessionsFor(db)).toHaveLength(1);
    const assignments = db
      .query(`SELECT id FROM agent_task_assignment`)
      .all() as { id: string }[];
    expect(assignments).toHaveLength(1);
    const tasks = db.query(`SELECT id FROM tasks`).all() as { id: string }[];
    expect(tasks).toHaveLength(1);
  });

  it("full lifecycle started→completed: transitions to completed and backfills authoritative cc_session_id", () => {
    projectDispatchLifecycle(db, makeStarted());
    const res = projectDispatchLifecycle(db, makeCompleted({ ccSessionId: CC_SESSION }));
    expect(res).not.toBeNull();

    const sessions = sessionsFor(db);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.cc_session_id).toBe(CC_SESSION);
    expect(assignmentState(db, session.assignment_id)).toBe("completed");
  });

  it("failed maps the assignment to 'failed'", () => {
    projectDispatchLifecycle(db, makeStarted());
    projectDispatchLifecycle(
      db,
      createDispatchTaskFailedEvent({
        source: SOURCE,
        taskId: TASK_ID,
        agentId: "cortex",
        startedAt: STARTED_AT,
        failedAt: COMPLETED_AT,
        errorSummary: "boom",
        ccSessionId: CC_SESSION,
      }),
    );
    const session = sessionsFor(db)[0]!;
    expect(assignmentState(db, session.assignment_id)).toBe("failed");
    expect(session.cc_session_id).toBe(CC_SESSION);
  });

  it("aborted maps the assignment to 'cancelled'", () => {
    projectDispatchLifecycle(db, makeStarted());
    projectDispatchLifecycle(
      db,
      createDispatchTaskAbortedEvent({
        source: SOURCE,
        taskId: TASK_ID,
        agentId: "cortex",
        startedAt: STARTED_AT,
        abortedAt: COMPLETED_AT,
        reason: "timeout",
        ccSessionId: CC_SESSION,
      }),
    );
    const session = sessionsFor(db)[0]!;
    expect(assignmentState(db, session.assignment_id)).toBe("cancelled");
    expect(session.cc_session_id).toBe(CC_SESSION);
  });

  it("resume-divergence: started's prior cc id is provisional; the terminal id wins", () => {
    // Resume dispatch — started carries the PRIOR session id.
    projectDispatchLifecycle(db, makeStarted({ ccSessionId: RESUME_PRIOR }));
    let session = sessionsFor(db)[0]!;
    expect(session.cc_session_id).toBe(RESUME_PRIOR);

    // Terminal carries the authoritative (post-resume) id — it must overwrite.
    projectDispatchLifecycle(db, makeCompleted({ ccSessionId: CC_SESSION }));
    session = sessionsFor(db)[0]!;
    expect(session.cc_session_id).toBe(CC_SESSION);
    expect(assignmentState(db, session.assignment_id)).toBe("completed");
  });

  it("orphan-reconciliation: an S5 orphan for the terminal cc_session_id is adopted, not duplicated", () => {
    // started anchors the projection (cc_session_id pending).
    projectDispatchLifecycle(db, makeStarted());

    // Hook events race ahead of the terminal envelope: S5's ingestor
    // orphan-registers the cc_session_id and ingests its events.
    const ingest = ingestEvents(db, [
      makeRawEvent("e-1", CC_SESSION),
      makeRawEvent("e-2", CC_SESSION),
    ]);
    expect(ingest.count).toBe(2);

    // Two sessions exist right now: the projected placeholder (cc pending) and
    // the orphan (cc = CC_SESSION, with the hook events).
    expect(sessionsFor(db)).toHaveLength(2);

    // Terminal envelope carries the authoritative cc_session_id — the
    // projection MUST reconcile to a SINGLE session, not leave two.
    projectDispatchLifecycle(db, makeCompleted({ ccSessionId: CC_SESSION }));

    const sessions = sessionsFor(db).filter((s) => s.cc_session_id === CC_SESSION);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;

    // The reconciled session belongs to the PROJECTED assignment, which is
    // transitioned to completed.
    expect(assignmentState(db, session.assignment_id)).toBe("completed");

    // The orphan's hook events survived the merge — they now hang off the
    // reconciled session.
    const eventCount = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`)
      .get(session.id) as { n: number };
    expect(eventCount.n).toBeGreaterThanOrEqual(2);

    // No dangling duplicate carrying the same cc_session_id.
    const allWithCc = sessionsFor(db).filter(
      (s) => s.cc_session_id === CC_SESSION,
    );
    expect(allWithCc).toHaveLength(1);
  });

  it("ignores non-dispatch envelope types", () => {
    const notDispatch: Envelope = {
      ...makeStarted(),
      type: "system.heartbeat",
    };
    const res = projectDispatchLifecycle(db, notDispatch);
    expect(res).toBeNull();
    expect(sessionsFor(db)).toHaveLength(0);
  });

  it("terminal without a prior started still anchors then transitions (out-of-order delivery)", () => {
    // A terminal envelope can arrive before/without the started (lost started,
    // or reordered delivery). The projection should still anchor + transition.
    const res = projectDispatchLifecycle(db, makeCompleted({ ccSessionId: CC_SESSION }));
    expect(res).not.toBeNull();
    const session = sessionsFor(db)[0]!;
    expect(session.cc_session_id).toBe(CC_SESSION);
    expect(assignmentState(db, session.assignment_id)).toBe("completed");
  });
});
