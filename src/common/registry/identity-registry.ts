/**
 * TC-2b (Trust & Confidentiality, cortex#634) — multi-principal,
 * peer-stamped `IdentityRegistry`.
 *
 * ## What this is
 *
 * The federation crypto-verify chain (`docs/design-trust-confidentiality.md`
 * §"Phase 2-verify") needs to look up the **verified Ed25519 pubkey of ANY
 * peer principal** that signed an inbound `federated.{principal}.{stack}`
 * envelope — not just the local boot principal. Until TC-2b the verifier's
 * `buildIdentityRegistry` (`src/bus/verify-signed-by-chain.ts`) stamped
 * EVERY agent with the single boot `principalId`; cross-principal envelopes
 * were therefore unverifiable (the design's "single-principal boundary").
 *
 * `MultiPrincipalIdentityRegistry` lifts that boundary. It holds a MAP of
 * `principal_id → verified peer entry`, with the **local boot principal**
 * pinned as an always-present, never-overwritten entry. Unknown peers are
 * resolved **on demand** via the TC-2a `PrincipalPubkeyResolver` (registry-
 * signed `GET /principals/{id}`, pinned-registry-pubkey verified), cached,
 * and then served synchronously. TC-2d consumes the materialised myelin
 * `IdentityRegistry` (`toIdentityRegistry()`) in the `federated.*` verify
 * path.
 *
 * ## Posture gate (default-OFF — load-bearing)
 *
 * Per the #635 wiring note, the federation verify path engages ONLY under
 * `security.signing: enforce` — NOT merely when `cryptoVerify` is on (which
 * is `true` even for `off`/`permissive` as cheap observability). The
 * resolver is constructed with its own `enabled` flag driven by
 * `signing === "enforce"`; when federation verify is OFF the resolver is
 * inert and `resolve()` returns `{ status: "disabled" }` with ZERO network
 * I/O. In that state ONLY the pinned local boot entry is available — exactly
 * today's single-principal behaviour. This registry does no posture reading
 * itself: it delegates the gate to the resolver it is handed (an `enabled:
 * false` / absent resolver ⇒ peer lookups never reach out).
 *
 * ## Peer-stamping (provenance)
 *
 * Every entry records its `provenance`:
 *   - `"local-boot"`   — the pinned local boot principal (config-supplied,
 *     out-of-band trust anchor). Exactly one such entry; immutable.
 *   - `"resolved-registry"` — a peer whose pubkey was resolved + verified
 *     via the TC-2a resolver against the pinned registry pubkey.
 *
 * TC-2d / audit can distinguish "we trust this because the principal pinned
 * it at boot" from "we trust this because the network registry asserted it".
 * A resolved peer entry NEVER overwrites the pinned local boot identity
 * (`pin(principalId, …)` is rejected for the boot id) — the boot anchor is
 * the strongest link in the chain and a registry compromise must not be able
 * to displace it.
 *
 * ## Failure handling (CLAUDE.md: NEVER empty catch)
 *
 * `resolve()` NEVER throws — a federation/registry problem must not crash
 * the verify path. An unresolved peer yields a clear negative
 * (`{ resolved: false, reason }`) that the verifier rejects on, logged via
 * the injected `logError` seam (defaults to `process.stderr`). A negative
 * is NOT cached (the underlying resolver already declines to cache
 * negatives), so a peer that registers after its first probe becomes
 * resolvable without waiting out a TTL.
 *
 * ## Back-compat (single-principal case)
 *
 * Constructed with only a boot principal and no resolver, this class behaves
 * as a single-entry registry: `get(bootId)` returns the boot identity,
 * `toIdentityRegistry()` materialises exactly the boot identity, and
 * `resolve(anyPeer)` returns `{ resolved: false, reason: "disabled" }`
 * without I/O. Existing single-principal consumers see no change.
 */

import {
  createInMemoryRegistry,
  type Identity,
  type IdentityRegistry,
} from "@the-metafactory/myelin/identity";

import type { PrincipalPubkeyResolver } from "./resolve-pubkey";

/**
 * Where an entry's verified pubkey came from. Stamped onto every entry so
 * TC-2d / audit can distinguish the boot trust anchor from a registry-
 * resolved peer.
 */
export type EntryProvenance = "local-boot" | "resolved-registry";

/**
 * A single verified principal entry held by the registry.
 */
export interface PrincipalEntry {
  /** The principal id (e.g. `andreas`) — the map key. */
  readonly principalId: string;
  /**
   * The materialised myelin `Identity` for this principal. Fed verbatim
   * into the myelin `IdentityRegistry` that the crypto-verify path consumes.
   */
  readonly identity: Identity;
  /** How this entry's pubkey was established. See {@link EntryProvenance}. */
  readonly provenance: EntryProvenance;
}

/**
 * Outcome of an async {@link MultiPrincipalIdentityRegistry.resolve}.
 * Discriminated so TC-2d can branch: a positive feeds the entry into the
 * verify path; every negative rejects the inbound envelope.
 */
export type RegistryResolveOutcome =
  | { resolved: true; entry: PrincipalEntry }
  | {
      resolved: false;
      /**
       * Why the peer could not be resolved:
       *   - `"disabled"`    — federation verify is OFF (resolver inert / absent);
       *                       no I/O was performed.
       *   - `"not_found"`   — the registry returned 404 for this principal id.
       *   - `"unresolved"`  — transient/structural failure (network, parse,
       *                       signature, mismatch). Retry-able; not cached.
       */
      reason: "disabled" | "not_found" | "unresolved";
    };

/** Construction options for {@link MultiPrincipalIdentityRegistry}. */
export interface MultiPrincipalIdentityRegistryOptions {
  /**
   * The local boot principal — the pinned, always-present, never-overwritten
   * trust anchor. `principalId` is its map key; `identity` is the myelin
   * `Identity` to materialise into the verify registry (the same shape
   * `buildIdentityRegistry` constructs for the local stack).
   */
  bootPrincipal: { principalId: string; identity: Identity };
  /**
   * On-demand peer-pubkey resolver (TC-2a). When omitted, peer lookups are
   * inert (`resolve()` returns `{ resolved: false, reason: "disabled" }`)
   * — the single-principal back-compat path. When present, its OWN
   * `enabled` flag (driven by `signing === "enforce"`) decides whether it
   * reaches out: a disabled resolver short-circuits to `{ status:
   * "disabled" }` with zero I/O, surfaced here as `reason: "disabled"`.
   */
  resolver?: Pick<PrincipalPubkeyResolver, "resolve">;
  /**
   * The owning-network slug stamped onto resolved peer `Identity` objects'
   * `network` field. For a federated peer the network IS the peer's own
   * principal id (the bus-addressing model — see `verify-signed-by-chain.ts`
   * R4 note). Defaults to the resolved peer's own `principalId`.
   */
  peerNetwork?: (principalId: string) => string;
  /**
   * Logger seam — defaults to writing to `process.stderr` (CLAUDE.md
   * "no empty catches"). Tests inject a spy / no-op.
   */
  logError?: (msg: string) => void;
}

/**
 * Build the DID for a peer principal's federation identity. Peers are
 * stamped with `did:mf:<principalId>` — the principal-level identity that
 * signs `federated.{principal}.{stack}` envelopes. Mirrors the
 * `did:mf:<id>` convention `buildIdentityRegistry` uses for local agents.
 */
function peerDid(principalId: string): string {
  return `did:mf:${principalId}`;
}

/**
 * Multi-principal, peer-stamped identity registry. Construct once at boot
 * with the local boot principal pinned + (optionally) the TC-2a resolver,
 * then:
 *   - `get(principalId)` — synchronous lookup against what's already stored.
 *   - `resolve(principalId)` — async resolve-and-cache for unknown peers
 *     (posture-gated via the resolver).
 *   - `toIdentityRegistry()` — materialise the myelin `IdentityRegistry`
 *     the crypto-verify path consumes.
 *
 * Single-process, in-memory.
 */
export class MultiPrincipalIdentityRegistry {
  /** `principal_id → verified entry`. The boot principal is pinned here. */
  private readonly entries = new Map<string, PrincipalEntry>();
  /** The boot principal id — immutable, never overwritten by a peer. */
  private readonly bootPrincipalId: string;
  private readonly resolver: Pick<PrincipalPubkeyResolver, "resolve"> | undefined;
  private readonly peerNetwork: (principalId: string) => string;
  private readonly logError: (msg: string) => void;

  constructor(options: MultiPrincipalIdentityRegistryOptions) {
    this.bootPrincipalId = options.bootPrincipal.principalId;
    this.resolver = options.resolver;
    this.peerNetwork = options.peerNetwork ?? ((id) => id);
    this.logError =
      options.logError ??
      ((msg: string) => {
        process.stderr.write(`identity-registry: ${msg}\n`);
      });

    // Pin the local boot principal — always present, provenance "local-boot".
    this.entries.set(this.bootPrincipalId, {
      principalId: this.bootPrincipalId,
      identity: options.bootPrincipal.identity,
      provenance: "local-boot",
    });
  }

  /**
   * Synchronous lookup against what's ALREADY stored (the pinned boot
   * principal + any peer resolved by a prior `resolve()`). Returns
   * `undefined` for a principal that has not been resolved — the caller
   * should `resolve()` (async) to attempt populating it. NEVER does I/O.
   */
  get(principalId: string): PrincipalEntry | undefined {
    return this.entries.get(principalId);
  }

  /** Whether a principal is already stored (boot or previously-resolved). */
  has(principalId: string): boolean {
    return this.entries.has(principalId);
  }

  /** All stored entries (boot + resolved peers). For audit / introspection. */
  list(): PrincipalEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Resolve `principalId` to its verified entry.
   *
   * Cache-first: a stored entry (boot or previously-resolved) is returned
   * synchronously-fast without I/O. On a miss, consults the TC-2a resolver
   * (when present + enabled); a successful, verified resolve is stamped
   * `provenance: "resolved-registry"`, cached, and returned. Posture-gated:
   * when the resolver is absent or disabled, no I/O is performed and
   * `{ resolved: false, reason: "disabled" }` is returned — only the boot
   * entry (and any earlier-resolved peer) is available.
   *
   * The pinned local boot entry is NEVER overwritten: a resolve for the
   * boot id returns the pinned entry without consulting the resolver, so a
   * registry assertion cannot displace the out-of-band boot anchor.
   *
   * NEVER throws.
   */
  async resolve(principalId: string): Promise<RegistryResolveOutcome> {
    // Cache-first. The pinned boot principal is ALWAYS in `entries` (set in
    // the ctor, never deleted — there is no eviction API), so a resolve for
    // the boot id short-circuits here and the resolver is NEVER consulted
    // for it. This is the mechanism by which a registry assertion can never
    // displace the out-of-band boot anchor: the resolved-peer write below is
    // unreachable for the boot id.
    const cached = this.entries.get(principalId);
    if (cached !== undefined) {
      return { resolved: true, entry: cached };
    }

    // No resolver wired (single-principal back-compat) → inert.
    if (this.resolver === undefined) {
      return { resolved: false, reason: "disabled" };
    }

    const result = await this.resolver.resolve(principalId);
    switch (result.status) {
      case "disabled":
        // Posture OFF — the resolver did no I/O. Federation verify not engaged.
        return { resolved: false, reason: "disabled" };
      case "not_found":
        this.logError(
          `resolve(${principalId}): registry returned not_found; peer is unverifiable`,
        );
        return { resolved: false, reason: "not_found" };
      case "unresolved":
        // Already logged in detail by the resolver; record a clear negative.
        this.logError(
          `resolve(${principalId}): unresolved (transient/structural); peer is unverifiable this attempt`,
        );
        return { resolved: false, reason: "unresolved" };
      case "resolved": {
        // Reached only on a CACHE MISS, so `principalId` cannot be the boot
        // id (boot is always cached above) — the boot anchor is structurally
        // safe from a resolver-supplied pubkey.
        const entry: PrincipalEntry = {
          principalId,
          identity: {
            id: peerDid(principalId),
            display_name: principalId,
            network: this.peerNetwork(principalId),
            public_key: result.principalPubkey,
            type: "agent",
            // Resolved at runtime; the registry record carries no creation
            // timestamp for the peer, so anchor to the epoch (a stable,
            // non-misleading value — myelin only requires a valid ISO-8601).
            created_at: new Date(0).toISOString(),
          },
          provenance: "resolved-registry",
        };
        this.entries.set(principalId, entry);
        return { resolved: true, entry };
      }
    }
  }

  /**
   * Materialise a myelin `IdentityRegistry` containing the pinned boot
   * identity plus every peer resolved so far. This is the shape the
   * crypto-verify path (`verifyEnvelopeIdentity`, TC-2d) consumes. A fresh
   * registry is built per call from the current entry set — cheap (single-
   * digit-to-dozens of entries) and avoids handing the verifier a mutable
   * reference into our internal store.
   */
  toIdentityRegistry(): IdentityRegistry {
    const registry = createInMemoryRegistry();
    for (const entry of this.entries.values()) {
      registry.add(entry.identity);
    }
    return registry;
  }
}
