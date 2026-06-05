# ADR 0002 — Federated dispatch addressing + the review-loop verdict-back contract

**Status:** Accepted (2026-06-05)
**Supersedes:** the `extensions.network_id` + network-id-in-`source` approach of pilot#148/#149 (the requester-side counterpart of the cortex#661 grammar that [ADR-0001](./0001-federated-subject-grammar.md) already retired cortex-side).
**Relates:** ADR-0001 (federated subject grammar), CONTEXT.md §Network/§Dispatch/§capability, cortex#686 (consumer), pilot#149 (requester).

## Context

ADR-0001 put `federated.{principal}.{stack}.…` on the wire and took the network **off** the wire (resolved from topology via `policy.federated.networks[].peers[]` at `selectLink`). That settled the *grammar*. It did **not** settle two application questions the cross-principal review loop hinges on:

1. **How does a cross-principal REQUEST address the TARGET** when `myelin.deriveNatsSubject` builds the subject's `{principal}.{stack}` from **`envelope.source`'s first segments**, and the receiver subscribes to `federated.{its-own-principal}.{its-stack}.…`?
2. **How is the REQUESTER carried** so the target can route the verdict **back** to the right principal?

Getting this wrong has happened three times: cortex#661 (network on wire), pilot#149-as-written (network_id in `source[0]`), and cortex#686/#715 (requester parsed from the inbound subject segment — which is the *receiver's* identity → verdict routed to self → loop never closes).

## Decision

### 1. `source` addresses the TARGET; `originator` carries the REQUESTER

For a cross-principal dispatch:

- **`envelope.source`** first segments are the **TARGET** `{principal}.{stack}` — because `deriveNatsSubject` derives the subject from `source`, and the receiver subscribes to its own identity. This is the *addressing* role.
- **`envelope.originator.identity`** is the **REQUESTER** `{principal}/{stack}` — "who the signer is acting on behalf of" (CONTEXT.md §capability: *"only the `originator` field and the scope vary by source"*; `originator` is a signed/signable field). This is the *attribution + reply-to* role.
- The **network is never on the wire.** No `extensions.network_id` is required for routing; `selectLink` resolves the target leaf from the target principal (subject segment[1]) via `peers[]`.

### 2. REQUEST subjects (requester → target)

| Mode | subject | `distribution_mode` |
|---|---|---|
| **Offer** | `federated.{target-principal}.{target-stack}.tasks.code-review.{flavor}` | `broadcast` |
| **Direct** | `federated.{target-principal}.{target-stack}.tasks.@{did-encoded-reviewer}.code-review.{flavor}` | `direct` |

- `source = {target-principal}.{target-stack}.pilot`
- `originator.identity = {requester-principal}/{requester-stack}`, `originator.method = federated`
- `sovereignty.classification = federated`, `max_hop = 1`

### 3. VERDICT-BACK (target → requester)

The target's review consumer (cortex#686) derives the requester from **`originator.identity`** (NOT the inbound subject, NOT `source`), then publishes with `source` addressing the **requester's** scope:

- verdict: `federated.{requester-principal}.{requester-stack}.review.verdict.{approved|changes-requested|commented}`
- lifecycle: `federated.{requester-principal}.{requester-stack}.dispatch.task.{started|completed|failed|aborted}`
- the verdict envelope's `source = {requester-principal}.{requester-stack}.{reviewer}`; its `originator.identity` = the replying reviewer.

The requester (`pilot --wait`) subscribes its **own** `federated.{requester-principal}.{requester-stack}.review.verdict.>` + `…dispatch.task.>`, matched by `correlation_id` (subject-agnostic matcher).

### 4. CLI addressing (pilot)

- `--principal {principal}/{stack}` → **Offer** (capability-routed to that stack's reviewer pool).
- `--reviewer {name}@{principal}/{stack}` → **Direct** (named assistant on that stack).
- **No `--network` on the wire.** If a topology/leaf selector is needed it is a *connection* concern, never a subject segment.
- **No silent local fallback:** a federated request that resolves to the local sentinel fails closed (CLI exit 2 / `invalid_target` at the publish boundary — nothing emitted).

### 5. Defense-in-depth (cortex consumer)

The federated review consumer MUST run the `peers[]` membership gate (`resolveSourceNetwork(principalFromEnvelope(...))`) on the inbound path that spawns the reviewer — under `signing: off` the gate (peer membership) is the application-layer boundary; under `enforce` the `signed_by` chain + `originator` signature add the crypto check.

## Consequences

- **pilot#149** is reworked: drop network_id-in-`source`/`extensions.network_id`; `source` addresses the target, `originator` carries the requester; `--principal`/`--reviewer@p/s` replace `--network`; `--wait` subscribes the requester's own federated scope.
- **cortex#686** derives the requester from `originator.identity` (fixes verdict-to-self), wires the `peers[]` gate into the consumer, and publishes the verdict to the requester's scope.
- The two land **in lockstep** — the loop closes only when both conform to this contract.
- No production traffic to migrate (no federated review consumer is live yet — ADR-0001 §Consequences).
- Backward-compat: with no `--principal`/`--reviewer@p/s`, every pilot path stays byte-identical to local today.
