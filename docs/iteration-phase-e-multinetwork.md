# Iteration — IAW Phase E: Multi-network bridges + delegation

**Design spec:** [`docs/design-phase-e-multinetwork.md`](./design-phase-e-multinetwork.md)
**Sibling spec:** [`docs/design-internet-of-agentic-work.md`](./design-internet-of-agentic-work.md) §3.4–§3.6
**Parent:** [cortex#117](https://github.com/the-metafactory/cortex/issues/117) (Phase E umbrella) → cortex#110 (IAW META)
**Blueprint:** I-105 (parent: I-100)
**Predecessor:** cortex#116 (Phase D — merged 2026-05-19)

## Goal

Ship the §3.4 multi-network primitive + the §3.6 delegation pattern. After this iteration closes:

- One cortex daemon participates in N networks concurrently (multi-link `MyelinRuntime`).
- Each `policy.federated.networks[]` entry announces its own capability subset.
- An orchestrator agent reference implementation delegates a federated task and threads results back via chain-of-stamps.
- All four mesh varieties — private, federated, isolated-private (JV), bridge — operable with reference config examples; public mesh schema reserved with no runtime backing.

Phase E delivers the IAW story end-to-end. Closes I-105; closes cortex#117; rolls cortex#110 (META) to "ready to close" pending the operator-vision video being operable in production.

## Why this iteration exists

Phase D (cortex#116, D.1–D.5) shipped single-network federation — `policy.federated.networks[]` schema, per-network surface-router gating, PolicyEngine per-network slicing, cloud-side network registry, multi-operator dashboard slicing. The `leaf_node` field is in the schema but only one entry's leaf-node is operable; `announce_capabilities[]` is in the schema but no producer consumes it; the §3.6 orchestrator pattern is described but no reference implementation exists.

Phase E closes those four gaps without re-architecting Phase D. The design spec (PR pending) ratifies the schema deltas (one extension to `PolicyFederatedNetworkSchema`, one new `PolicyPublicSchema` block, two new cross-validators) and the 6-PR sequence below.

## Dependency DAG

```
E.1 (multi-link runtime) ──┬──► E.2 (per-network capability announce)
                            │
                            └──► E.3 (orchestrator + delegation) ──┐
                                                                    │
E.4 (mesh varieties scaffolding) ─────────────────────────────────► E.5 (integration + prod readiness)
                                                                    │
                                                          E.6 (docs + cortex#117 close-out)
```

- **E.1** is the riskiest piece (MyelinRuntime refactor); ships first.
- **E.2** depends on E.1 (multi-link is the producer's substrate).
- **E.3** depends on E.1 (orchestrator publishes via multi-link). May parallel-develop with E.2 once E.1's interfaces stabilise.
- **E.4** is documentation + reference examples + the public-mesh schema reservation. Parallelisable with E.2 / E.3 — needs only the E.1 schema additions to validate examples.
- **E.5** depends on E.1, E.2, E.3, E.4 — it's the integration test slice.
- **E.6** is the final close-out — design + iteration mark "shipped"; blueprint flips to `done`; cortex#117 closes.

## Effort estimate

Cortex#117 sized at 4–6 weeks (per IAW plan §6). Per-slice breakdown:

| Slice | Scope | Estimate |
|---|---|---|
| E.1 — Multi-link MyelinRuntime | Runtime refactor + per-network `nats:` block schema + link pool + routing layer + lifecycle | 7–10 days |
| E.2 — Per-network capability announcement | Cross-validator + advertisement producer + registry payload extension + registry endpoint extension | 4–6 days |
| E.3 — Orchestrator + delegation primitives | `OrchestratorAgent` + `DelegationDispatcher` + `ReplyCorrelator` + `RegistryClient.findCapability` + correlation tests | 7–10 days |
| E.4 — Mesh variety scaffolding | 5 reference example configs + `PolicyPublicSchema` reservation + `migrate-config --check-public-mesh` + docs | 3–4 days |
| E.5 — Tests + production readiness | Multi-link integration rig + delegation end-to-end + failure-mode coverage | 5–7 days |
| E.6 — Docs + close-out | Status updates + blueprint flips + cortex#117 close | 1–2 days |
| **Total** | | **~27–39 working days** ≈ 5–8 weeks |

Range absorbs review cycles + pilot-loop iteration. Aim for 6 weeks.

## Slices

### cortex#? — IAW E.1: Multi-link MyelinRuntime (the runtime refactor)

The structural piece — turns the single-link `startMyelinRuntime` into a link-pool primitive. Existing single-link deployments must keep working with zero config change (the Phase D `policy.federated.networks[]` entry without a `nats:` block falls back to the primary link).

- [ ] Add optional `nats:` block to `PolicyFederatedNetworkSchema` in `src/common/types/cortex-config.ts` (per design §4.3 Option B)
- [ ] Cross-validator: `policy.federated.networks[].leaf_node` uniqueness across networks (design §12 rule 3)
- [ ] Refactor `src/bus/myelin/runtime.ts` — introduce internal `LinkPool` keyed by `(linkId)` where `linkId === 'primary'` for the cortex.yaml top-level `nats:` connection and `linkId === network.leaf_node` for each per-network connection
- [ ] Per-link lifecycle: connect, drain, reconnect; one link's failure doesn't crash the runtime — disabled-link publishes log + skip
- [ ] `MyelinRuntime.publish(envelope)` routes:
  - `local.*` and `public.*` → primary link
  - `federated.{network}.*` → the link whose owning network has `id === {network}` (parsed from the derived subject's second segment)
  - Misrouted publish (subject names a network not in the pool) → log `system.error` reason `unknown_network_in_publish_subject` + skip
- [ ] `EnvelopeHandler` callback gains optional `sourceLink: string` parameter (additive; existing handlers ignore)
- [ ] `runtime.stop()` drains all links via `Promise.allSettled`; one link's failure doesn't block another's drain
- [ ] `subscribePull` stays bound to the primary link (no per-network JetStream durables in E.1; tracked as future work in design §11.3)
- [ ] Unit tests with mocked `connectImpl` per link covering the routing matrix
- [ ] Backward-compat test: single-network deployment with no `nats:` block on the network entry uses the primary link, identical behaviour to Phase D

**Scope:** ~500 LOC + tests. Single PR. The largest by line-count; ship first because every later slice depends on the pool primitive being stable.

**Acceptance criteria:**

- Two networks declared with distinct `nats:` blocks → two leaf-nodes opened.
- Publish to `federated.research-collab.*` arrives only on the research-collab link's subscribers (verified via mocked `link.publish` capture).
- Phase D regression: existing single-network test rig with no `nats:` block continues to pass without modification.

### cortex#? — IAW E.2: Per-network capability announcement

Wires the existing `announce_capabilities[]` schema field to actual producer + registry surface.

- [ ] Cross-validator in `PolicySchema.superRefine`: `policy.federated.networks[i].announce_capabilities[j]` ∈ top-level `capabilities[].id` set; YAML-pathed error per offender
- [ ] New envelope `type`: `system.network.capability.announced` (no schema change in myelin — just a new `type` literal)
- [ ] Capability announcer module (`src/bus/network-capability-announcer.ts`) — at runtime startup (after E.1's link pool opens), emits one capability-advertisement envelope per network with the network's `announce_capabilities[]` subset of the stack's `capabilities[]`
- [ ] Refresh schedule: re-emit every 24h + on cortex.yaml reload + on `SIGHUP`
- [ ] Extend cloud registry `POST /operators/{id}/register` payload: replace operator-scope capability surface with `network_capabilities: Record<network_id, Capability[]>` (D.4.4 payload retires)
- [ ] Extend cloud registry `GET /capabilities?query=...&network=...` to filter by network id (was unimplemented in D.4)
- [ ] Migration: registry's existing operator-scope index migrates to the per-network shape via one-shot script + version bump on registry's stored assertions
- [ ] `RegistryClient` (consumer-side; D.4.3 carry-over from Phase D) consumes the new per-network shape — landed jointly here if not yet shipped
- [ ] Unit tests for the cross-validator (positive + negative cases)
- [ ] Integration test: stack declares `capabilities: [code-review.typescript, deploy.k8s]`; networks A announces only `code-review`, B only `deploy`; registry queried with `?network=A` returns only code-review; same for B with deploy

**Scope:** ~300 LOC across cortex + registry + tests. Single PR. Cross-repo coordination — the registry change must land first or in lock-step.

**Acceptance criteria:**

- Schema rejects `announce_capabilities[deploy.k8s]` if stack's `capabilities[]` doesn't include `deploy.k8s`.
- Cortex boot emits the right number of advertisement envelopes (one per network with non-empty `announce_capabilities`).
- Registry's `GET /capabilities?network={id}` returns only the network's scope.
- Phase D registration payload shape is retired without orphaned data (migration script verified).

### cortex#? — IAW E.3: Orchestrator + delegation primitives

The reference implementation of the §3.6 orchestrator pattern. New module under `src/agents/orchestrator/`.

- [ ] `RegistryClient.findCapability(query): Promise<Array<CapabilityMatch>>` — wraps Phase D RegistryClient cache; 5-min TTL; refresh on `unknown_federated_peer` deny (per design §7 Q7)
- [ ] `DelegationDispatcher` class:
  - `dispatch({ capability, payload, originalEnvelopeId, networkPreference? })` returns a Promise resolving to the reply envelope
  - Picks target network via configurable strategy (default: first match; operator preference list per capability)
  - Publishes `federated.{network}.tasks.{capability}` envelope with `correlation_id = originalEnvelopeId`
  - Subscribes to reply queue group `qg:{operator}/{stack}:replies:{capability}` on the target link
- [ ] `ReplyCorrelator` class:
  - In-memory map of `outbound.id → { resolve, reject, timeoutHandle, attemptedNetworks: Set<string> }`
  - Reply listener filters inbound envelopes by `correlation_id`
  - `AbortController` with configurable timeout (default 30s, operator-settable per dispatch)
  - On timeout: try next sibling network from preference list; on full exhaustion, emit `system.dispatch.failed` reason `timeout_no_peer_claim` (or `timeout_after_claim` if a peer claimed)
- [ ] `OrchestratorAgent` persona — declared via `agents[].persona: orchestrator` in cortex.yaml; runtime's `claude-code` substrate wraps the persona with delegation tools available to the CC session
- [ ] cortex.yaml schema extension under `agents[].runtime.orchestrator`:
  ```ts
  z.object({
    capability_preference: z.array(z.object({
      capability: z.string(),
      networks: z.array(z.string()),
    })).default([]),
    delegation_timeout_ms: z.number().int().min(1000).default(30000),
    fallback_strategy: z.enum(["sibling_network", "fail"]).default("sibling_network"),
  }).optional()
  ```
- [ ] Unit tests: dispatcher's network selection (preference list, first-match fallback, exhaustion); correlator's timeout + retry behaviour
- [ ] Integration test (in-process): mocked `MyelinRuntime` simulates two networks; orchestrator dispatches to A; mock peer in A replies; correlator resolves; reply threads back

**Scope:** ~600 LOC + tests. Single PR (or split into runtime-side + agent-side if it grows). The single new piece of application architecture in Phase E.

**Acceptance criteria:**

- `delegate()` from inside a CC session publishes a federated envelope on the right link with `correlation_id` matching the inbound request.
- Reply arrives on queue group → correlator resolves → orchestrator threads reply back to original requester.
- Timeout path emits `system.dispatch.failed` with the right reason kind.
- `RegistryClient.findCapability` hits cache on warm path; misses + refreshes on `unknown_federated_peer` deny.

### cortex#? — IAW E.4: Mesh variety scaffolding + public-mesh reservation

Documentation slice + public-mesh schema reservation. No new runtime code paths.

- [ ] Reference example configs in `docs/migration-examples/`:
  - `cortex.private.yaml` — `policy.federated.networks: []`, no leaf-nodes
  - `cortex.federated.yaml` — single network, two peers, single leaf-node
  - `cortex.jv.yaml` — single network, 4 peers, single leaf-node, bidirectional accept
  - `cortex.bridge.yaml` — 2 networks, 1 peer each, 2 leaf-nodes
  - `cortex.public-stub.yaml` — `policy.public.announce_capabilities` declared, no `federated.networks`
- [ ] Boot-time validation that each reference example parses cleanly (test fixture loads each file and asserts no Zod errors)
- [ ] `PolicyPublicSchema` reservation under `policy.public` (design §4.2)
- [ ] Cross-validator: `policy.public.announce_capabilities[]` ⊆ top-level `capabilities[].id` set
- [ ] One-time info log at boot when `policy.public` is declared: *"public mesh declared; capabilities advertised via registry but no public-mesh dispatch path exists yet (deferred to post-IAW)"*
- [ ] `migrate-config --check-public-mesh` flag (new) — warns operators who declare public-mesh that no runtime backs it
- [ ] Mesh-variety SOP doc at `docs/sop-mesh-varieties.md` — walks each variety, when to use it, how to migrate between them
- [ ] Phase D's existing single-network examples (if any) reconciled with the new naming convention

**Scope:** ~100 LOC + 5 example configs + 1 SOP doc + tests. Single PR. Parallelisable with E.2 / E.3.

**Acceptance criteria:**

- Each example file parses against the v2.0.0 cortex config schema.
- Public-mesh declaration emits the info log, doesn't enable any `public.*` publish path.
- `migrate-config --check-public-mesh` exits with appropriate warning code when public-mesh is declared.
- SOP doc reviewed by Andreas; matches the operator-vision script's mesh-variety mental model.

### cortex#? — IAW E.5: Integration tests + production readiness

The integration test slice. Demonstrates the Phase E exit criterion from cortex#117.

- [ ] Multi-process test rig in `src/bus/__tests__/phase-e-bridge-integration.test.ts`:
  - Spawn two `nats-server` processes (different ports) per design §7 Q6 Option (a)
  - Spawn one cortex daemon with two networks (research-collab on server 1, jv-acme-bigcorp on server 2)
  - Spawn two mock peer daemons (one per network)
  - Assert the bridge-stack scenario: alpha publishes to network A, only peer-A claims; alpha publishes to network B, only peer-B claims; chain-of-stamps preserved on both
- [ ] Delegation chain test:
  - Orchestrator on alpha receives an inbound Discord-shaped request
  - Orchestrator delegates to network A → peer-A claims → peer-A replies → alpha threads back
  - All four envelopes' `signed_by[]` chains verify
- [ ] Failure-mode tests:
  - Peer-A goes offline mid-task (kill process); alpha times out; dead-letter envelope on `local.{operator}.{stack}.tasks.dead-letter.{capability}`; reason `timeout_after_claim` or `timeout_no_peer_claim` depending on whether peer-A had claimed
  - Registry unreachable: cortex boots with last-known-good cache; new peer joins network; first dispatch hits `unknown_federated_peer` deny → RegistryClient force-refresh → retry succeeds
  - One leaf-node bounces repeatedly: runtime's reconnect loop doesn't crash; other link keeps running; reconnect recovers without operator intervention
- [ ] Production-readiness checklist:
  - Memory profile of multi-link runtime under load (10 networks, sustained publish/subscribe) — no leaks
  - Reconnect storm test: 100 disconnect/reconnect cycles on one link; runtime stable
  - Log volume audit: no per-publish info logs in steady state (only debug)
  - Metrics surface: per-link connect/disconnect/publish/subscribe counters available via `system.metrics.snapshot`

**Scope:** ~400 LOC of test rig + ~200 LOC of test code. Single PR. Touches the most files but mechanical.

**Acceptance criteria:**

- All bridge-stack assertions green.
- All delegation chain assertions green; chain-of-stamps verified at every hop.
- All failure-mode tests green; failure paths produce the expected audit envelopes.
- Production-readiness checklist signed off by Andreas in the PR review.

### cortex#? — IAW E.6: Docs + cortex#117 close-out

The wrap-up slice.

- [ ] Update `docs/design-phase-e-multinetwork.md` status: "draft" → "shipped"
- [ ] Update `docs/design-internet-of-agentic-work.md` §6 Phase E section — flip checkbox state to all-done
- [ ] Update `docs/plan-internet-of-agentic-work.md` §6 — flip every E.1–E.5 checkbox
- [ ] Update `blueprint.yaml` — I-105 status: `planned` → `done`
- [ ] Update `docs/architecture.md` if the multi-link runtime introduces a M2 contract change worth documenting (likely a one-paragraph addition to §4.2)
- [ ] Close cortex#117 with summary referencing the merged PRs + the integration-test PR's evidence
- [ ] Update the IAW META cortex#110 with a status comment: "Phase E shipped; the operator-vision Internet of Agentic Work story is operable in production end-to-end"
- [ ] Schedule the operator-vision-demo video re-recording (out of this scope but flagged for Andreas)

**Scope:** ~50 LOC of doc + status updates. Single PR. Trivial.

**Acceptance criteria:**

- All status flips done; no stale "draft" or "planned" markers for shipped work.
- cortex#117 closes.
- cortex#110 META has the wrap-up comment.

## Blueprint deltas

I-105 stays as the umbrella for Phase E in `blueprint.yaml`. Per-slice sub-blueprint entries are **not** added — at Phase D precedent (D.1–D.5 tracked as PRs against I-104, not as sub-blueprint entries), per-slice tracking lives on the GitHub sub-issue tree. I-105 flips to `done` only when E.6 closes cortex#117.

If sub-blueprint entries are desired for finer-grained `blueprint ready` queries during the iteration, the convention from cortex#243a etc. would suggest:

- I-117-E1 — Multi-link MyelinRuntime
- I-117-E2 — Per-network capability announcement
- I-117-E3 — Orchestrator + delegation primitives
- I-117-E4 — Mesh variety scaffolding
- I-117-E5 — Integration tests + prod readiness
- I-117-E6 — Docs + close-out

Lean: skip the sub-entries for now (Phase D didn't have them); revisit if `blueprint ready` becomes a daily-driver tool during Phase E execution.

## PR conventions

Per `docs/plan-internet-of-agentic-work.md` §7.2 + the established Phase A–D pattern:

```
feat(<scope>): IAW E.X — <one-line slice description> (refs cortex#117)
```

Example: `feat(bus): IAW E.1 — multi-link MyelinRuntime (refs cortex#117)`

Each PR cites the cortex#117 parent + the iteration plan slice. Pilot-loop drives each PR with Echo as primary reviewer; defer big architectural pushback into a discussion on `design-phase-e-multinetwork.md` rather than blocking the PR.

## Acceptance — when is this iteration done?

- [ ] All 6 sub-issues merged
- [ ] `MyelinRuntime` supports N concurrent NATS links (one per `policy.federated.networks[].leaf_node`)
- [ ] `policy.federated.networks[].leaf_node` references a named NatsLink and routes envelopes correctly
- [ ] Stack declares `capabilities[]`; each network's `announce_capabilities[]` is a validated subset; cloud registry indexes per-network
- [ ] Orchestrator agent reference implementation delegates across networks via chain-of-stamps; reply correlation works end-to-end
- [ ] Bridge-stack integration test passes — one cortex daemon, two networks, traffic on both
- [ ] Mesh varieties documented: private + federated + isolated-private (JV) + bridge operable; public mesh schema reserved + deferred
- [ ] Failure-mode tests all green (peer offline, registry unreachable, leaf-node bouncing)
- [ ] cortex#117 closes; cortex#110 META rolls to "ready to close" pending operator-vision demo
- [ ] `blueprint.yaml` I-105 status flips to `done`

## What this iteration deliberately does NOT do

- **Public mesh dispatch.** Schema reservation only; no `public.*` publish path lands. Tracked as post-IAW future work.
- **JetStream durables per federated network.** Pull-mode subscriptions stay bound to the primary link; per-network durables deferred until a consumer needs them (design §11.3).
- **Multi-stack on one daemon.** One cortex daemon hosts one stack (the Phase A.5 + Q7 convention). Multi-stack-per-daemon is future work; Phase E's link-pool composes with it but doesn't pre-build it.
- **Per-link signing keys.** Single stack NKey signs every outbound envelope. Per-network signing is a future tenancy-isolation feature.
- **Capability marketplace dynamics.** Cost/rate fields on advertisements stay advisory; no orchestrator algorithm consults them yet.
- **Cloud dashboard per-network capability surface.** Phase D D.5 dashboard slicing is per-operator; surfacing per-network capabilities on dashboard cards is a follow-up UX issue, not blocking Phase E exit.

## Status tracking

This iteration's checkboxes ARE the status. As each slice ships, tick its sub-issue's items here AND in cortex#117. When all six are merged, this file's "Acceptance" section ticks fully, I-105 flips to `done`, cortex#117 closes, and the IAW META cortex#110 rolls to ready-to-close.
