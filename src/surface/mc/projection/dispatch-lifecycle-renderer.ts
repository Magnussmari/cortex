/**
 * MC-I1.S4/S6 (ADR-0005 §4) — the bus→MC projection renderer.
 *
 * §4 makes the bus→MC seam a registered surface-router renderer: a push-based
 * `render(envelope)` rather than the polled DashboardRenderer ring buffer (§4
 * demotes that to, at most, the drill-down's recent-raw-envelopes feed). cortex.ts
 * registers this adapter with the surface-router when `mc.enabled`.
 *
 * The adapter is a single `project(envelope, subject)` dispatcher keyed on
 * `envelope.type`. S4 shipped the `dispatch.task.*` case; **S6 (#848) generalises
 * the seam** to four more families — extending the dispatcher (adding cases),
 * NOT rewriting the renderer, so the surface-router registration and the
 * non-throwing contract stay intact:
 *
 *   | envelope.type                       | handler                          |
 *   |-------------------------------------|----------------------------------|
 *   | `dispatch.task.{started,…}`         | projectDispatchLifecycle (S4)    |
 *   | `review.verdict.{approved,…}`       | projectReviewVerdict             |
 *   | `system.agent.heartbeat`            | projectHeartbeat                 |
 *   | `system.attention.{opened,resolved}`| projectAttention (FEDERATED only)|
 *   | `system.adapter.{degraded,…}`       | projectAdapterLifecycle          |
 *
 * ## Non-throwing contract
 *
 * The surface-router wraps every `render()` in a timeout + `Promise.allSettled`
 * (`renderWithIsolation`), but the Renderer contract (renderers/types.ts §2)
 * ALSO obliges the renderer itself to never throw — a projection error must
 * not poison the dispatch loop. We catch inside `render()` and route failures to
 * stderr, mirroring the DashboardRenderer + ingestor error posture.
 *
 * ## WS push (S6 — closes the S4-documented gap)
 *
 * The MC server's WebSocket broadcasts on state transitions via a
 * `WsClientRegistry`. S4's projection writes bypassed that fan-out, so a
 * freshly-projected change wouldn't push to live dashboard clients until their
 * next poll. S6 threads the embed's `wsRegistry` into the renderer
 * (`createProjectionRenderer(db, wsRegistry)`); each projected mutation now
 * emits an `mc.projection` refresh signal via {@link broadcastProjection},
 * reusing the existing broadcast helper rather than inventing a parallel
 * protocol. `wsRegistry` is optional — headless/test wiring passes none and the
 * broadcast is a no-op.
 */

import type { Database } from "bun:sqlite";

import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../../../bus/surface-router";
import type { WsClientRegistry } from "../ws/client-registry";
import { broadcastProjection } from "../notifications";
import { projectDispatchLifecycle } from "./dispatch-lifecycle";
import { projectReviewVerdict } from "./review-verdict";
import { projectHeartbeat } from "./heartbeat";
import { projectAttention } from "./attention-projection";
import { projectAdapterLifecycle } from "./adapter-lifecycle";

/** Stable surface-router id for the MC projection renderer. */
export const DISPATCH_PROJECTION_RENDERER_ID = "mc-dispatch-projection";

/**
 * NATS subject patterns the projection renderer subscribes to. Covers the
 * stack-ful (`local.{principal}.{stack}.…`) + stack-less (`local.{principal}.…`)
 * LOCAL grammars and the federated (`federated.{principal}.{stack}.…`) one for
 * every family the dispatcher handles. The wildcards are intentionally broad;
 * the authoritative filter is each projection's own type check (a subject that
 * over-matches costs only a cheap type compare).
 *
 * `*` matches exactly one segment, `>` one-or-more trailing segments (per the
 * surface-router's NATS matcher).
 *
 * Families:
 *   - `dispatch.task.*`  (S4) — dispatch lifecycle.
 *   - `review.verdict.*` (S6) — review verdicts.
 *   - `system.agent.heartbeat` (S6) — agent liveness.
 *   - `system.attention.*` (S6) — attention (the projection ingests the
 *     FEDERATED ones only — see attention-projection.ts; the broad subscription
 *     is harmless, the federated-subject gate is the real filter).
 *   - `system.adapter.*` (S6) — adapter health.
 *
 * The local `system.*` + `review.verdict.*` families have both stack-ful and
 * stack-less local shapes; the federated grammar is always
 * `federated.{principal}.{stack}.…` (ADR-0001 / CONTEXT.md §Subject), so the
 * federated twins are 3-segment-prefix only.
 */
export const DISPATCH_PROJECTION_SUBJECTS: string[] = [
  // dispatch lifecycle (S4)
  "local.*.dispatch.task.*",
  "local.*.*.dispatch.task.*",
  "federated.*.*.dispatch.task.*",
  // review verdicts (S6)
  "local.*.review.verdict.*",
  "local.*.*.review.verdict.*",
  "federated.*.*.review.verdict.*",
  // agent heartbeat (S6)
  "local.*.system.agent.heartbeat",
  "local.*.*.system.agent.heartbeat",
  "federated.*.*.system.agent.heartbeat",
  // attention (S6 — federated only at the projection; subscription is broad)
  "local.*.system.attention.*",
  "local.*.*.system.attention.*",
  "federated.*.*.system.attention.*",
  // adapter health (S6)
  "local.*.system.adapter.*",
  "local.*.*.system.adapter.*",
  "federated.*.*.system.adapter.*",
];

/** A structural view of an envelope the projections read (kept loose so any
 *  validated Envelope is assignable). */
interface ProjectableEnvelope {
  id?: string;
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

/**
 * The single `project(envelope, subject)` dispatcher (§4). Routes on
 * `envelope.type` to the per-family projection, broadcasting an `mc.projection`
 * refresh signal on any mutation. Each projection is itself the authoritative
 * type filter (returns null for a non-matching type), so an over-broad subject
 * subscription is harmless.
 *
 * Exported for direct unit testing of the routing without the surface-router.
 */
export function project(
  db: Database,
  envelope: ProjectableEnvelope,
  subject: string | undefined,
  wsRegistry: WsClientRegistry | undefined,
): void {
  const type = envelope.type;

  if (type.startsWith("dispatch.task.")) {
    const res = projectDispatchLifecycle(db, envelope);
    if (res !== null) {
      broadcastProjection(wsRegistry, "dispatch.lifecycle", {
        sessionId: res.sessionId,
        assignmentId: res.assignmentId,
      });
    }
    return;
  }

  if (type.startsWith("review.verdict.")) {
    const res = projectReviewVerdict(db, envelope);
    if (res !== null) {
      broadcastProjection(wsRegistry, "review.verdict", {
        sessionId: res.sessionId,
      });
    }
    return;
  }

  if (type === "system.agent.heartbeat") {
    const res = projectHeartbeat(db, envelope);
    if (res !== null) {
      broadcastProjection(wsRegistry, "agent.heartbeat", {
        sessionId: res.sessionId,
      });
    }
    return;
  }

  if (type.startsWith("system.attention.")) {
    const res = projectAttention(db, envelope, subject);
    if (res !== null) {
      broadcastProjection(wsRegistry, "attention");
    }
    return;
  }

  if (type.startsWith("system.adapter.")) {
    const res = projectAdapterLifecycle(db, envelope);
    if (res !== null) {
      broadcastProjection(wsRegistry, "adapter.health");
    }
    return;
  }

  // Any other type the broad subscription caught is not a projection family —
  // a no-op (mirrors each projection's own null-return type filter).
}

/**
 * Build the `SurfaceAdapter` the surface-router consumes for the MC projection.
 * The `render()` is non-throwing: every projection error is caught + logged so a
 * malformed envelope can't poison the router's dispatch loop.
 *
 * `db` is the in-process Mission Control handle (from the S1 embed —
 * `startMissionControl(...).db`). `wsRegistry` is the embed's live WebSocket
 * registry (S6) — when supplied, projected mutations broadcast to live clients;
 * when omitted (headless / test), the broadcast is a no-op. cortex.ts wires both
 * only when `mc.enabled`.
 */
export function createDispatchProjectionRenderer(
  db: Database,
  wsRegistry?: WsClientRegistry,
): SurfaceAdapter {
  return {
    id: DISPATCH_PROJECTION_RENDERER_ID,
    subjects: DISPATCH_PROJECTION_SUBJECTS,
    // eslint-disable-next-line @typescript-eslint/require-await
    render: async (
      envelope: Envelope,
      _signal?: AbortSignal,
      subject?: string,
    ): Promise<void> => {
      try {
        project(db, envelope, subject, wsRegistry);
      } catch (err) {
        // Renderer contract §2 — never throw out of render(). A projection
        // failure (DB constraint, malformed payload that slipped a type
        // filter) logs + drops; the surface-router's isolation is belt, this
        // is braces.
        process.stderr.write(
          `[mission-control] projection renderer: render() swallowed an error for envelope ${envelope.id} (${envelope.type}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  };
}
