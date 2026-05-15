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
   * Authorise a principal id to exercise an intent. Returns a
   * `PolicyDecision` discriminated on `allow`.
   *
   * Decision flow:
   *   1. Look up the principal by id. Unknown → `unknown_principal`.
   *   2. Compute effective capabilities = union of every role's
   *      capabilities. Unknown role ids are silently skipped (the
   *      caller's responsibility to keep the principals and roles
   *      lists consistent; in production C.2 will validate this
   *      at config load).
   *   3. Match `intent.capability` against the effective set.
   *      Miss → `insufficient_role`.
   *   4. (Phase D extends with sovereignty / per-peer checks; the
   *      `intent.sovereignty` field is part of the input shape so
   *      C.4 audit envelopes carry it without an extra read.)
   *   5. Allow with the full effective set.
   *
   * Taking an id (not a `Principal` object) is deliberate: the
   * registry is authoritative for roles/trust, and accepting a
   * caller-constructed `Principal` would invite attacker-spoofed
   * `{id, role: ["admin"]}` payloads from parsed envelopes. The
   * dispatch-handler integration in C.3 strips `did:mf:` from a
   * verified `signed_by[].principal` and passes the bare id here
   * (Echo cortex#218 round 1).
   */
  check(principalId: string, intent: Intent): PolicyDecision {
    const known = this.principalsById.get(principalId);
    if (known === undefined) {
      return {
        allow: false,
        reason: { kind: "unknown_principal", principal_id: principalId },
      };
    }

    const effectiveCapabilities = this.effectiveCapabilities(known);

    if (!effectiveCapabilities.has(intent.capability)) {
      return {
        allow: false,
        reason: {
          kind: "insufficient_role",
          missing_capability: intent.capability,
          principal_id: principalId,
        },
      };
    }

    // TODO(phase-D): enforce `intent.sovereignty` — classification,
    // residency, frontier-ok, model-class. C.4 audit envelopes
    // already carry the field; Phase D wires the rejection branch.

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
