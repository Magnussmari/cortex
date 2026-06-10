/**
 * MC-I1.S4 (ADR-0005 §4) — the bus→MC projection renderer.
 *
 * §4 makes the bus→MC seam a registered surface-router renderer: a push-based
 * `render(envelope)` rather than the polled DashboardRenderer ring buffer (§4
 * demotes that to, at most, the drill-down's recent-raw-envelopes feed). cortex.ts
 * registers this adapter with the surface-router when `mc.enabled`, subscribing
 * to the `dispatch.task.*` lifecycle subjects only.
 *
 * The adapter is deliberately SKELETAL: a single `project(envelope)` dispatcher
 * keyed on `envelope.type`, today routing `dispatch.task.*` into
 * {@link projectDispatchLifecycle}. S6 (#848) generalizes this seam to verdicts
 * / attention / heartbeats — it EXTENDS the `project()` switch (adds cases)
 * rather than rewriting the renderer, so the surface-router registration and the
 * non-throwing contract stay intact.
 *
 * ## Non-throwing contract
 *
 * The surface-router wraps every `render()` in a timeout + `Promise.allSettled`
 * (`renderWithIsolation`), but the Renderer contract (renderers/types.ts §2)
 * ALSO obliges the renderer itself to never throw — a projection error must
 * not poison the dispatch loop. We catch inside `render()` and route failures to
 * stderr, mirroring the DashboardRenderer + ingestor error posture.
 *
 * ## WS broadcast — known gap for S6 (#848)
 *
 * The MC server's WebSocket broadcasts on state transitions via a
 * `WsClientRegistry` the db layer doesn't know about; existing mutation paths
 * (api/handlers, the ingestor) fan out by calling `broadcastTransition` /
 * `broadcastEvent` at the call site AFTER the db write. The projection writes
 * here bypass that fan-out, so a freshly-projected session/transition won't push
 * to live dashboard clients until their next poll/refetch. Wiring the registry
 * through requires threading the projection's per-envelope transition results
 * into `broadcastTransition`; S6 owns the generalized notification seam, so this
 * slice leaves it as a documented gap rather than a partial wire-up. The embed
 * (embed.ts) holds the `wsRegistry`; a follow-up passes it here.
 */

import type { Database } from "bun:sqlite";

import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../../../bus/surface-router";
import { projectDispatchLifecycle } from "./dispatch-lifecycle";

/** Stable surface-router id for the dispatch-lifecycle projection renderer. */
export const DISPATCH_PROJECTION_RENDERER_ID = "mc-dispatch-projection";

/**
 * NATS subject patterns the projection renderer subscribes to. Covers both the
 * stack-ful (`local.{principal}.{stack}.dispatch.task.*`) and stack-less
 * (`local.{principal}.dispatch.task.*`) local grammars AND the federated
 * (`federated.{principal}.{stack}.dispatch.task.*`) one — ADR-0005 §3 notes the
 * projection "works unchanged for peer-stack sessions arriving on `federated.`
 * lifecycle envelopes". The wildcards are intentionally broad; the
 * authoritative type filter is {@link projectDispatchLifecycle}'s own
 * `lifecycleKind` check (it returns null — a no-op — for anything that isn't a
 * recognised `dispatch.task.{started|completed|failed|aborted}`), so a subject
 * that over-matches costs only a cheap type compare.
 *
 * `*` matches exactly one segment, `>` one-or-more trailing segments (per the
 * surface-router's NATS matcher). `local.>` would also work but the explicit
 * `dispatch.task` tail keeps the subscription self-documenting and narrows the
 * router's per-envelope payload-filter pass.
 */
export const DISPATCH_PROJECTION_SUBJECTS: string[] = [
  "local.*.dispatch.task.*",
  "local.*.*.dispatch.task.*",
  "federated.*.*.dispatch.task.*",
];

/**
 * Build the `SurfaceAdapter` the surface-router consumes for the
 * dispatch-lifecycle projection. The `render()` is non-throwing: every
 * projection error is caught + logged so a malformed envelope can't poison the
 * router's dispatch loop.
 *
 * `db` is the in-process Mission Control handle (from the S1 embed —
 * `startMissionControl(...).db`). cortex.ts wires this only when `mc.enabled`,
 * so `db` is always the live MC db here.
 */
export function createDispatchProjectionRenderer(db: Database): SurfaceAdapter {
  return {
    id: DISPATCH_PROJECTION_RENDERER_ID,
    subjects: DISPATCH_PROJECTION_SUBJECTS,
    // eslint-disable-next-line @typescript-eslint/require-await
    render: async (envelope: Envelope): Promise<void> => {
      try {
        // The single `project(envelope)` dispatcher (§4). Today it routes
        // `dispatch.task.*` into the lifecycle projection; S6 (#848) adds
        // verdict / attention / heartbeat cases here.
        projectDispatchLifecycle(db, envelope);
      } catch (err) {
        // Renderer contract §2 — never throw out of render(). A projection
        // failure (DB constraint, malformed payload that slipped the type
        // filter) logs + drops; the surface-router's isolation is belt, this
        // is braces.
        process.stderr.write(
          `[mission-control] dispatch-projection renderer: render() swallowed an error for envelope ${envelope.id} (${envelope.type}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  };
}
