/**
 * #680 — App-layer rate limiting for the network-registry edge.
 *
 * The registry is a PUBLIC internet surface on BOTH `network-dev.meta-factory.ai`
 * and `network.meta-factory.ai`. Per the principal's parity rule, dev is NOT a
 * laxer posture: every control here is identical on dev and prod. The LIMIT
 * VALUES live in this file as code constants (see `RATE_LIMITS` below), so they
 * are inherently byte-identical across both environments — there is no per-env
 * config knob that could drift. The only thing wrangler.toml declares per-env is
 * the binding *namespace id* (CF requires a distinct id per env); the
 * limit/period are NOT in wrangler.toml and cannot diverge.
 *
 * Mechanism (prefer native, documented fallback)
 * ──────────────────────────────────────────────
 * Cloudflare Workers ship a native rate-limit binding (`env.RL.limit({ key })`
 * → `{ success }`), configured via `[[unsafe.bindings]]` with
 * `type = "ratelimit"` in wrangler.toml. We use it when present.
 *
 * The native binding has **no local emulator**: it is `undefined` under
 * `wrangler dev` and `bun test`. So this module degrades to a minimal
 * in-Worker token-bucket keyed by the same key. The fallback is:
 *   - correct for single-isolate / single-colo bursts, and
 *   - per-isolate / in-memory — it does NOT coordinate across the colo,
 *     exactly like the InMemoryRegistryStore + nonce cache already do
 *     (see store.ts, README §Roadmap, and the durable-storage follow-up #682).
 * In production the native binding (durable, colo-coordinated) is the active
 * path; the bucket only runs where the binding is absent (tests/local).
 *
 * Ordering (security-relevant — see #680 acceptance):
 * The IP rate-limit is CHEAP (one binding call / one map lookup). The signature
 * verify on POST /register is EXPENSIVE (Ed25519 + canonical-JSON). So callers
 * invoke the rate-limit gate BEFORE the signature check, so a flood of
 * bad-signature registers is shed early rather than burning verify compute.
 */

/**
 * The native Workers rate-limit binding shape (matches
 * `@cloudflare/workers-types`' `RateLimit` interface). Declared locally so this
 * module does not depend on the ambient global resolving in every build target.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * A single named limit: at most `limit` requests per `periodSec` window.
 *
 * NOTE on the native binding: CF's `ratelimit` binding only supports
 * `simple = { limit, period }` where `period` is **10 or 60 seconds**. We keep
 * each declared period to one of those two values so the SAME numbers can be
 * mirrored into wrangler.toml's `[[unsafe.bindings]]` blocks without
 * translation. The token-bucket fallback honours arbitrary periods, but we
 * stick to 10/60 so native and fallback agree.
 */
export interface RateLimitRule {
  readonly limit: number;
  readonly periodSec: 10 | 60;
}

/**
 * Canonical limit table — IDENTICAL on dev and prod (code constant, not config).
 *
 * Tuned for a federation directory: hundreds of principals, M2M peers polling
 * resolve on a schedule, NOT a high-QPS consumer API. Resolve (`GET
 * /principals/:id`) is load-bearing for cross-principal verify, so its read
 * limit is generous enough that a legitimately-busy peer fan-out won't choke,
 * while still capping a scraper.
 *
 * If you change a value here, it changes for BOTH environments at once — that
 * IS the parity guarantee. Do not introduce a per-env override.
 */
export const RATE_LIMITS = {
  /**
   * POST /principals/:id/register — strictest. Mutation + Ed25519 verify
   * compute. A principal registers occasionally (boot, rotation), never in a
   * tight loop. 5 / 60s per key absorbs a retry storm but sheds a flood.
   */
  register: { limit: 5, periodSec: 60 },
  /**
   * GET reads (resolve / roster / capabilities) — looser. Keyed by IP. 120 /
   * 60s is ~2 req/s sustained per IP: comfortable for a federation peer
   * refreshing many principals on a schedule, hostile to a bulk enumerator.
   */
  read: { limit: 120, periodSec: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

// ---------------------------------------------------------------------------
// Native-binding env shape
// ---------------------------------------------------------------------------

/**
 * The optional native bindings the Worker may carry. One binding per limit so
 * CF can scope each independently. Absent under `wrangler dev` / `bun test`.
 */
export interface RateLimitEnv {
  RL_REGISTER?: RateLimitBinding;
  RL_READ?: RateLimitBinding;
}

const BINDING_FOR: Record<RateLimitName, keyof RateLimitEnv> = {
  register: "RL_REGISTER",
  read: "RL_READ",
};

// ---------------------------------------------------------------------------
// In-Worker token-bucket fallback (per-isolate, in-memory)
// ---------------------------------------------------------------------------

interface BucketState {
  /** Tokens remaining in the current window. */
  tokens: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/**
 * Fixed-window counter keyed by `name:key`. Per-isolate, in-memory — NOT
 * durable, NOT colo-coordinated (same caveat as the in-memory store). Used only
 * when the native binding is absent (tests / `wrangler dev`).
 *
 * Module-scoped so it survives across requests within an isolate, with a
 * threshold-gated sweep mirroring the nonce cache's pattern so the map can't
 * grow unboundedly under key churn.
 */
const buckets = new Map<string, BucketState>();
const SWEEP_THRESHOLD = 256;

function fallbackLimit(name: RateLimitName, key: string, now: number): boolean {
  const rule = RATE_LIMITS[name];
  const windowMs = rule.periodSec * 1000;

  if (buckets.size > SWEEP_THRESHOLD) {
    for (const [k, st] of buckets) {
      if (st.resetAt <= now) buckets.delete(k);
    }
  }

  const mapKey = `${name}:${key}`;
  const existing = buckets.get(mapKey);
  if (!existing || existing.resetAt <= now) {
    buckets.set(mapKey, { tokens: rule.limit - 1, resetAt: now + windowMs });
    return true; // first request in a fresh window always succeeds
  }
  if (existing.tokens <= 0) return false;
  existing.tokens -= 1;
  return true;
}

/** Test-only — clear the fallback buckets between cases. */
export function _resetRateLimitBucketsForTest(): void {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// Public gate
// ---------------------------------------------------------------------------

/**
 * Check one request against a named limit.
 *
 * @returns `true` if the request is ALLOWED, `false` if it exceeded the limit
 *          (caller should return 429).
 *
 * Resolution order: native binding if bound, else the in-Worker fallback. The
 * key is caller-supplied (IP and/or principal_id) — see `clientKey`.
 *
 * Fail-open on a native-binding error: if the binding call throws (CF transient
 * fault), we allow the request rather than 503 the whole registry on a
 * rate-limiter blip. This is the conventional posture — a rate limiter is a
 * guard, not a correctness gate; the crypto gates remain the hard wall.
 */
export async function checkRateLimit(
  env: RateLimitEnv,
  name: RateLimitName,
  key: string,
  now: number = Date.now(),
): Promise<boolean> {
  const binding = env[BINDING_FOR[name]];
  if (binding) {
    try {
      const { success } = await binding.limit({ key });
      return success;
    } catch (err) {
      // Fail-open: a rate-limiter fault must not take down the directory.
      console.error(
        `[network-registry] rate-limit binding '${BINDING_FOR[name]}' errored, failing open: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
  }
  return fallbackLimit(name, key, now);
}

/**
 * Derive the rate-limit key from the request. Prefers `CF-Connecting-IP`
 * (set by Cloudflare on every edge request; un-spoofable client IP). Falls back
 * to a fixed sentinel when absent (local/test) so the limiter still functions
 * deterministically rather than keying on `undefined`.
 *
 * For the register limit we additionally fold in the principal_id so one
 * principal hammering register can't be masked behind a shared/NAT egress IP,
 * and conversely one IP can't exhaust the limit for many principals — each
 * (ip, principal) pair gets its own bucket.
 */
export function clientKey(req: Request, principalId?: string): string {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  return principalId ? `${ip}|${principalId}` : ip;
}

/** Standard 429 body — deliberately opaque (no internals, no limit values). */
export const TOO_MANY_REQUESTS_BODY = { error: "rate_limited" } as const;

/**
 * `Retry-After` value (seconds) for a 429 on the given limit. We return the
 * limit's window period — a safe upper bound on when a fresh window opens, so a
 * well-behaved client backs off rather than hammering. This is the SAME public
 * period already documented in the SOP; it leaks nothing the principal hasn't
 * already published, and helps legitimate federation peers self-throttle.
 */
export function retryAfterSeconds(name: RateLimitName): number {
  return RATE_LIMITS[name].periodSec;
}
