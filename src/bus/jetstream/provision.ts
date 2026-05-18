/**
 * G-1111b — idempotent JetStream provisioning for cortex's ReviewConsumer
 * pull subscriptions (cortex#338).
 *
 * After cortex#337 (G-1111a) the MyelinRuntime opens a NATS link even
 * when `nats.subjects: []`, so `subscribePull` returns a real subscriber.
 * That subscriber binds to a JetStream pull consumer via
 * `js.consumers.get(stream, durable)` — which throws if the stream OR
 * the durable doesn't exist server-side.
 *
 * Before #338 nothing in cortex provisioned either. Operators ran
 * `nats stream add` / `nats consumer add` by hand or deployed an
 * ops tool. Both are reproducible failure points.
 *
 * This module:
 *
 *   - `provisionReviewStream({ jsm, name, subjects, … })` — `info` then
 *     `add` on 404. Returns `"created"` / `"exists"` so the caller can
 *     log differently. Does NOT auto-update on config drift — logs a
 *     warning instead. Auto-update is too magic for the first cut.
 *
 *   - `provisionReviewConsumer({ jsm, stream, durable, … })` — same
 *     pattern for the per-agent durable pull consumer.
 *
 * Anti-criteria:
 *
 *   - Don't drop streams/consumers on shutdown — JetStream state
 *     outlives the process.
 *   - Don't auto-update on config drift in v1 — log + leave alone.
 *   - Disabled runtime → caller skips provisioning entirely (no JSM to
 *     call against).
 *
 * The two helpers accept a narrow `ProvisionJsm` shape — the subset of
 * nats.js's `JetStreamManager` we touch — so tests can pass a stub
 * without instantiating the full nats.js JS layer.
 */

// `node_modules/nats` enums are runtime values; importing them as
// values keeps the wire-config strings centralised in nats.js rather
// than duplicating literals here.
import { AckPolicy, DeliverPolicy, RetentionPolicy, StorageType } from "nats";
import type { ConsumerConfig, StreamInfo } from "nats";

// Re-exported from the neutral types module so existing callers
// importing `ProvisionJsm` from this file keep working AND new
// callers (MyelinRuntime, future bus consumers) can import from
// `./types` without dragging review-specific code with them.
// Background: sage review on #338 round 3 (architecture).
export type { ProvisionJsm } from "./types";
import type { ProvisionJsm } from "./types";

export type ProvisionOutcome = "created" | "exists" | "config-drift-warning";

export interface ProvisionStreamOpts {
  jsm: ProvisionJsm;
  /** Stream name. ReviewConsumer always binds to `"CODE_REVIEW"`. */
  name: string;
  /** Subject filter list. e.g. `["local.jc.default.tasks.code-review.>"]`. */
  subjects: readonly string[];
  /**
   * Max age in nanoseconds. Default 24h (`24 * 3600 * 1e9`). Stale
   * review tasks past this age are dropped — picks up the work-queue
   * semantic that an unclaimed task is effectively lost after a day.
   */
  maxAgeNs?: number;
  /**
   * Optional logger. Defaults to `console`. Surfacing this lets tests
   * pin the boot-log shape and lets future deployments swap in a
   * structured logger.
   */
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface ProvisionConsumerOpts {
  jsm: ProvisionJsm;
  /** Stream the consumer binds to. */
  stream: string;
  /** Durable consumer name, e.g. `"cortex-review-consumer-jc-sage"`. */
  durable: string;
  /**
   * Optional narrow filter subject. Omitted → consumer claims every
   * message on the stream. Set to per-flavor subject if cortex
   * eventually wants per-flavor durables (#335 follow-up).
   */
  filterSubject?: string;
  /**
   * Max delivery attempts before JetStream terms the message. Default 5.
   */
  maxDeliver?: number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

const DEFAULT_MAX_AGE_NS = 24 * 3600 * 1_000_000_000;
const DEFAULT_MAX_DELIVER = 5;

/**
 * Provision (or assert presence of) the JetStream stream that carries
 * `tasks.code-review.*` envelopes. Idempotent — safe to call on every
 * boot.
 */
export async function provisionReviewStream(
  opts: ProvisionStreamOpts,
): Promise<ProvisionOutcome> {
  const log = opts.log ?? console;
  const maxAgeNs = opts.maxAgeNs ?? DEFAULT_MAX_AGE_NS;

  let existing: StreamInfo | null = null;
  try {
    existing = await opts.jsm.streams.info(opts.name);
  } catch (err) {
    // nats.js surfaces "stream not found" as a thrown error with
    // api_error.code === 404 OR a message containing "not found".
    // Anything else (auth, network) should propagate so the caller
    // can decide whether to abort boot or continue degraded.
    if (!isNotFoundError(err)) {
      throw err;
    }
  }

  if (existing) {
    const drift = describeStreamDrift(existing, opts.subjects, maxAgeNs);
    if (drift !== null) {
      log.warn(
        `jetstream-provision: stream "${opts.name}" exists but config drifts (${drift}); leaving alone (v1 policy — no auto-update). Update manually with \`nats stream edit\` if intentional.`,
      );
      return "config-drift-warning";
    }
    return "exists";
  }

  await opts.jsm.streams.add({
    name: opts.name,
    subjects: [...opts.subjects],
    // `Interest` retention (not Workqueue): JetStream keeps a message
    // only while at least one consumer has unacked interest in it.
    // Workqueue would block the per-agent-durable model — each new
    // unfiltered durable on the same subject space conflicts with the
    // first under Workqueue semantics. Interest lets sage / fern /
    // future reviewers each maintain their own durable on the same
    // stream without provisioning collisions. Competing-consumer
    // semantics (one of N agents claims a given task) are layered at
    // the consumer level by sharing a durable name; cortex#237's
    // current per-agent durable model is fan-out per agent, which is
    // the intended shape for sage#43 + fern routing (each agent sees
    // every task it claims a capability for, then the routing layer
    // decides via the cortex.yaml `provided_by` table).
    retention: RetentionPolicy.Interest,
    storage: StorageType.File,
    max_age: maxAgeNs,
    max_msgs: -1,
    max_bytes: -1,
    num_replicas: 1,
  });
  log.info(
    `jetstream-provision: created stream "${opts.name}" (subjects=[${opts.subjects.join(", ")}], retention=interest, max_age=${Math.round(maxAgeNs / 1_000_000_000)}s)`,
  );
  return "created";
}

/**
 * Provision (or assert presence of) a per-agent durable pull consumer on
 * the given stream. Idempotent — safe on every boot.
 */
export async function provisionReviewConsumer(
  opts: ProvisionConsumerOpts,
): Promise<ProvisionOutcome> {
  const log = opts.log ?? console;
  const maxDeliver = opts.maxDeliver ?? DEFAULT_MAX_DELIVER;

  try {
    await opts.jsm.consumers.info(opts.stream, opts.durable);
    // No drift check on consumers in v1 — the surface is small enough
    // that operators rarely tune it, and pull-consumer drift is more
    // subtle than stream drift. Add when an operator hits the gap.
    return "exists";
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
  }

  const cfg: Partial<ConsumerConfig> = {
    durable_name: opts.durable,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    max_deliver: maxDeliver,
  };
  if (opts.filterSubject !== undefined) {
    cfg.filter_subject = opts.filterSubject;
  }
  await opts.jsm.consumers.add(opts.stream, cfg);
  log.info(
    `jetstream-provision: created consumer "${opts.durable}" on stream "${opts.stream}" (ack=explicit, max_deliver=${maxDeliver}${opts.filterSubject ? `, filter=${opts.filterSubject}` : ""})`,
  );
  return "created";
}

/**
 * Recognise a JetStream "not found" error across the nats.js shapes we
 * see in this codebase. Exported for tests that simulate the no-stream
 * / no-consumer paths via a stub jsm.
 *
 * - nats.js 2.x throws errors whose `.api_error?.err_code === 10059`
 *   (stream not found) or `10014` (consumer not found). The message
 *   forms also include "stream not found" / "consumer not found".
 * - Recogniser is permissive on the message string so a future nats.js
 *   error-class refactor doesn't silently break the recogniser; the
 *   `err_code` path is the authoritative recognition.
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const apiError = (err as { api_error?: { err_code?: number; code?: number } })
    .api_error;
  const code = apiError?.err_code ?? apiError?.code;
  if (code === 10059 || code === 10014 || code === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not found|no.*stream.*matched|404/i.test(msg);
}

/**
 * Describe stream-config drift between the live `StreamInfo` and the
 * config we'd have created. Returns `null` when the relevant fields
 * match, otherwise a short human-readable string for the log line.
 *
 * Drift detection is deliberately narrow — only the fields that
 * meaningfully affect routing (`subjects`) and retention (`max_age`).
 * Operators tuning `max_bytes` / `num_replicas` for their own reasons
 * should NOT see a drift warning every boot.
 */
export function describeStreamDrift(
  existing: StreamInfo,
  expectedSubjects: readonly string[],
  expectedMaxAgeNs: number,
): string | null {
  const cfg = existing.config;
  const actualSubjects = cfg.subjects ?? [];
  // JetStream stream subjects are semantically a set — order on the
  // wire is implementation-detail. Compare as sets so a re-ordered live
  // config doesn't false-warn on every boot (sage review on #338
  // round 3 — CodeQuality suggestion).
  const actualSet = new Set(actualSubjects);
  const expectedSet = new Set(expectedSubjects);
  const subjectsEqual =
    actualSet.size === expectedSet.size &&
    [...expectedSet].every((s) => actualSet.has(s));
  if (!subjectsEqual) {
    return `subjects differ (expected {${[...expectedSet].sort().join(", ")}}, got {${[...actualSet].sort().join(", ")}})`;
  }
  // Allow ±1s slack on max_age to absorb floating-point round-trips
  // through the wire JSON.
  if (Math.abs((cfg.max_age ?? 0) - expectedMaxAgeNs) > 1_000_000_000) {
    return `max_age differs (expected ${expectedMaxAgeNs}ns, got ${cfg.max_age}ns)`;
  }
  return null;
}
