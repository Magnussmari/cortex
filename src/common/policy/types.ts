/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine types.
 *
 * The PolicyEngine is the single decision point for "what is this
 * principal allowed to do?" — replacing the per-surface duplication
 * cortex carries today (Discord adapter role-resolver,
 * Mattermost adapter equivalent). Phase C.2 will collapse those into
 * a single `policy:` block on cortex.yaml; this slice (C.1) ships
 * the engine + decision shape.
 *
 * Cross-references:
 *   - `docs/design-internet-of-agentic-work.md` §cortex#107 — the
 *     spec this module implements.
 *   - cortex#114 (Phase B) — `signed_by[].principal` is verifiable
 *     post-Phase B; that DID resolves to a `Principal` here.
 *   - cortex#115 (Phase C umbrella) — this slice + C.2 (schema flip)
 *     + C.3 (harness integration) + C.4 (audit envelopes) +
 *     C.5 (tests + migration).
 */

/**
 * A principal is the identity-bearing actor a dispatch is attributed
 * to. Built from `cortex.yaml.policy.principals[]` post-Phase C.2;
 * for C.1 the engine accepts pre-built principals from its caller
 * (the schema flip happens in C.2 — until then the construction
 * path is wherever the caller assembles them).
 */
export interface Principal {
  /**
   * Stable principal id. Convention: matches `did:mf:<name>`'s
   * `<name>` segment (i.e. agent id), so a verified `signed_by[]`
   * stamp's `principal` field resolves directly to this id by
   * stripping the `did:mf:` prefix.
   */
  id: string;
  /**
   * Operator that owns this principal. Same value across all
   * principals in a single-operator deployment; varies across
   * principals once Phase D federation lands and the registry
   * spans multiple operators.
   */
  home_operator: string;
  /**
   * Stack identity in `{operator_id}/{stack_id}` form (Phase A.5
   * Q7 lock-in). The stack a principal calls "home" — bus
   * envelopes signed on its behalf carry the stack's NKey in
   * `signed_by[]`.
   */
  home_stack: string;
  /**
   * Role ids this principal holds. Each role is defined in
   * `RoleDefinition` and grants a set of capabilities. A principal's
   * effective capabilities are the union of its roles' capabilities.
   */
  role: string[];
  /**
   * Peer principals this principal trusts. Empty array is legal
   * (no peer dispatches allowed). Symmetric with the existing
   * `agent.trust[]` field on `cortex.yaml` (which Phase C.2 will
   * migrate into the top-level `policy:` block).
   */
  trust: string[];
}

/**
 * Sovereignty constraints on an intent. Mirrors the structure of
 * `Envelope.sovereignty` from the myelin schema — the engine reads
 * these fields when deciding whether a dispatch's classification +
 * residency + frontier-model-acceptability are compatible with the
 * principal's allowed scope (Phase D extends with per-network
 * accept/deny rules).
 */
export interface IntentSovereignty {
  classification: "local" | "federated" | "public";
  data_residency: string;
  max_hop: number;
  frontier_ok: boolean;
  model_class: "local-only" | "frontier" | "any";
}

/**
 * The "what is being requested" half of a policy check. The engine
 * matches an intent against the principal's effective capabilities
 * + sovereignty constraints.
 */
export interface Intent {
  /**
   * The capability the principal wants to exercise. Matched
   * against the union of capabilities granted by the principal's
   * `role[]` via `RoleDefinition`.
   */
  capability: string;
  /**
   * Sovereignty constraints from the envelope being dispatched.
   * The engine doesn't enforce sovereignty directly at C.1 — the
   * field is part of the decision input so future C.4 audit
   * envelopes carry it on the access record without an extra read.
   */
  sovereignty: IntentSovereignty;
  /**
   * Short, human-readable summary of the payload. Used only for
   * audit envelopes (C.4) — the engine itself doesn't read it.
   * Kept optional so callers without a useful summary handy don't
   * have to fabricate one.
   */
  payload_summary?: string;
}

/**
 * A role definition: id + the capabilities it grants. Comes from
 * `cortex.yaml.policy.roles[]` post-C.2. The engine takes the
 * principal's `role[]` ids, looks them up here, and unions the
 * capabilities to compute the principal's effective grant set.
 */
export interface RoleDefinition {
  /** Role id (e.g. `operator`, `code-reviewer`). */
  id: string;
  /**
   * Capabilities this role grants. Convention follows Phase A.6
   * capability ids: `<domain>.<entity>` (e.g. `code-review.typescript`).
   * The engine matches `Intent.capability` against this list
   * literally — no glob expansion at C.1; future PRs may add it.
   */
  capabilities: string[];
}

/**
 * Discriminated rejection reason. Matches the shape Phase C.4 audit
 * envelopes need (`system.access.denied` payload's `reason` field).
 * Splitting the kinds at the discriminator now means audit
 * envelopes don't have to re-parse a stringly-typed reason later.
 */
export type PolicyDenyReason =
  | {
      kind: "unknown_principal";
      /** The principal id the caller tried to authorise. */
      principal_id: string;
    }
  | {
      kind: "insufficient_role";
      /** The missing capability — diagnostic, not a hint to the caller. */
      missing_capability: string;
      principal_id: string;
    }
  | {
      kind: "sovereignty_mismatch";
      /** Human-readable description of the mismatch. */
      reason: string;
    };

/**
 * The output of `PolicyEngine.check`. Discriminated on `allow`:
 *   - On accept, the engine surfaces the principal's full effective
 *     capability set so downstream callers (substrate harness,
 *     dispatch-handler) can prune tool/skill lists by what was
 *     actually granted, not just by what the intent asked for.
 *   - On reject, the engine surfaces the structured deny reason
 *     for audit envelopes + operator logs.
 */
export type PolicyDecision =
  | {
      allow: true;
      /**
       * The principal's full effective capability set (union of
       * all role grants). Includes the requested capability plus
       * everything else the principal can do. Downstream callers
       * use this to filter substrate-level allow lists.
       */
      capabilities: readonly string[];
    }
  | {
      allow: false;
      reason: PolicyDenyReason;
    };
