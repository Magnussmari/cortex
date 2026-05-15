/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine implementation.
 *
 * The single authorization decision point for cortex. Replaces the
 * per-surface role-resolver duplication today (Discord adapter +
 * Mattermost adapter equivalent) with one `check(principal, intent)`
 * call. Phase C.2 collapses cortex.yaml's per-adapter `roles[]`
 * into the top-level `policy:` block that constructs the engine;
 * Phase C.3 wires the engine into the dispatch-handler so every
 * inbound dispatch passes through `check` before reaching a
 * substrate harness; Phase C.4 emits `system.access.{allowed,denied}`
 * audit envelopes carrying the decision shape this engine returns.
 *
 * Cross-references:
 *   - `docs/design-internet-of-agentic-work.md` §cortex#107.
 *   - `./types.ts` — `Principal`, `Intent`, `RoleDefinition`,
 *     `PolicyDecision`, `PolicyDenyReason`.
 *
 * What this slice deliberately doesn't do (deferred):
 *   - **No sovereignty enforcement.** `Intent.sovereignty` is part
 *     of the decision input shape so audit envelopes (C.4) carry
 *     it, but the engine doesn't yet reject on sovereignty
 *     mismatches. The `sovereignty_mismatch` deny reason exists
 *     in the discriminator for forward compatibility; today it
 *     never fires. Phase D extends with per-network sovereignty
 *     slicing.
 *   - **No per-peer accept/deny.** Phase D adds
 *     `policy.federated.networks[].accept_subjects[]` /
 *     `deny_subjects[]` enforcement; not in C.1's scope.
 *   - **No glob expansion on capability matches.** Literal
 *     `===` matching only; PRs after Phase C may add patterns.
 */

import type {
  Intent,
  PolicyDecision,
  Principal,
  RoleDefinition,
} from "./types";

export interface PolicyEngineOptions {
  /**
   * All principals known to this engine. Built from
   * `cortex.yaml.policy.principals[]` post-C.2; for C.1 callers
   * assemble manually (the schema flip is the next slice).
   */
  principals: readonly Principal[];
  /**
   * Role definitions, by id. The engine looks up each id in a
   * principal's `role[]` against this list and unions the
   * capabilities to compute the effective grant set.
   */
  roles: readonly RoleDefinition[];
}

export class PolicyEngine {
  private readonly principalsById: ReadonlyMap<string, Principal>;
  private readonly rolesById: ReadonlyMap<string, RoleDefinition>;

  constructor(opts: PolicyEngineOptions) {
    this.principalsById = new Map(opts.principals.map((p) => [p.id, p]));
    this.rolesById = new Map(opts.roles.map((r) => [r.id, r]));
  }

  /**
   * Authorise a principal to exercise an intent. Returns a
   * `PolicyDecision` discriminated on `allow`.
   *
   * Decision flow:
   *   1. Look up the principal. Unknown → `unknown_principal`.
   *   2. Compute effective capabilities = union of every role's
   *      capabilities. Unknown role ids are silently skipped (the
   *      caller's responsibility to keep the principals and roles
   *      lists consistent; in production C.2 will validate this
   *      at config load).
   *   3. Match `intent.capability` against the effective set.
   *      Miss → `insufficient_role`.
   *   4. (Phase D extends with sovereignty / per-peer checks.)
   *   5. Allow with the full effective set.
   *
   * Principal lookup is by id, not by DID — callers strip the
   * `did:mf:` prefix from a verified `signed_by[].principal` before
   * calling. Phase C.3's dispatch-handler integration owns that
   * normalisation; the engine takes ids only.
   */
  check(principal: Principal, intent: Intent): PolicyDecision {
    // Resolve the principal — the caller can pass in a fresh
    // Principal object OR one we already know about. If the
    // caller's object isn't in the registry by id, the principal
    // is "unknown" (an attacker spoofing a principal id would
    // fall through here once the registry is in place).
    const known = this.principalsById.get(principal.id);
    if (known === undefined) {
      return {
        allow: false,
        reason: { kind: "unknown_principal", principal_id: principal.id },
      };
    }

    // Use the REGISTRY's roles/trust, not the caller's. The caller
    // may have constructed the principal from a parsed envelope —
    // role assignments come from cortex.yaml, not the wire.
    const effectiveCapabilities = this.effectiveCapabilities(known);

    if (!effectiveCapabilities.has(intent.capability)) {
      return {
        allow: false,
        reason: {
          kind: "insufficient_role",
          missing_capability: intent.capability,
          principal_id: principal.id,
        },
      };
    }

    // Sovereignty enforcement is a Phase D concern; the field is
    // part of the input shape so audit envelopes (C.4) carry it,
    // and so this codepath has the shape ready when C.4 wires
    // sovereignty-based rejection in.
    void intent.sovereignty;

    return {
      allow: true,
      capabilities: [...effectiveCapabilities],
    };
  }

  /**
   * Union of every role's capabilities for a principal. Unknown
   * role ids are silently skipped here — config validation belongs
   * upstream at parse time (C.2 will add it). Returning a Set
   * keeps the membership check at `check`'s callsite O(1).
   */
  private effectiveCapabilities(principal: Principal): Set<string> {
    const out = new Set<string>();
    for (const roleId of principal.role) {
      const role = this.rolesById.get(roleId);
      if (role === undefined) continue;
      for (const cap of role.capabilities) {
        out.add(cap);
      }
    }
    return out;
  }

  /**
   * Number of registered principals. Useful for boot-log lines +
   * smoke tests.
   */
  get principalCount(): number {
    return this.principalsById.size;
  }

  /**
   * Number of role definitions. Same role: boot-log + smoke.
   */
  get roleCount(): number {
    return this.rolesById.size;
  }
}
