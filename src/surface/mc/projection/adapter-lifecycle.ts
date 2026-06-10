/**
 * MC-I1.S6 (#848, ADR-0005 §4) — project `system.adapter.*` lifecycle envelopes
 * into the MC attention queue as surface-health items.
 *
 * A degraded / disconnected adapter is a "the principal's Discord/Slack surface
 * is down" condition the cockpit should show. There is NO local MC producer for
 * adapter health (the producers live in the adapters themselves and only emit on
 * the bus), so — unlike `system.attention.*` — there is no reconciler to fight:
 * the projection is the SOLE writer of adapter-health attention. We store it
 * under a distinct `att:adapter:` namespace keyed on the adapter id, so:
 *   - `system.adapter.degraded` / `system.adapter.disconnected` (was_clean=false)
 *     → OPEN a `blocked`/high attention item ("discord-luna degraded").
 *   - `system.adapter.recovered` (or a clean disconnect) → RESOLVE it.
 *
 * One open item per adapter id (deterministic `att:adapter:{adapter_id}`):
 * a flap that re-degrades before recovery upserts the same row (idempotent),
 * and recovery resolves exactly that row. `work_item_id` / `session_id` are NULL
 * (adapter health has no work-item/session deep-link); `stack_id` carries the
 * adapter id segment so a multi-stack view can group by origin.
 *
 * Non-throwing: malformed payloads / non-adapter types return null.
 */

import type { Database } from "bun:sqlite";

import { upsertAttentionItem, resolveAttentionItem } from "../db/attention";
import type { AttentionItem } from "../types";

/** The adapter-health attention id namespace — disjoint from local + federated. */
export const ADAPTER_ATTENTION_PREFIX = "att:adapter:";

type AdapterLifecycleKind = "degraded" | "recovered" | "disconnected";

export interface ProjectableAdapterEnvelope {
  id?: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface AdapterProjectionResult {
  /** Whether the projection opened or resolved the adapter-health item. */
  action: "opened" | "resolved";
  /** The MC attention item id (`att:adapter:`-prefixed). */
  itemId: string;
  /** The adapter id the health item tracks. */
  adapterId: string;
}

/**
 * Project one `system.adapter.{degraded,recovered,disconnected}` envelope into
 * an adapter-health attention item. Returns null for a non-adapter type or a
 * malformed payload (missing `adapter_id`).
 */
export function projectAdapterLifecycle(
  db: Database,
  envelope: ProjectableAdapterEnvelope,
): AdapterProjectionResult | null {
  const kind = adapterKind(envelope.type);
  if (kind === null) return null;

  const rawPayload: unknown = envelope.payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  const adapterId = asString(payload.adapter_id);
  if (adapterId === null) {
    process.stderr.write(
      `[mission-control] adapter-projection: ignoring ${envelope.type} — missing adapter_id\n`,
    );
    return null;
  }
  const itemId = `${ADAPTER_ATTENTION_PREFIX}${adapterId}`;

  // A clean disconnect (was_clean=true) is a routine shutdown, NOT an outage —
  // treat it as a resolve (or no-op if nothing was open), same as recovered.
  const wasClean = payload.was_clean === true;
  const opensOutage =
    kind === "degraded" || (kind === "disconnected" && !wasClean);

  if (!opensOutage) {
    // recovered, or a clean disconnect → resolve the open adapter-health item.
    resolveAttentionItem(db, itemId);
    return { action: "resolved", itemId, adapterId };
  }

  const item: AttentionItem = {
    id: itemId,
    stackId: adapterId,
    workItemId: null,
    sessionId: null,
    kind: "blocked",
    severity: "high",
    status: "open",
  };
  upsertAttentionItem(db, item);
  return { action: "opened", itemId, adapterId };
}

function adapterKind(type: string): AdapterLifecycleKind | null {
  switch (type) {
    case "system.adapter.degraded":
      return "degraded";
    case "system.adapter.recovered":
      return "recovered";
    case "system.adapter.disconnected":
      return "disconnected";
    default:
      return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
