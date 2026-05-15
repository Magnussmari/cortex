/**
 * IAW Phase B.1a (cortex#114) — structural verification of an envelope's
 * `signed_by[]` chain against the local trust registry.
 *
 * "Structural" because this slice does NOT verify the ed25519 signature
 * bytes. It checks that every stamp's claimed principal:
 *   1. Resolves to a known agent in the local registry
 *   2. Has an `nkey_pub` declared (the agent intends to sign on the bus)
 *   3. Passes `TrustResolver.trustsByNKey(receivingAgentId, agent.nkey_pub)`
 *      — i.e. the receiving agent's `trust:` list includes this signer
 *
 * Phase B.1c extends this helper to also verify the signature bytes via
 * ed25519 + JCS canonicalization. The structural rejection paths in this
 * slice catch the failure modes that don't require the crypto check:
 * unknown signer, signer-not-configured-for-bus, peer-not-in-trust-list.
 * Adding the bytes check in B.1c collapses the "signer claims X but
 * controls a different key" attack surface; until then a stamp can lie
 * about its principal and a sloppy operator who copy-pasted an unknown
 * agent's NKey into their own agent's `trust:` list would accept it.
 * That's why B.1c is part of Phase B — the structural check alone is
 * not safe to wire into a production inbound path.
 *
 * Hub-stamp variants (`method === "hub-stamp"`) pass through this slice
 * structurally — they're a Phase D concern (federation hub trust). B.1a
 * neither rejects nor verifies them; they're surfaced as "unverified" in
 * the result so a strict caller can opt to reject all non-bare-ed25519
 * chains.
 */

import {
  getSignedByChain,
  type Envelope,
  type SignedBy,
} from "./myelin/envelope-validator";
import { TrustResolver } from "../common/agents/trust-resolver";

// =============================================================================
// Result types
// =============================================================================

/**
 * Reason a stamp failed structural verification. Discriminated union so
 * callers can branch on the specific class for logging / audit (Phase C
 * wires audit envelopes that carry this reason verbatim).
 */
export type ChainRejectionReason =
  | { kind: "empty_chain" }
  | { kind: "unknown_principal"; principal: string }
  | { kind: "principal_has_no_nkey_pub"; principal: string; agentId: string }
  | { kind: "signer_not_trusted"; principal: string; agentId: string };

/**
 * Discriminated outcome of `verifySignedByChain`.
 *
 * - `valid: true` — every ed25519 stamp passed the structural check
 *   (hub-stamps were skipped — see `skipped` for visibility).
 * - `valid: false` — at least one ed25519 stamp failed; `rejectedAt`
 *   is the chain index of the first failing stamp; `reason` carries
 *   the structured failure class. Caller does NOT continue iterating
 *   beyond `rejectedAt`; the first rejection is terminal.
 */
export type ChainVerificationResult =
  | {
      valid: true;
      /** Indices of stamps that were skipped (e.g. hub-stamp method). */
      skipped: number[];
    }
  | {
      valid: false;
      rejectedAt: number;
      reason: ChainRejectionReason;
    };

/**
 * Options for `verifySignedByChain`. Required so this helper is reusable
 * by future harnesses without bundling environment-specific lookups.
 */
export interface VerifySignedByChainOptions {
  /** Trust resolver backed by the local agent registry. */
  resolver: TrustResolver;
  /** The agent id of the receiving / verifying side of the dispatch. */
  receivingAgentId: string;
  /**
   * When true, the helper rejects any envelope whose chain is empty.
   * Default `true` — a B.1b `BusPeerHarness` will use this. Tests + CLI
   * tooling that legitimately accept unsigned envelopes pass `false`.
   */
  rejectEmpty?: boolean;
}

// =============================================================================
// Verification
// =============================================================================

/**
 * Walk `envelope.signed_by` chain (normalised via `getSignedByChain`) and
 * structurally verify each ed25519 stamp against the local trust registry.
 *
 * **Cryptographic signature verification is NOT performed at this slice.**
 * See file header for rationale. Phase B.1c extends this helper.
 *
 * Iteration short-circuits on the first failure (terminal rejection). Chain
 * length is bounded by myelin's envelope schema (max_hop cap) so a linear
 * scan is cheap; no early-exit optimisation needed beyond the natural
 * `return` on rejection.
 */
export function verifySignedByChain(
  envelope: Envelope,
  opts: VerifySignedByChainOptions,
): ChainVerificationResult {
  const chain = getSignedByChain(envelope);
  const rejectEmpty = opts.rejectEmpty ?? true;

  if (chain.length === 0) {
    if (rejectEmpty) {
      return { valid: false, rejectedAt: 0, reason: { kind: "empty_chain" } };
    }
    return { valid: true, skipped: [] };
  }

  const skipped: number[] = [];

  for (let i = 0; i < chain.length; i++) {
    const stamp = chain[i];
    if (stamp === undefined) {
      // Bounds-checked by the loop condition — this branch is structurally
      // unreachable. Kept as a typed guard so lint's no-non-null-assertion
      // gate passes without an inline disable. Skipping rather than
      // throwing matches the file-header rule "must never crash on a
      // malformed stamp."
      continue;
    }
    const stampResult = verifyOneStamp(stamp, opts);
    if (stampResult.kind === "skip") {
      skipped.push(i);
      continue;
    }
    if (stampResult.kind === "reject") {
      return { valid: false, rejectedAt: i, reason: stampResult.reason };
    }
    // stampResult.kind === "accept" — continue to next stamp
  }

  return { valid: true, skipped };
}

// =============================================================================
// Per-stamp helpers (private)
// =============================================================================

type StampOutcome =
  | { kind: "accept" }
  | { kind: "skip" }
  | { kind: "reject"; reason: ChainRejectionReason };

/**
 * Classify a single stamp. Hub-stamps are skipped at this slice — Phase D
 * extends with hub-trust verification. Bare ed25519 stamps run the
 * structural trust check.
 */
function verifyOneStamp(
  stamp: SignedBy,
  opts: VerifySignedByChainOptions,
): StampOutcome {
  if (stamp.method === "hub-stamp") {
    return { kind: "skip" };
  }
  // Discriminated union — narrows to SignedByEd25519 once hub-stamp is out.

  const principal = stamp.principal;
  const agentId = extractAgentIdFromDid(principal);
  if (agentId === undefined) {
    return {
      kind: "reject",
      reason: { kind: "unknown_principal", principal },
    };
  }

  const registry = opts.resolver.getRegistry();
  const agent = registry.tryGetById(agentId);
  if (!agent) {
    return {
      kind: "reject",
      reason: { kind: "unknown_principal", principal },
    };
  }

  if (agent.nkey_pub === undefined) {
    return {
      kind: "reject",
      reason: { kind: "principal_has_no_nkey_pub", principal, agentId },
    };
  }

  const trusted = opts.resolver.trustsByNKey(
    opts.receivingAgentId,
    agent.nkey_pub,
  );
  if (!trusted) {
    return {
      kind: "reject",
      reason: { kind: "signer_not_trusted", principal, agentId },
    };
  }

  return { kind: "accept" };
}

/**
 * Parse a `did:mf:<name>` principal into its agent-id segment. Returns
 * `undefined` for any other DID method or malformed input — the caller
 * surfaces `undefined` as `unknown_principal` rather than throwing,
 * because the inbound-envelope path must never crash on a malformed
 * stamp (an attacker controls the bytes; a thrown exception inside the
 * subscription callback bubbles into nats.js's reconnection logic).
 *
 * `did:mf:` is myelin's convention (see `myelin/specs/`). Other DID
 * methods (`did:key:`, `did:web:`) are out of scope until Phase D
 * federation introduces hub-trust paths.
 */
function extractAgentIdFromDid(principal: string): string | undefined {
  const prefix = "did:mf:";
  if (!principal.startsWith(prefix)) return undefined;
  const tail = principal.slice(prefix.length);
  if (tail.length === 0) return undefined;
  // The myelin convention is `did:mf:<name>` with no further segments;
  // a colon in the tail signals an unsupported DID variant.
  if (tail.includes(":")) return undefined;
  return tail;
}
