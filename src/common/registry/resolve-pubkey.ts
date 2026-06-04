/**
 * TC-2a (Trust & Confidentiality, cortex#633) — on-demand peer-principal
 * pubkey resolver.
 *
 * The foundation of the cross-principal crypto-verify chain
 * (TC-2b multi-principal `IdentityRegistry` → TC-2d `federated.*` verify).
 * When an inbound `federated.{principal}.{stack}` envelope arrives, the
 * verifier needs the **signing peer's** Ed25519 pubkey to check the
 * `signed_by[]` stamp. Unlike the boot-time `RegistryClient`
 * (`./client.ts`, Phase D.4.3) — which polls a *fixed, known-at-boot*
 * peer list into a warm cache — the peer on an inbound envelope is not
 * knowable at boot. This module resolves an **arbitrary** principal id
 * on demand the first time it is seen, caches the verified pubkey, and
 * serves subsequent verifies from the cache.
 *
 * ## Wire contract (learned from the service, not assumed)
 *
 * `GET {baseUrl}/principals/{id}` returns a `SignedAssertion<PrincipalRecord>`
 * (see `src/services/network-registry/src/routes/principals.ts`):
 *
 *   - `payload.principal_pubkey` — base64 Ed25519 (43 base64 chars + one
 *     `=` of padding = 44 total; 32 raw bytes before encoding).
 *   - `payload.principal_id` — echoed; MUST equal the requested id.
 *   - `registry` — the registry's own pubkey (or the `"unconfigured"`
 *     sentinel in dev when the registry has no signing key).
 *   - `signature` — Ed25519 over `canonicalJSON({ payload, issued_at, registry })`.
 *   - 404 body is `{ "error": "not_found" }`; an invalid id is 400.
 *
 * The shape returned to the verifier is `{ principalPubkey }` — a base64
 * Ed25519 string the verifier feeds into myelin's `IdentityRegistry`
 * (the same `principal_pubkey` shape `RegistryClient.getPrincipal()`
 * already serves, so TC-2b consumes one consistent shape).
 *
 * ## Posture gate (default-OFF — load-bearing)
 *
 * Per `docs/design-trust-confidentiality.md` §"Phase 2-verify": federation
 * crypto-verify is engaged ONLY when `security.signing: enforce`. The
 * resolver is constructed with an `enabled` flag (driven by the posture
 * resolver in `src/common/security-posture.ts`); when disabled it is
 * INERT — `resolve()` short-circuits to `{ status: "disabled" }` with NO
 * network I/O, no cache mutation, no TOFU. A dev stack (default
 * `signing: off`) therefore never reaches out to a registry, exactly as
 * today. The toggle ramp (off → permissive → enforce) is the deliberate,
 * reviewable flip that turns this on.
 *
 * ## Trust anchor
 *
 * Every assertion is verified against a single pinned registry pubkey
 * before its `principal_pubkey` is cached:
 *
 *   - `options.registryPubkey` supplied → pinned at construction (the
 *     recommended posture; the anchor is principal-supplied out-of-band
 *     via `policy.federated.registry.pubkey` in cortex.yaml).
 *   - absent → Trust-On-First-Use via `GET {baseUrl}/registry/pubkey` on
 *     the first `resolve()` that actually does I/O. The first response is
 *     pinned for the resolver's lifetime (the Phase-B caveat documented on
 *     `RegistryClient`).
 *
 * ## Failure handling (CLAUDE.md: NEVER empty catch)
 *
 * `resolve()` NEVER throws — a federation/registry problem must not crash
 * the verify path. Every failure path logs via `logError` (defaults to
 * `process.stderr.write`) and returns a discriminated result:
 *
 *   - `{ status: "disabled" }`    — posture OFF; inert (no I/O).
 *   - `{ status: "resolved", principalPubkey }` — verified, cache-backed.
 *   - `{ status: "not_found" }`   — registry returned 404 for this id.
 *   - `{ status: "unresolved" }`  — network error, non-404 HTTP, malformed
 *                                   body, pubkey grammar/shape failure,
 *                                   registry-pubkey mismatch, signature
 *                                   mismatch, or TOFU failure.
 *
 * `not_found` vs `unresolved` are distinct on purpose: a 404 is a stable
 * "this peer is not registered" (the verifier rejects the envelope), while
 * `unresolved` is a transient "we could not check right now" (the verifier
 * also rejects, but the resolver may succeed on a later attempt — neither
 * outcome is cached as a *positive*).
 *
 * Negative outcomes (404 / unresolved) are deliberately NOT cached: a peer
 * that registers *after* its first probe must become resolvable without
 * waiting out a TTL, and a transient failure must not pin a peer as
 * permanently-unknown. The cost is that a peer repeatedly claiming an
 * unregistered id re-hits the registry per envelope — acceptable because
 * (a) this path is engaged only under `signing: enforce`, and (b) the
 * inbound envelope rate is already gated upstream by the surface-router /
 * policy layer before verify runs.
 *
 * ## Caching
 *
 * Resolved pubkeys are cached in an in-memory `Map<principalId, string>`
 * (peer keys are stable; rotation requires a co-signed transition claim,
 * a registry-side v2 feature). Only a *successful verify* writes the
 * cache — a failure never blanks a previously-resolved entry. `invalidate`
 * / `clearCache` bust an entry (or all) so a later `resolve()` re-fetches
 * (the seam the eventual `system.principal.published` bus event will call).
 */

import { canonicalJSON, verifyEd25519 } from "./signing";

// NOTE (follow-up): the assertion-verification body below (shape gate →
// registry-pubkey pin check → canonical-JSON sig verify) is intentionally
// kept in lock-step with `RegistryClient.verifyAssertion` in `./client.ts`,
// which verifies the SAME `SignedAssertion` shape against the SAME pinned
// pubkey. The two are not yet consolidated because the client returns a
// full normalised `PrincipalRecord` while this resolver returns only the
// `principal_pubkey` string, and folding the D.4.3 client's already-reviewed
// path into a shared helper is out of TC-2a's scope (CLAUDE.md: a move that
// tempts an unrelated refactor becomes a follow-up, not a drive-by). A
// shared `verifyPrincipalAssertion` is the right consolidation once both
// consumers are stable — tracked alongside the `@cortex/registry-types`
// TODO already noted in `./types.ts`.

/** Base64 Ed25519 grammar: 43 alphabet chars + one `=` of padding. */
const BASE64_ED25519 = /^[A-Za-z0-9+/]{43}=$/;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Outcome of a `resolve()` call. Discriminated so the verifier
 * (TC-2b/TC-2d) can branch: `resolved` feeds the pubkey into the
 * `IdentityRegistry`; every other status rejects the inbound envelope.
 */
export type ResolveResult =
  | {
      /** Posture OFF — the resolver did no I/O. The verifier treats
       *  federation crypto-verify as not-engaged. */
      status: "disabled";
    }
  | {
      /** Verified against the pinned registry pubkey and cached. */
      status: "resolved";
      /** Base64 Ed25519 peer pubkey (44 chars w/ padding). */
      principalPubkey: string;
    }
  | {
      /** Registry returned 404 — this principal id is not registered. */
      status: "not_found";
    }
  | {
      /** Transient/structural failure (network, parse, verify, mismatch,
       *  malformed pubkey, TOFU failure). Not cached; retry-able. */
      status: "unresolved";
    };

/** Construction options for {@link PrincipalPubkeyResolver}. */
export interface PrincipalPubkeyResolverOptions {
  /**
   * Whether federation crypto-verify is engaged. Driven by the posture
   * resolver (`security.signing: enforce` → `true`; `off`/`permissive`
   * → `false`). DEFAULT-OFF: when `false`, `resolve()` is inert (no I/O,
   * returns `{ status: "disabled" }`). See file header §"Posture gate".
   */
  enabled: boolean;
  /**
   * Registry base URL (`policy.federated.registry.url`). Trailing slashes
   * are normalised away before path joining. Required when `enabled` is
   * `true`; ignored (never read) when disabled.
   */
  baseUrl: string;
  /**
   * Pinned registry pubkey (`policy.federated.registry.pubkey`, base64
   * Ed25519, 44 chars w/ padding). When absent, the resolver performs
   * TOFU via `GET {baseUrl}/registry/pubkey` on first I/O and pins the
   * response for its lifetime. See file header §"Trust anchor".
   */
  registryPubkey?: string;
  /**
   * Per-request timeout (ms). Default 10s. Wraps each `fetch()` via an
   * `AbortController` so a hung registry doesn't stall the verify path.
   */
  requestTimeoutMs?: number;
  /** `fetch` implementation. Defaults to `globalThis.fetch`. Tests inject. */
  fetch?: typeof globalThis.fetch;
  /**
   * Logger seam — defaults to writing to `process.stderr` (CLAUDE.md
   * "no empty catches"). Tests inject a spy / no-op.
   */
  logError?: (msg: string) => void;
}

/**
 * On-demand peer-principal pubkey resolver. Construct once (at boot, with
 * the posture-resolved `enabled` flag), then call `resolve(principalId)`
 * from the verify path. Single-process, in-memory.
 */
export class PrincipalPubkeyResolver {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly logError: (msg: string) => void;

  /** Pinned registry pubkey. Set in ctor (config) or via TOFU on first I/O. */
  private pinnedPubkey: string | undefined;
  /** Whether the pinned pubkey must be discovered via TOFU (no config pin). */
  private readonly tofuMode: boolean;

  /** Verified-pubkey cache: `principal_id → base64 Ed25519 pubkey`. */
  private readonly cache = new Map<string, string>();

  constructor(options: PrincipalPubkeyResolverOptions) {
    this.enabled = options.enabled;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.logError =
      options.logError ??
      ((msg: string) => {
        process.stderr.write(`registry-resolver: ${msg}\n`);
      });
    this.pinnedPubkey = options.registryPubkey;
    this.tofuMode = options.registryPubkey === undefined;
  }

  /**
   * Resolve `principalId` to its verified base64 Ed25519 pubkey.
   *
   * Cache-first: a previously-verified pubkey is returned without I/O.
   * On a miss (and only when `enabled`), fetches
   * `GET {baseUrl}/principals/{id}`, verifies the registry-signed
   * assertion against the pinned (or TOFU-discovered) registry pubkey,
   * caches, and returns it.
   *
   * NEVER throws. See file header §"Failure handling" for the result
   * matrix.
   */
  async resolve(principalId: string): Promise<ResolveResult> {
    // Posture gate — inert when federation crypto-verify is not engaged.
    // No network, no cache mutation, no TOFU. Default-OFF (dev stacks).
    if (!this.enabled) return { status: "disabled" };

    const cached = this.cache.get(principalId);
    if (cached !== undefined) {
      return { status: "resolved", principalPubkey: cached };
    }

    // TOFU the registry pubkey on first I/O if it wasn't config-pinned.
    // Retried on every miss until it succeeds — a transient outage at the
    // first attempt must not leave the resolver permanently dead.
    if (this.pinnedPubkey === undefined && this.tofuMode) {
      await this.fetchAndPinRegistryPubkey();
    }
    if (this.pinnedPubkey === undefined) {
      this.logError(
        `resolve(${principalId}): no pinned registry pubkey (TOFU failing or never supplied); cannot verify`,
      );
      return { status: "unresolved" };
    }

    const url = `${this.baseUrl}/principals/${encodeURIComponent(principalId)}`;
    const fetched = await this.fetchJson(url);
    if (fetched.kind === "not_found") return { status: "not_found" };
    if (fetched.kind === "error") return { status: "unresolved" };

    const pubkey = await this.verifyAssertion(principalId, fetched.body);
    if (pubkey === undefined) return { status: "unresolved" };

    this.cache.set(principalId, pubkey);
    return { status: "resolved", principalPubkey: pubkey };
  }

  /**
   * Bust a single cached entry. The next `resolve(principalId)` re-fetches.
   * Exposed for the future `system.principal.published` event handler and
   * for explicit rotation-refresh.
   */
  invalidate(principalId: string): void {
    this.cache.delete(principalId);
  }

  /** Bust the entire cache. Useful in tests and on a registry rotation. */
  clearCache(): void {
    this.cache.clear();
  }

  // =============================================================================
  // Private — TOFU + assertion verification
  // =============================================================================

  private async fetchAndPinRegistryPubkey(): Promise<void> {
    const url = `${this.baseUrl}/registry/pubkey`;
    const fetched = await this.fetchJson(url);
    if (fetched.kind !== "ok") {
      this.logError(
        `TOFU failed: could not fetch ${url}; resolver stays unpinned and rejects until a later attempt succeeds`,
      );
      return;
    }
    const raw = fetched.body;
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as { algorithm?: unknown }).algorithm !== "Ed25519" ||
      typeof (raw as { public_key?: unknown }).public_key !== "string"
    ) {
      this.logError("TOFU failed: malformed /registry/pubkey response");
      return;
    }
    const publicKey = (raw as { public_key: string }).public_key;
    // Refuse the unconfigured sentinel / empty key — we cannot verify any
    // assertion against it.
    if (publicKey === "" || publicKey === "unconfigured") {
      this.logError(
        "TOFU failed: registry returned unconfigured pubkey; refusing to pin",
      );
      return;
    }
    this.pinnedPubkey = publicKey;
  }

  /**
   * Verify a registry assertion against the pinned pubkey and extract the
   * peer's `principal_pubkey`. Returns the pubkey on success, `undefined`
   * (with a log line) on any failure.
   *
   * Accepts `unknown`: the input is untrusted JSON straight off the wire,
   * and the shape checks below ARE the validation.
   */
  private async verifyAssertion(
    principalId: string,
    raw: unknown,
  ): Promise<string | undefined> {
    const pinned = this.pinnedPubkey;
    if (pinned === undefined) {
      this.logError(
        `resolve(${principalId}): no pinned pubkey; refusing to trust assertion`,
      );
      return undefined;
    }
    // Shape check first — cheaper than crypto and gives a clearer log.
    if (raw === null || typeof raw !== "object") {
      this.logError(`resolve(${principalId}): assertion not an object; ignoring`);
      return undefined;
    }
    const assertion = raw as Record<string, unknown>;
    if (
      typeof assertion.signature !== "string" ||
      typeof assertion.issued_at !== "string" ||
      typeof assertion.registry !== "string" ||
      assertion.payload === null ||
      typeof assertion.payload !== "object"
    ) {
      this.logError(
        `resolve(${principalId}): malformed assertion envelope; ignoring`,
      );
      return undefined;
    }
    const registry = assertion.registry;
    if (registry === "unconfigured") {
      this.logError(
        `resolve(${principalId}): registry assertion says "unconfigured"; refusing`,
      );
      return undefined;
    }
    if (registry !== pinned) {
      this.logError(
        `resolve(${principalId}): registry pubkey mismatch (got ${registry.slice(0, 8)}…, pinned ${pinned.slice(0, 8)}…); ignoring`,
      );
      return undefined;
    }
    const payload = assertion.payload as Record<string, unknown>;
    // Defend against a swapped payload — the assertion MUST be for the id
    // we asked about.
    if (payload.principal_id !== principalId) {
      this.logError(
        `resolve(${principalId}): payload.principal_id mismatch (got "${String(payload.principal_id)}"); ignoring`,
      );
      return undefined;
    }
    if (typeof payload.principal_pubkey !== "string") {
      this.logError(
        `resolve(${principalId}): payload.principal_pubkey missing or non-string; ignoring`,
      );
      return undefined;
    }
    // Grammar-gate the peer pubkey BEFORE the crypto verify — a cheap
    // structural check so we don't pay an Ed25519 verify on a payload we'd
    // reject anyway, and so the cache never holds a poison value. A
    // signed-but-malformed peer pubkey is still a wire-contract violation.
    if (!BASE64_ED25519.test(payload.principal_pubkey)) {
      this.logError(
        `resolve(${principalId}): payload.principal_pubkey is not base64-Ed25519 (got "${payload.principal_pubkey.slice(0, 12)}…"); ignoring`,
      );
      return undefined;
    }

    // Reconstruct the canonical bound triple and verify the registry sig.
    const bound = canonicalJSON({
      payload: assertion.payload,
      issued_at: assertion.issued_at,
      registry,
    });
    const message = new TextEncoder().encode(bound);
    let ok: boolean;
    try {
      ok = await verifyEd25519(pinned, assertion.signature, message);
    } catch (err) {
      this.logError(
        `resolve(${principalId}): verify threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    if (!ok) {
      this.logError(
        `resolve(${principalId}): signature did not verify; ignoring`,
      );
      return undefined;
    }
    return payload.principal_pubkey;
  }

  // =============================================================================
  // Private — transport
  // =============================================================================

  /**
   * Issue a JSON GET. Distinguishes 404 (a stable "not registered") from
   * every other failure (`error`) and success (`ok`). Wraps timeout +
   * non-2xx + parse failure into a single discriminated return with a
   * structured log line — NEVER throws.
   */
  private async fetchJson(
    url: string,
  ): Promise<
    | { kind: "ok"; body: unknown }
    | { kind: "not_found" }
    | { kind: "error" }
  > {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (res.status === 404) {
        // Not an error path — a definitive "this principal is not
        // registered". Surfaced distinctly so the verifier can reject the
        // envelope without treating it as a transient outage.
        return { kind: "not_found" };
      }
      if (!res.ok) {
        this.logError(`GET ${url} returned ${res.status}`);
        return { kind: "error" };
      }
      try {
        return { kind: "ok", body: await res.json() };
      } catch (err) {
        this.logError(
          `GET ${url} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "error" };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logError(`GET ${url} timed out after ${this.requestTimeoutMs}ms`);
      } else {
        this.logError(
          `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { kind: "error" };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * One-shot functional form of {@link PrincipalPubkeyResolver.resolve}.
 * Convenience for call sites that don't hold a long-lived resolver (e.g.
 * tests, tooling). Constructs a throwaway resolver — NO cache reuse across
 * calls, so prefer the class for the verify hot path. NEVER throws.
 *
 * @param principalId the peer principal id to resolve
 * @param options     resolver construction options (see the class)
 */
export async function resolvePrincipalPubkey(
  principalId: string,
  options: PrincipalPubkeyResolverOptions,
): Promise<ResolveResult> {
  return new PrincipalPubkeyResolver(options).resolve(principalId);
}
