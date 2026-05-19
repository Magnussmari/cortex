# Design — IAW Phase E: Multi-network bridges + delegation (cortex#117)

**Status:** draft — design review pending (Andreas, Echo). No implementation in this PR; the iteration plan ([`docs/iteration-phase-e-multinetwork.md`](./iteration-phase-e-multinetwork.md)) sequences PRs.
**Parents:** cortex#117 (Phase E umbrella) → cortex#110 (IAW META) → I-105 (blueprint).
**Lineage:** Phase A (cortex#113) shipped stack identity + classification unhardcode; Phase B (cortex#114) shipped chain-of-stamps verification + outbound signing; Phase C (cortex#115) shipped PolicyEngine at M6; Phase D (cortex#116, D.1–D.5 merged 2026-05-19) shipped `policy.federated.networks[]` + surface-router federation gating + cloud network registry + multi-operator dashboard slicing. Phase E is the last of the five IAW phases.
**Owners:** Andreas (operator + scope), Architect (this doc), Echo (review).
**Decision basis:** `docs/design-internet-of-agentic-work.md` §3.4–§3.6 + §5 Q4 lock-in (2026-05-13 Andreas) + cortex#117 scope sketch.

---

## 1. Why we're writing this

Phase D delivered single-link federation: one cortex daemon, one `NatsLink`, one `MyelinRuntime`, one entry in `policy.federated.networks[]` operable at a time. The `leaf_node` field already exists in the schema and is documented as forward-compat for Phase E (`src/common/types/cortex-config.ts:1427-1431`). The cortex daemon today reads N networks from `cortex.yaml` and ignores all but the first — Phase D explicitly punts multi-link to Phase E.

The naive read of cortex#117 is "open N NATS connections instead of one and we're done." That framing **understates the work** in four ways:

1. **`MyelinRuntime` is structurally single-link.** `startMyelinRuntime` (`src/bus/myelin/runtime.ts:301`) is a factory that returns one runtime handle per process. Its closure captures a single `NatsLink`, a single subject-substituter, a single signer config, a single `subscribers[]` array. The `publish(envelope)` path derives one subject and writes it to one link. There is no internal concept of "which link does this envelope belong to" because today the answer is always "the one." E.1 changes that primitive — the refactor isn't additive on top of the existing runtime, it's a fan-out layer that wraps the existing runtime per network plus a routing decision on every publish.

2. **Per-network capability announcement is not "filter the announcement list".** Phase D `announce_capabilities[]` lives on each `PolicyFederatedNetwork` entry as a static schema field, but no code today _consumes_ it. There is no producer that publishes capability advertisements onto a specific network; the cloud registry's `POST /operators/{id}/register` (D.4.2) accepts a top-level capability surface, not a per-network breakdown. E.2 wires both: producer-side per-network announcement, registry-side per-network indexing, and the operator pre-condition that `announce_capabilities[]` ⊆ the stack's top-level `capabilities:` block.

3. **The §3.6 orchestrator-agent pattern is not a daemon — it's a contract.** The design doc describes "orchestrator agent reads capability registry, picks network, emits envelope, threads reply." That contract requires: (a) a registry-client read path the agent can call from inside a CC session; (b) a publish path that picks the right link based on target network; (c) a reply correlation primitive that binds an inbound chain-of-stamps response to the original outbound dispatch ID across networks. The reference implementation we ship in E.3 has to demonstrate all three; the rest is application code on top.

4. **Mesh varieties are configuration patterns, not runtime modes.** "Private", "isolated-private (JV)", "bridge", and "public stub" are not feature flags — they're shapes of `policy.federated.networks[]` plus a documented operator workflow. E.4 is mostly docs + examples + one new schema reservation for the public stub; the runtime doesn't branch on variety. The work is in making sure each variety's example config parses, boots, and matches the design doc's mental model.

A "wrap MyelinRuntime in a Map<networkId, runtime>" PR would technically satisfy E.1's subject-routing exit criterion and look like Phase E shipped. It would leave E.2 unimplemented (no producer), E.3 unimplemented (no orchestrator), the registry untouched, and the mesh-variety story undocumented. **This doc decides the shape of all five sub-deliverables before any code lands, then the iteration plan is mechanical.**

---

## 2. Current state — Phase D end-state (2026-05-19)

Anchoring in shipped code. After cortex#116 merged D.1–D.5, the cortex daemon's federation surface is:

### 2.1 Single MyelinRuntime, single NatsLink

`startMyelinRuntime(config, options?)` (`src/bus/myelin/runtime.ts:301-686`) returns a single `MyelinRuntime` whose closure captures:

- one `link: NatsLink` (`runtime.ts:399`) — the only NATS connection the runtime opens.
- one `subjects: string[]` (`runtime.ts:380`) — the operator's `nats.subjects` patterns after `{org}` + `{stack}.` substitution.
- one `signer?: BusEnvelopeSigner` (`runtime.ts:492`) — the stack-level signing keypair; Phase B wired this.
- one `stack?: string` (`runtime.ts:499`) — the operator stack segment fed into `deriveNatsSubject`.
- one `subscribers: MyelinSubscriber[]` (`runtime.ts:430`) — the push-mode subscribers for the configured patterns, plus pull-mode subscribers added via `subscribePull`.
- one `handlers: Set<EnvelopeHandler>` (`runtime.ts:310`) — fan-out registry for the surface-router and other consumers.

The runtime has no concept of "network" at all. Every published envelope goes to the single `link.publish(subject, ...)` call (`runtime.ts:599`). Every received envelope is fan-out via the single `handlers` set with the actual subject as a string.

### 2.2 Single `federated.{network}.>` subject namespace, single leaf-node operable

`policy.federated.networks[]` (Phase D.1, `src/common/types/cortex-config.ts:1414-1499`) carries the network array. The schema permits N entries. The runtime today reads them but cannot open more than one leaf-node because there is only one `MyelinRuntime` and one `NatsLink`. The D.1.3 plan-item explicitly notes: *"in Phase D, only one network leaf-node is operable concurrently."* If an operator configures two networks, the second leaf-node reference dangles — the schema parses, the daemon boots, and only the first network exchanges traffic.

Phase D's D.2 + D.3 + D.5 work happens at the application layer above the runtime — surface-router gates inbound `federated.*` envelopes via `accept_subjects`/`deny_subjects` against the matched network (`src/bus/surface-router.ts:651-720`); PolicyEngine slices per-network via `intent.source_network` (`src/common/policy/engine.ts:208-264`); the dashboard slices per-operator via `principal.home_operator`. All three components are network-aware — but they receive a single envelope stream from a single runtime.

### 2.3 Cloud registry is operator-scoped, not yet per-network on consume

`src/services/network-registry/` shipped at D.4. Its endpoints:

- `POST /operators/{id}/register` — operator publishes operator NKey + stack identities + capability declaration (signed assertion).
- `GET /operators/{id}` — peers query operator's current pubkey + stack list.
- `GET /networks/{id}/roster` — query who's in this network.
- `GET /capabilities?query=...` — capability search.

D.4.4 ships the producer surface. D.4.3 (cortex-side `RegistryClient` consume) is open as a Phase D follow-up. The shape of the operator's `register` payload today is a single capability list at the operator/stack scope, not per-network. E.2 must extend it so per-network announcement can route through.

### 2.4 PolicyEngine is per-network aware via `intent.source_network`

`PolicyEngine.check(principal_id, intent)` consumes `intent.source_network` to slice policy by network (`src/common/policy/engine.ts:147-280`). When `intent.source_network !== undefined`, the engine looks up the matching `PolicyFederatedNetwork` by id, verifies the principal's `home_stack` is in the network's `peers[].stack_id` roster, and applies that network's deny reasons (`unknown_network`, `stack_not_in_network`, `unknown_federated_peer`). Local dispatches (`source_network === undefined`) skip the federation branch.

This means the PolicyEngine is **already** the right gate for multi-network dispatch — Phase E does not extend the engine. What changes is the upstream code path that populates `intent.source_network`: today the dispatch-listener derives it from the `federated.{network_id}.>` subject prefix of an inbound envelope arriving on the single link. In Phase E, with multiple links, the source-network derivation must hold: each link's inbound envelopes carry the network id that matches the link they arrived on, and the dispatch-listener still parses it out of the subject.

### 2.5 What Phase D leaves on the table for Phase E

| Surface | Phase D state | Phase E target |
|---|---|---|
| `MyelinRuntime` | Single link, no concept of network | Pool of links keyed by network id; per-publish routing decision |
| `NatsLink` per network | First entry only | One per `policy.federated.networks[].leaf_node` |
| `announce_capabilities[]` consumption | Static schema field; no producer | Producer publishes per-network capability advert at boot + refresh |
| Cloud registry per-network | Operator-scope `POST /register` | Per-network capability scoping in registration payload |
| Orchestrator agent pattern | Not shipped | Reference implementation under `src/agents/orchestrator/` |
| Reply correlation across networks | Not exercised | Envelope-id-bound per-link queue group |
| Mesh varieties | Implicit from Phase D shape | Documented + scaffolded with reference configs |
| Public mesh | Not declared | `policy.public.announce_capabilities[]` reserved (no impl) |

---

## 3. Target state — Phase E end-state

### 3.1 Multi-link MyelinRuntime (E.1)

**Principle:** one `MyelinRuntime` instance per cortex process owns a *pool* of `NatsLink`s, one per `policy.federated.networks[].leaf_node`. Existing single-link deployments (no `policy.federated.networks[]` entries, or all networks sharing the operator's primary `nats.url`) keep their current single-link behaviour with zero config change.

**Shape:**

```
┌────────────────────────────────────────────────────────────────┐
│  MyelinRuntime                                                 │
│                                                                │
│  ┌──────────────┐  primary link (cortex.yaml.nats.url) ─────┐  │
│  │  primary     │   - `local.{org}.{stack}.>`               │  │
│  │  NatsLink    │   - operator-internal `system.*`          │  │
│  └──────────────┘   - JetStream consumers (review etc.)     │  │
│                                                              │  │
│  ┌──────────────┐  network: research-collab                 │  │
│  │  network     │   - `federated.research-collab.>`         │  │
│  │  NatsLink #1 │   - announce_capabilities[]               │  │
│  └──────────────┘                                            │  │
│                                                              │  │
│  ┌──────────────┐  network: jv-acme-bigcorp                 │  │
│  │  network     │   - `federated.jv-acme-bigcorp.>`         │  │
│  │  NatsLink #2 │   - announce_capabilities[]               │  │
│  └──────────────┘                                            │  │
│                                                              │  │
│  Routing rule: publish() derives `(classification, network)` │  │
│  from envelope; routes to the link that owns that network.   │  │
│  Local + public → primary link.                              │  │
└────────────────────────────────────────────────────────────────┘
```

**Lifecycle.** Each link is opened lazily at runtime startup. A link failure (connect failed, leaf-node unreachable) does NOT crash the runtime — it logs, marks that link disabled, and the routing layer falls back to `dispatch.task.failed` for envelopes targeting that network. Other links keep operating. `runtime.stop()` drains every link concurrently (`Promise.allSettled`) before closing each one.

**Subject scoping.** The single `publish(envelope)` entry point on the runtime interface is preserved. The internal routing layer inspects `envelope.sovereignty.classification` and, when federated, the `federated.{network_id}.` prefix of the derived subject. The matching link receives the publish. Subjects on the wire are unchanged from Phase D's grammar.

**Inbound attribution.** Every link's subscribers fan out into the shared `handlers` set with the actual subject (already true today). The dispatch-listener already derives `source_network` from `federated.{network_id}.>`. The new affordance E.1 adds is an **optional `sourceLink: string` parameter** on the `EnvelopeHandler` callback, so consumers that need to correlate "which link delivered this" without re-parsing the subject can do so. This is additive — existing handlers ignore the parameter.

**JetStream caveat.** `subscribePull` (`runtime.ts:619`) binds JetStream consumers on the primary link. Phase E does NOT extend pull-mode subscriptions across multiple links — federated traffic flows via push-mode subscribers in Phase D; JetStream durables per federated network is a follow-up (§7 open question). The review-consumer + capability-dispatch durable consumers stay on the primary link, observing `local.{org}.{stack}.tasks.>`.

### 3.2 Per-network capability announcement (E.2)

**Pre-condition:** every `policy.federated.networks[entry].announce_capabilities[]` must be a **subset** of the stack's top-level `capabilities[].id` set (Phase A.6 — `src/common/types/cortex-config.ts` `CapabilitySchema`). A schema cross-validator added to `PolicySchema.superRefine` rejects on parse if `announce_capabilities[]` contains an id not present in the top-level `capabilities:` block. Operators get a YAML-pathed error like:

```
policy.federated.networks[0].announce_capabilities[2]: capability "deploy.k8s" is not declared in top-level capabilities[].id — declare it stack-wide before announcing per-network
```

**Producer.** At runtime startup, after the network's link is open, the cortex daemon emits one capability-advertisement envelope per network:

```yaml
type: system.network.capability.announced
sovereignty:
  classification: federated
  data_residency: NZ
  max_hop: 0
  frontier_ok: true
  model_class: any
payload:
  network_id: research-collab
  announced_by: andreas/research
  capabilities:
    - id: code-review.typescript
      description: "..."
      tags: [typescript, code-review]
      provided_by: [echo]
      rate: { per_minute: 10 }
      cost: { cents_per_request: 2 }
    - id: security-scan.npm-audit
      ...
```

The envelope is signed (chain-of-stamps `signed_by[0]` = stack NKey), goes on `federated.research-collab.system.network.capability.announced` for any peer subscribing to capability advertisements on that network. Refresh cadence: at boot + on `cortex.yaml` reload + every 24h. The advertisement is **idempotent** — peers index by `(network_id, announced_by, capability.id)` tuple.

**Registry coupling.** When `policy.federated.registry` is declared (Phase D.4 — optional block), the same per-network capability surface is also `POST`ed to `/operators/{id}/register` with a new payload shape:

```json
{
  "operator_pubkey": "...",
  "stacks": [{ "id": "andreas/research", "nkey_pub": "..." }],
  "network_capabilities": {
    "research-collab": [
      { "id": "code-review.typescript", ... },
      { "id": "security-scan.npm-audit", ... }
    ],
    "jv-acme-bigcorp": [
      { "id": "deploy.k8s", ... }
    ]
  }
}
```

The existing operator-scoped capability surface (D.4.4) retires in favour of the per-network shape. The registry's `GET /networks/{id}/roster` already returns per-network membership; `GET /capabilities?query=...&network=research-collab` becomes the network-scoped query and was unimplemented in D.4 — E.2 wires it.

**Test acceptance.** Stack declares top-level `capabilities: [code-review.typescript, deploy.k8s]`; networks A `announce_capabilities: [code-review.typescript]` and B `announce_capabilities: [deploy.k8s]`. Cloud registry queried with `?network=A` returns only code-review; queried with `?network=B` returns only deploy. Cross-network leakage is a regression.

### 3.3 Delegation pattern primitives (E.3)

**Mental model.** The orchestrator agent is a persona on a stack whose job is to *route work*, not to do it. Inbound user requests arrive on the operator's local subjects (Discord message, dashboard task). The orchestrator reads the network capability registry, picks a target network + capability, emits a federated dispatch envelope, awaits the chain-of-stamps reply, and threads results back to the original requester.

**Reference implementation.** A new module `src/agents/orchestrator/` ships in E.3 with:

- `OrchestratorAgent` class implementing the existing agent contract.
- `RegistryClient.findCapability(query)` — wraps the Phase D `RegistryClient` to expose a higher-level "find me a network providing capability X" query. Returns `Array<{ network_id, providers: Array<{ stack_id, principal_id }>, cost?, rate? }>`.
- `DelegationDispatcher.dispatch({ capability, payload, originalEnvelopeId })` — picks a target network using a configurable strategy (default: first match; operator can configure a preference list per capability), emits `federated.{network}.tasks.{capability}` via `MyelinRuntime.publish`, registers a reply listener bound to `originalEnvelopeId`.
- `ReplyCorrelator` — maps `outbound_envelope.id` to a Promise that resolves when an inbound envelope arrives whose `correlation_id === outbound.id` and whose `signed_by[]` chain includes a stamp from a peer on the target network. Timeout via `AbortController` (default 30s, configurable). On timeout, the correlator either tries a sibling network (if multiple matched the capability) or emits `dispatch.task.failed` to the original requester.

**Wire shape.**

```
Inbound:  local.andreas.research.discord.message      (Discord → orchestrator)
Outbound: federated.research-collab.tasks.code-review.typescript
                                          ↑ signed_by[0] = andreas/research stack NKey
                                          ↑ correlation_id = inbound envelope.id

Reply:    federated.research-collab.tasks.code-review.typescript.result
                                          ↑ signed_by[0] = jcfischer/sage-host
                                          ↑ signed_by[1] = andreas/research (we re-stamp on receive
                                            so audit shows we processed the reply)
                                          ↑ correlation_id = original inbound id

Threaded: local.andreas.research.discord.message.reply  (orchestrator → Discord)
```

**Queue group semantics.** Per Q5 lock-in, claim-first-wins via NATS queue groups. The reply subject's queue group is the orchestrator's per-link subscriber group, scoped to the dispatcher's stack: `qg:andreas/research:replies:{capability}`. This ensures that if the orchestrator runs N replicas of the same stack (Phase E does not, but a future operator might), only one replica picks up each reply.

**Failure handling.** Three failure modes:

1. **Timeout — no peer claims within window.** Configurable per dispatch; default 30s. On timeout, the correlator tries the next sibling network if `RegistryClient.findCapability` returned multiple. If all networks exhausted, emit `system.dispatch.failed` to the original requester with reason `timeout_no_peer_claim`.

2. **Peer claimed but never replied.** A peer's stack acked the request via queue group but never produced a reply envelope. Detected by the same correlator timeout. Reason: `timeout_after_claim`. Audit envelope carries the claiming stack id so operators can investigate.

3. **Reply chain-of-stamps verification fails.** Inbound reply's `signed_by[]` does not verify (Phase B verification triggers). The reply is dropped at the envelope-validator layer before reaching the correlator; the correlator hits the same timeout flow. Audit envelope carries `chain_verification_failed` + the failing stamp position.

**The reference implementation is application code.** It uses only the existing primitives — `MyelinRuntime.publish`, `MyelinRuntime.onEnvelope`, `RegistryClient.findCapability`, `PolicyEngine.check`. Phase E adds zero new bus primitives; it adds one new agent persona + correlation library.

### 3.4 Mesh varieties (E.4)

Phase D's `policy.federated.networks[]` schema already supports four mesh shapes via configuration. E.4 documents each, ships a reference example, and reserves the public-mesh schema for future work. **No new runtime modes.**

#### 3.4.1 Private mesh — `policy.federated.networks: []`

Operator runs cortex with no federation. Already operable post-Phase D. `MyelinRuntime` opens only the primary link; `federated.*` subjects never appear on the wire because the operator's NATS topology has no leaf-nodes. The schema permits — and Phase E confirms — `networks: []` as the explicit "private" declaration.

Reference example: `docs/migration-examples/cortex.private.yaml`.

#### 3.4.2 Federated mesh — `policy.federated.networks[]` with N≥1 entries, one peer each

The Phase D shipped pattern: one operator participates in one or more networks, each with one or more peer operators. Phase E adds nothing here — already operable. The reference example is the one Phase D shipped, kept consistent with the new Phase E `announce_capabilities[]` subset rule.

Reference example: `docs/migration-examples/cortex.federated.yaml`.

#### 3.4.3 Isolated-private mesh (JV pattern) — multi-peer single-network with bidirectional accept

Four companies running a joint venture. Each operator's `policy.federated.networks[]` has one entry; that entry's `peers[]` lists the other three. `accept_subjects[]` is bidirectional — operator A accepts traffic from B/C/D on the JV subject space, and B/C/D accept from A. No external bridge; the JV namespace `jv-acme-bigcorp` is closed.

Reference example with 4 peer stacks: `docs/migration-examples/cortex.jv.yaml`. Each operator publishes the same network entry shape with permuted peer lists.

#### 3.4.4 Bridge mesh — one stack in N networks

One operator's stack participates in two or more networks simultaneously. `policy.federated.networks[]` has N≥2 entries with distinct `leaf_node` references. The bridge stack announces `code-review` to network A and `deploy` to network B; cross-network traffic is the orchestrator's job (§3.3), not the runtime's. Networks remain structurally independent — a `federated.research-collab.*` envelope never crosses to the `jv-acme-bigcorp` link unless an orchestrator explicitly delegates.

Reference example: `docs/migration-examples/cortex.bridge.yaml`.

#### 3.4.5 Public mesh stub — schema reserved, no implementation

`policy.public` block reserved in cortex-config schema with one field:

```ts
PublicMeshSchema = z.object({
  announce_capabilities: z.array(z.string().regex(CAPABILITY_ID_REGEX)).default([]),
});
```

E.4 lands this schema entry, validates it parses, and ships a `migrate-config --check-public-mesh` flag that warns if declared (since no implementation backs it). The public-mesh dispatch path lands in a post-IAW phase. Operators declaring `policy.public.announce_capabilities[...]` today get a parse-time info log: *"public mesh declared; capabilities advertised on the public registry but no public-mesh dispatch path exists yet (deferred to post-IAW future work)."*

---

## 4. Schema deltas

The Phase E schema deltas are minimal — Phase D landed `policy.federated.networks[]` with the right shape. E adds three things:

### 4.1 `announce_capabilities[]` ⊆ `capabilities[].id` cross-validation

Added in `PolicySchema.superRefine` (`src/common/types/cortex-config.ts:1574`). Iterates every `policy.federated.networks[i].announce_capabilities[j]`, checks each is present in the top-level `capabilities[].id` set, emits a Zod path-shaped error if not.

```ts
const declaredCapIds = new Set(config.capabilities?.map(c => c.id) ?? []);
policy.federated?.networks.forEach((n, networkIdx) => {
  n.announce_capabilities.forEach((cap, capIdx) => {
    if (!declaredCapIds.has(cap)) {
      ctx.addIssue({
        code: "custom",
        message: `capability "${cap}" is not declared in top-level capabilities[].id — declare it stack-wide before announcing per-network`,
        path: ["federated", "networks", networkIdx, "announce_capabilities", capIdx],
      });
    }
  });
});
```

This is the only **breaking** schema change in Phase E — operators with networks announcing undeclared capabilities will fail to parse. Migration: `migrate-config --check` (already extended in v2.0.0 cutover) flags the mismatch with a hint.

### 4.2 `policy.public.announce_capabilities[]` reservation

New optional block at the same level as `policy.federated`. Schema:

```ts
export const PolicyPublicSchema = z.object({
  announce_capabilities: z.array(
    z.string().regex(CAPABILITY_ID_REGEX),
  ).default([]),
});

export const PolicySchema = z.object({
  principals: z.array(PolicyPrincipalSchema).default([]),
  roles: z.array(PolicyRoleSchema).default([]),
  federated: PolicyFederatedSchema.optional(),
  public: PolicyPublicSchema.optional(),  // NEW — E.4.3
});
```

The `public.announce_capabilities[]` ⊆ `capabilities[].id` cross-validation runs alongside the federated one.

### 4.3 `NatsLink` config reference shape (no schema change)

`policy.federated.networks[].leaf_node` already accepts a string id (Phase D, `src/common/types/cortex-config.ts:1432`). E.1 adds the operator-side **NATS connection registry** that resolves `leaf_node: nats-leaf-research` to a concrete connection. Three options for where that registry lives:

- **Option A — `nats.connections[]` array** at the top level of cortex.yaml, each with `{id, url, credsPath, ...}`. The primary connection has id `primary` by convention.
- **Option B — `policy.federated.networks[].nats:` block** inline per network, mirroring the existing `nats.*` shape. Each network carries its own URL/creds.
- **Option C — operator infra config separate from cortex.yaml** — a sibling `~/.config/cortex/nats-connections.yaml` referenced by id from `cortex.yaml`.

**Decision: Option B.** Per-network `nats:` block inline.

Rationale: it's the shape operators already understand from the primary `nats:` block, it keeps the leaf-node URL + creds beside the network that uses it (operator reading their config can answer "which leaf-node serves this network?" in one place), and it composes naturally with the existing `policy.federated.registry` pattern (also inline). Option A spreads context; Option C adds a file. Both are worse for the operator's mental model.

Schema delta:

```ts
PolicyFederatedNetworkSchema = z.object({
  // existing: id, leaf_node, peers, accept_subjects, deny_subjects, announce_capabilities, max_hop
  nats: z.object({
    url: z.url("network.nats.url must be a valid URL"),
    credsPath: z.string().optional(),
    name: z.string().optional(),
  }),  // NEW — E.1
});
```

`leaf_node` stays as the **logical** id — it's the segment the runtime's link-routing layer uses internally and what `policy.federated.networks[].leaf_node` references in subject derivation logging. `nats.url` + creds is the physical resolution.

**Open question §7 Q1:** does `leaf_node` collapse into `nats.name` (one field, dual purpose)? Recommendation: keep separate. `leaf_node` is the operator's chosen label that may match `nats.name` by convention but conceptually serves the policy/routing layer, not the NATS client.

---

## 5. Wire impact

### 5.1 Envelope shape — no changes required

The chain-of-stamps `signed_by[]` already carries stack identity per stamp; `correlation_id` already binds replies to dispatches; `sovereignty.classification` already discriminates `local`/`federated`/`public`. **Phase E adds zero envelope fields.**

The `source_network` derivation for inbound envelopes (Phase D) is unchanged: the dispatch-listener parses `federated.{network_id}.` out of the subject. Multi-link doesn't change the parsing — each link delivers envelopes whose subjects naturally carry the network id from its position in the subject namespace.

**Optional E.1 helper:** the new `EnvelopeHandler` parameter `sourceLink: string` (logical leaf-node id) is **additive** — handlers that don't care get the same shape as today. Internal-only; not exposed on the wire.

### 5.2 Subject naming — unchanged

- Inbound on link A (`research-collab` network): subjects start `federated.research-collab.>`.
- Inbound on link B (`jv-acme-bigcorp`): subjects start `federated.jv-acme-bigcorp.>`.
- Outbound: derived from `envelope.sovereignty.classification` + `envelope.type`. If classification is `federated`, the runtime's link-routing layer inspects which network the subject targets (parsed from the derived subject's second segment) and routes to that link.

**Invariant.** A `federated.research-collab.*` envelope MUST publish on the research-collab link. A misrouted publish (e.g. application code sets the subject manually and the runtime can't match it to a known network) is a programming error and the runtime emits `system.error` with reason `unknown_network_in_publish_subject`.

### 5.3 Queue group semantics for reply correlation

Per §3.3, each orchestrator binds a reply subscriber on the dispatcher's stack-scoped queue group: `qg:{operator}/{stack}:replies:{capability}`. Queue groups are NATS-native — no envelope change required. The queue group name includes the stack identity so two orchestrators on the same operator's two stacks don't steal each other's replies.

### 5.4 Capability advertisement envelope (new `system.network.capability.announced`)

Per §3.2, E.2 introduces a new envelope `type` value: `system.network.capability.announced`. This is a normal envelope produced by the cortex daemon at boot and on refresh; consumes the existing chain-of-stamps + sovereignty fields. Subject: `federated.{network}.system.network.capability.announced`. Schema: ordinary myelin envelope with the payload shape shown in §3.2.

No protocol-layer change — it's a new `type` literal, like `dispatch.task.requested` or `review.requested`. Consumers index by `(network_id, announced_by, capability.id)` and ignore the rest.

---

## 6. Operator workflow

### 6.1 Configuring a bridge stack

Operator wants their `andreas/research` stack to participate in both the `research-collab` network (for academic peers) and the `jv-acme-bigcorp` network (for a joint venture with two enterprise partners).

```yaml
# cortex.yaml

operator: { id: andreas, dataResidency: NZ }
stack: { id: andreas/research, nkey_pub: SAA... }

# Phase A.6 — top-level capability declaration
capabilities:
  - id: code-review.typescript
    description: "TypeScript code review"
    tags: [typescript, code-review]
    provided_by: [echo]
  - id: literature-search.medline
    description: "Medline literature search"
    tags: [search, medical]
    provided_by: [luna]
  - id: deploy.k8s
    description: "Kubernetes deploy"
    tags: [deploy, k8s]
    provided_by: [forge]

# Primary NATS — operator's own server
nats:
  url: nats://localhost:4222
  credsPath: ~/.config/nats/andreas.creds
  name: andreas-research-primary
  subjects: ["local.{org}.{stack}.>"]

policy:
  principals: [...]
  roles: [...]
  federated:
    registry:
      url: https://network.meta-factory.ai
      pubkey: <base64>
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research
        nats:
          url: nats://research-collab.example.com:7422
          credsPath: ~/.config/nats/research-collab.creds
          name: andreas-research-collab-leaf
        peers:
          - operator_id: jcfischer
            stack_id: jcfischer/sage-host
            operator_pubkey: O_JC_...
        accept_subjects: ["federated.research-collab.tasks.code-review.*"]
        announce_capabilities:
          - code-review.typescript
          - literature-search.medline
        max_hop: 1
      - id: jv-acme-bigcorp
        leaf_node: nats-leaf-jv
        nats:
          url: nats://jv-network.acme.example:7422
          credsPath: ~/.config/nats/jv.creds
          name: andreas-research-jv-leaf
        peers:
          - operator_id: acme
            stack_id: acme/deploy-host
            operator_pubkey: O_ACME_...
          - operator_id: bigcorp
            stack_id: bigcorp/release-host
            operator_pubkey: O_BIGCORP_...
        accept_subjects: ["federated.jv-acme-bigcorp.tasks.deploy.*"]
        announce_capabilities:
          - deploy.k8s
        max_hop: 0
```

Boot sequence the operator observes:

```
cortex: starting (operator=andreas, stack=andreas/research)
myelin-runtime: connected to nats://localhost:4222 as "andreas-research-primary"
myelin-runtime: connected to nats://research-collab.example.com:7422 as "andreas-research-collab-leaf"
myelin-runtime: connected to nats://jv-network.acme.example:7422 as "andreas-research-jv-leaf"
myelin-runtime: subscribed to "local.andreas.research.>" on primary
myelin-runtime: subscribed to "federated.research-collab.>" on nats-leaf-research
myelin-runtime: subscribed to "federated.jv-acme-bigcorp.>" on nats-leaf-jv
capability-announcer: published 2 capabilities to network "research-collab"
capability-announcer: published 1 capability to network "jv-acme-bigcorp"
registry-client: registered with https://network.meta-factory.ai
cortex: ready
```

Subsequent failures (e.g. JV leaf-node goes down) are link-local:

```
myelin-runtime: link "nats-leaf-jv" disconnected; retrying
myelin-runtime: link "nats-leaf-jv" reconnected after 3.2s
```

Other links keep running.

### 6.2 Running the orchestrator agent

Operator declares the orchestrator agent in `cortex.yaml`:

```yaml
agents:
  - id: luna
    persona: orchestrator
    trust: [echo, forge]
    runtime:
      substrate: claude-code
      orchestrator:
        capability_preference:
          - capability: code-review.typescript
            networks: [research-collab]   # prefer research-collab over alternatives
          - capability: deploy.k8s
            networks: [jv-acme-bigcorp]
        delegation_timeout_ms: 30000
        fallback_strategy: sibling_network   # or "fail"
```

`luna` runs as a regular agent. When she receives an inbound user request like "review this PR in TypeScript", her CC session invokes `delegate(capability="code-review.typescript", payload={...})`, which is wired through to the new `DelegationDispatcher`. The dispatcher publishes a federated envelope, awaits the chain-of-stamps reply via the queue group, and threads results back to Luna's response stream.

### 6.3 Joining a JV mesh (isolated-private)

Same as 6.1 minus `research-collab` — operator declares only the `jv-acme-bigcorp` entry with the four peers' pubkeys (the operator's own slot omitted from `peers[]` — peer lists are *the other peers*). All four operators run the same shape with permuted peer lists. The JV's NATS topology is operator infrastructure (four leaf-nodes, mesh-peered). The reference `docs/migration-examples/cortex.jv.yaml` documents one operator's view.

### 6.4 Joining the public mesh (deferred)

Operator declares `policy.public.announce_capabilities: [...]`. Cortex parses, validates against top-level `capabilities[].id`, and logs an info message that public-mesh dispatch is deferred. No outbound traffic on `public.>` until a future phase ships the public-mesh dispatcher.

---

## 7. Open questions

Things to lock in **before iteration starts**. Each has a recommendation; Andreas's call before the first PR.

### Q1: Does `leaf_node` collapse into `nats.name`?

Today: `leaf_node` is a separate logical id; `nats.name` is the NATS client connection name. They can be — and operators typically will set them — the same string.

Recommendation: **keep separate.** `leaf_node` is the policy/routing layer's identifier (referenced in logs and the runtime's internal link map). `nats.name` is what shows up on the NATS server's `varz`. Conflating them is convenient until an operator wants different conventions (e.g. `leaf_node: research-collab` for human readability, `nats.name: cortex-andreas-research-leaf-research-collab` for ops). Two fields keep the option open at zero cost.

### Q2: Does each NatsLink share a single Myelin schema cache or have its own?

The envelope validator (`src/bus/myelin/envelope-validator.ts`) holds a singleton Ajv instance + the vendored schema. Each link's inbound subscribers run through `validateEnvelope` against this single cache. Phase E doesn't change this — the validator is per-process, not per-link.

Recommendation: **shared singleton.** No reason for per-link schema caches; the vendored schema commit is the same for every link, and Ajv compile-once is the perf win that matters.

### Q3: Does the orchestrator agent live inside cortex (built-in) or as an external agent registered via PolicyEngine principal?

Two options:

- **(a) Built-in module** in `src/agents/orchestrator/`. Compiled into the cortex binary; declared by `persona: orchestrator` in cortex.yaml.
- **(b) External agent** running as a BusPeerHarness daemon (Phase B B.1b carry-over). Registered as a principal in `policy.principals[]` like any other peer agent.

Recommendation: **(a) for the reference implementation, (b) for production.** The E.3 reference implementation ships as a built-in module so we can demonstrate the pattern with zero external moving parts. Production deployments where the orchestrator wants its own substrate (e.g. running on Codex, not Claude Code) layer (b) on top using the existing BusPeerHarness contract from Phase A. The built-in is a worked example; it doesn't lock anyone in.

### Q4: Should `announce_capabilities[]` default to the full stack capability list when omitted?

Today the schema defaults `announce_capabilities[]` to `[]` — declaring a network with no announcements means "silent participant; consume but offer nothing." An alternative semantic: omitted `announce_capabilities[]` means "announce everything the stack offers."

Recommendation: **keep `default([])` — closed semantics.** Open-by-default is a leakage risk: an operator adding a new capability to the stack would silently start announcing it on every joined network. Closed-by-default forces the operator to explicitly opt each capability into each network. This matches the precedent set by `tool.<name>` capability allow-listing in the v2.0.0 policy cutover (`docs/design-policy-cutover.md` §5.2).

### Q5: Should the per-network capability advertisement go through the cloud registry's HTTP API, the federated NATS bus, or both?

Today the cloud registry (Phase D.4) accepts capability declarations via `POST /operators/{id}/register`. The §3.2 plan also describes publishing `system.network.capability.announced` envelopes on the federated NATS bus.

Recommendation: **both, with different roles.** The HTTP `POST` is the authoritative declaration — it's what `GET /networks/{id}/roster` reads from and what cross-operator discovery queries. The NATS-side `system.network.capability.announced` is the operational signal — peers subscribing to a network's capability subject see capabilities appear and disappear as operators come online without polling the registry. The HTTP path is necessary for federation correctness; the NATS path is necessary for operational responsiveness. Both share the same payload shape.

### Q6: How do we test multi-link without standing up multiple NATS servers in CI?

Phase D's federation tests use a single NATS server with subject scoping; Phase E genuinely needs multi-link semantics to verify the runtime's per-network routing. Options:

- **(a) Multiple `nats-server` processes** in CI — each test rig spawns 2-3 servers on different ports.
- **(b) `InMemoryTransport`** — myelin ships an in-memory transport (`myelin/src/transport/`) that could swap for `NatsLink` in tests. Cortex doesn't currently use it.
- **(c) Connect-impl injection** — `NatsLink.connect` has a `connectImpl` test seam (`src/bus/nats/connection.ts:46`); tests pass a mock per link.

Recommendation: **(a) for E.5 integration tests, (c) for E.1 unit tests.** Real `nats-server` for the bridge-stack scenario tests; mocked connect-impl for the runtime's routing logic. (b) is a candidate for a follow-up if myelin's in-memory transport stabilises.

### Q7: Does the orchestrator's `RegistryClient.findCapability` cache locally, and for how long?

Querying the cloud registry on every delegation is wasteful and creates a registry SLO dependency for every user request. Phase D's `RegistryClient` already has an in-memory cache.

Recommendation: **cache with 5-minute TTL, refresh on `unknown_federated_peer` PolicyEngine deny.** The 5-minute TTL bounds staleness; the deny-driven refresh handles the "peer just joined, we don't know them yet" race. Phase D D.4.3 (consumer side) is where this caching layer lives; E.3 extends it with the `findCapability` method.

---

## 8. Backwards compatibility

### 8.1 Single-network deployments unchanged

Operator with one network entry (the Phase D shape) sees no behavioural change. The new per-network `nats:` block migration:

- **No `nats:` block on a network entry** → runtime uses the primary `nats:` (the single-link Phase D behaviour). Detected at parse; emits a one-time info log on boot: *"network 'research-collab' has no inline nats: block; using primary nats connection (Phase D compatibility mode)."*
- **`nats:` block on a network entry** → runtime opens a dedicated link for that network. Phase E behaviour.

This means **zero config change required for v0.x → v1.x compatibility** at the cortex.yaml level. Operators who want multi-link explicitly opt in by adding `nats:` blocks.

### 8.2 Single-stack deployments (no `policy.federated.networks[]`) unchanged

No federation declared → `MyelinRuntime` opens only the primary link, identical to Phase D. The link-pool abstraction exists in the runtime code but contains one entry.

### 8.3 Migration path for an operator going from single-network to multi-network

Existing operator on Phase D with one network:

```yaml
policy:
  federated:
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research
        peers: [...]
        accept_subjects: [...]
        announce_capabilities: [...]
        max_hop: 1
```

To add a second network:

1. Decide on the new NATS leaf-node URL + creds (operator infra).
2. Add `nats:` block to **both** existing and new network entries (the existing one explicitly references the primary; the new one references the new leaf-node).
3. Reload cortex. Both links open.

Alternatively, keep the existing entry without `nats:` (it falls back to primary, no behavioural change) and add the new entry with `nats:` (gets its own link). Either ordering works.

### 8.4 No envelope wire breaking change

§5.1 — the envelope is unchanged. Federation peers running Phase D-era cortex continue to interop with Phase E-era cortex; the `signed_by[]` + `correlation_id` + `sovereignty.*` fields are all unchanged. The new `system.network.capability.announced` envelope is opt-in consumption — peers that don't subscribe to the capability subject pattern simply don't see it.

### 8.5 PolicyEngine unchanged

`PolicyEngine.check(principal, intent)` keeps its Phase D signature. `intent.source_network` derivation moves no closer to or further from the engine — the dispatch-listener still parses it from the subject. The engine has no notion of "which link delivered the envelope"; that's intentional and stays.

---

## 9. Tests

E.5 is the dedicated test slice; this section enumerates the coverage.

### 9.1 Multi-link MyelinRuntime unit tests (E.1)

- Two configured networks → two links opened.
- Publish a `federated.research-collab.*` envelope → only the research-collab link sees the publish.
- Publish a `federated.jv.*` envelope → only the jv link sees the publish.
- Publish a `local.{org}.{stack}.*` envelope → only the primary link sees the publish.
- Publish a `public.*` envelope → primary link (no federation for public in Phase E).
- One link's connect fails → other links still operate; the disabled link's publish returns the "publish to disabled link" reason.
- `runtime.stop()` drains all links concurrently; no link's drain blocks another.
- Inbound envelope on link A fans out to handlers with `sourceLink: "nats-leaf-research"`.

### 9.2 Capability advertisement tests (E.2)

- Schema cross-validator rejects `announce_capabilities[X]` where X isn't in top-level `capabilities[].id`.
- Boot path publishes one `system.network.capability.announced` envelope per network.
- Refresh schedule emits a fresh advertisement every 24h.
- Cloud registry `POST /operators/{id}/register` payload includes `network_capabilities` keyed by network id.
- Cloud registry `GET /capabilities?query=code-review&network=research-collab` returns only the research-collab subset.

### 9.3 Orchestrator delegation tests (E.3)

- Orchestrator agent receives a local inbound dispatch, queries `RegistryClient.findCapability("code-review.typescript")`, picks the matching network, emits a federated envelope on the right link.
- Reply arrives on the queue group with matching `correlation_id` → orchestrator threads it back to the original requester.
- No reply within timeout → orchestrator emits `dispatch.task.failed` to original requester with `timeout_no_peer_claim`.
- Multiple networks match the capability → first try; on timeout, try sibling; on full exhaustion, fail.
- Reply chain-of-stamps verification fails → reply dropped; orchestrator times out → audit envelope captures `chain_verification_failed`.

### 9.4 Mesh variety integration tests (E.4)

- Each of `cortex.private.yaml`, `cortex.federated.yaml`, `cortex.jv.yaml`, `cortex.bridge.yaml` parses cleanly and boots a cortex daemon to ready state.
- `cortex.public-stub.yaml` parses, emits the info log, no `public.*` publish path exists.

### 9.5 Bridge-stack integration test (E.5)

The integration test that demonstrates the Phase E exit criterion. Multi-process test rig (Q6 Option a) with two NATS servers + one cortex daemon:

1. Operator alpha (cortex daemon) participates in networks `research-collab` and `jv-acme-bigcorp`.
2. Peer operator beta is connected to `research-collab` only (single-network); peer gamma is connected to `jv-acme-bigcorp` only.
3. Alpha publishes a `federated.research-collab.tasks.code-review.typescript` envelope → beta picks it up via queue group; gamma sees nothing (network-isolated).
4. Alpha publishes a `federated.jv-acme-bigcorp.tasks.deploy.k8s` envelope → gamma picks it up; beta sees nothing.
5. Both replies flow back to alpha via the orchestrator's reply correlator.
6. Chain-of-stamps verifies on every hop.

### 9.6 Failure-mode tests (E.5)

- Peer offline mid-task: alpha dispatches to beta; beta crashes before replying; alpha times out → dead-letter on `local.andreas.research.tasks.dead-letter.code-review` with reason.
- Network registry unreachable: cortex starts, registry GET fails, RegistryClient serves last-known-good cache; new operator joins network, cached lookup returns stale "unknown peer"; on PolicyEngine deny with `unknown_federated_peer`, RegistryClient triggers a forced refresh and retry succeeds.
- One link's leaf-node bouncing repeatedly: the runtime's reconnect logic doesn't crash the daemon; other links keep running; reconnect succeeds without operator intervention.

---

## 10. What this design does NOT change

- **PolicyEngine internals.** The engine's per-network slicing (`intent.source_network`) shipped in Phase D. Phase E only changes the upstream code path that derives `source_network` to support multiple links; the engine's `check()` algorithm is byte-identical.
- **Envelope schema.** No new fields, no breaking changes to existing fields. The new `system.network.capability.announced` envelope `type` value is an additive enum entry; it slots into the existing schema without modification.
- **Adapter shape.** Discord/Mattermost/Slack adapters thin in Phase C and don't change here. Adapters never see `federated.*` envelopes directly — those flow through the PolicyEngine + dispatch-listener path.
- **Surface-router accept/deny gating.** Phase D D.2 wired this; Phase E doesn't extend it. The per-network `accept_subjects[]` + `deny_subjects[]` evaluation is unchanged.
- **Audit envelope semantics.** Phase C.4 `system.access.{allowed,denied}` envelopes already carry `source_network` in the structured reason (Phase D D.3.2). No change.
- **Chain-of-stamps verification.** Phase B's `verifySignedByChain` is the inbound gate. No new verification primitives in Phase E.
- **Cloud dashboard.** Phase D D.5 wired multi-operator slicing. Phase E adds the per-network capability surface to what the dashboard can render (a follow-up UX issue, not blocking Phase E exit).

---

## 11. Pressure-test against future surfaces

### 11.1 Public mesh (post-IAW)

Eventually a public-mesh dispatcher needs a "public link" (no `leaf_node`, no per-peer roster — anyone can publish on `public.>`). The multi-link runtime design accommodates this naturally — the public link is just another entry in the link pool with a distinguishing classification (`public` rather than `federated`). The orchestrator's `RegistryClient.findCapability` extends to query public-mesh registries the same way.

✓ Composes.

### 11.2 Per-link signing keys (future tenancy isolation)

Today every outbound envelope is signed by the single stack NKey. A future tenancy model might want per-network signing keys (e.g. the JV uses a network-scoped key that the operator-root signs over). The link-pool design admits this — each link could carry its own `signer` config. Not required in Phase E; the schema is open to extension.

✓ Composes.

### 11.3 JetStream durables per federated network

Today JetStream pull consumers bind to the primary link (`subscribePull`, §3.1). A future capability-dispatch durable consumer on a federated network would need to bind to that network's link. The link-pool design admits this — `subscribePull` would extend to take an optional `network: string` parameter selecting which link's `jetstreamManager()` to consult. Phase E does not ship this; tracked as §7 Q follow-up if a use case appears.

⚠ Composes with a future API extension; Phase E doesn't ship the extension because no consumer needs it yet.

### 11.4 Multi-stack on one daemon (future)

Q7 lock-in mentions "single cortex daemon hosting multiple stacks" as a future option. The Phase E multi-link runtime is per-process; if a future cortex hosts two stacks, the runtime would manage one link pool per stack (or a shared pool keyed by `(stack, network)`). The current design doesn't pre-build this; the right time is when the multi-stack daemon ships.

✓ Doesn't block.

### 11.5 Cross-link envelope forwarding (orchestrator + bridge)

Orchestrator on bridge stack delegates a task to network A; peer in network A delegates onward to network B. The chain-of-stamps grows; the orchestrator on the bridge sees an inbound reply on link A with stamps from both A's peer AND B's peer. The bridge re-stamps and forwards. Each link is independent; the orchestrator's reply correlator binds via `correlation_id` regardless of how deep the chain goes.

✓ Composes. No schema change; no protocol change.

### 11.6 Capability marketplace dynamics (Phase F+)

Cost/rate fields on capability declarations (Phase A.6 — already in the schema) are advisory in Phase E. A future marketplace dispatcher would consult these. The per-network announcement carries them through to the registry's index. Nothing here blocks marketplace economics.

✓ Doesn't block.

### 11.7 Pressure-test summary

| Surface | Composes? | Action in Phase E? |
|---|---|---|
| Public mesh dispatcher | ✓ | Schema slot reserved (E.4.5); impl deferred |
| Per-link signing keys | ✓ | No; future extension |
| JetStream durables per federated network | ⚠ API extension needed | No; deferred until consumer ships |
| Multi-stack on one daemon | ✓ | No; future |
| Cross-link envelope forwarding | ✓ | Tested in E.5 |
| Capability marketplace dynamics | ✓ | No; advisory fields preserved |

Nothing in Phase E traps future evolution. The multi-link primitive is the right shape for every IAW-extension surface that's been discussed.

---

## 12. Final schema delta (locked-in for cortex#117)

Summarising every schema change committed by §§1–11:

**Additions to `PolicyFederatedNetworkSchema`:**

```ts
{
  // existing: id, leaf_node, peers, accept_subjects, deny_subjects,
  //           announce_capabilities, max_hop
  nats: z.object({
    url: z.url("network.nats.url must be a valid URL"),
    credsPath: z.string().optional(),
    name: z.string().optional(),
  }).optional(),  // NEW — optional; omission = use primary nats (Phase D compat)
}
```

**New schema block `PolicyPublicSchema`:**

```ts
export const PolicyPublicSchema = z.object({
  announce_capabilities: z.array(
    z.string().regex(CAPABILITY_ID_REGEX),
  ).default([]),
});

PolicySchema = z.object({
  // existing: principals, roles, federated
  public: PolicyPublicSchema.optional(),  // NEW — reservation, no runtime impl
});
```

**New cross-validation rules in `PolicySchema.superRefine`:**

1. `policy.federated.networks[].announce_capabilities[]` ⊆ top-level `capabilities[].id` set (E.2).
2. `policy.public.announce_capabilities[]` ⊆ top-level `capabilities[].id` set (E.4.5).
3. `policy.federated.networks[].leaf_node` uniqueness — no two networks share the same leaf-node id (E.1, runtime invariant).

**New envelope `type` value:**

- `system.network.capability.announced` — produced per network on boot + on schedule.

**New module:**

- `src/agents/orchestrator/` — `OrchestratorAgent`, `DelegationDispatcher`, `ReplyCorrelator`, `RegistryClient` extensions (E.3).

**New CLI flag:**

- `migrate-config --check-public-mesh` — warns if `policy.public.announce_capabilities[]` is declared (E.4.5).

**Reference example files:**

- `docs/migration-examples/cortex.private.yaml`
- `docs/migration-examples/cortex.federated.yaml`
- `docs/migration-examples/cortex.jv.yaml`
- `docs/migration-examples/cortex.bridge.yaml`
- `docs/migration-examples/cortex.public-stub.yaml`

**No schema changes outside the policy block.** Bus, federation transport gating, audit envelope, dispatch lifecycle, adapters — all unchanged.

---

## 13. References

### Cortex source

- `cortex/src/bus/myelin/runtime.ts:301-686` — `startMyelinRuntime` factory + the single-link primitive Phase E refactors
- `cortex/src/bus/myelin/runtime.ts:43-141` — `MyelinRuntime` interface (preserved through Phase E)
- `cortex/src/bus/myelin/runtime.ts:599` — single `link.publish(subject, ...)` call site
- `cortex/src/bus/nats/connection.ts:84-120` — `NatsLink.connect` factory (reused per network in E.1)
- `cortex/src/bus/surface-router.ts:651-720` — Phase D federation gating (unchanged in Phase E)
- `cortex/src/common/policy/engine.ts:147-280` — PolicyEngine federation branch (unchanged in Phase E)
- `cortex/src/common/policy/types.ts:114-141` — `Intent.source_network` field
- `cortex/src/common/types/cortex-config.ts:1414-1499` — `PolicyFederatedNetworkSchema` (extended in E.1, E.2)
- `cortex/src/common/types/cortex-config.ts:1574-1770` — `PolicySchema.superRefine` (extended in E.2, E.4)
- `cortex/src/services/network-registry/` — cloud registry (consumed by E.2 producer + E.3 RegistryClient)
- `cortex/src/common/registry/client.ts` — registry client (extended by E.3 `findCapability`)
- `cortex/docs/architecture.md:232-241` — M2 transport contract (preserved)
- `cortex/docs/design-internet-of-agentic-work.md` — IAW design synthesis (§3.4, §3.5, §3.6, §5 Q4 — the parent design)
- `cortex/docs/plan-internet-of-agentic-work.md` §6 — Phase E plan (this doc extends with the design depth)
- `cortex/docs/design-policy-cutover.md` — style template for this doc
- `cortex/docs/iteration-policy-cutover.md` — style template for the sibling iteration plan

### Myelin source

- `myelin/specs/namespace.md:134-213` — tasks-domain subject grammar (used by E.3 delegation)
- `myelin/specs/namespace.md:216-247` — TASKS JetStream stream spec (informs §11.3 future extension)
- `myelin/docs/envelope.md:82-92` — chain-of-stamps (used by E.3 reply correlation)
- `myelin/src/envelope.ts:337-358` — `deriveNatsSubject` + `validateSubjectEnvelopeAlignment`

### GitHub issues

- cortex#117 — Phase E umbrella (this design)
- cortex#110 — IAW META
- cortex#116 — Phase D umbrella (predecessor)
- cortex#115 — Phase C umbrella (PolicyEngine landing)
- cortex#114 — Phase B umbrella (chain-of-stamps verification)
- cortex#113 — Phase A umbrella (stack identity)
- I-105 — blueprint entry for this phase
- I-100 — blueprint umbrella for IAW

### Operator vision

- *Internet of Agentic Work* video script (cortex#110 body) — the bridge-stack pattern + orchestrator-agent mental model that Phase E productionises.
- Q4 lock-in conversation (2026-05-13 Andreas) — multi-network = separate networks, not per-peer scoping.

---

*Design draft 2026-05-19. Implementation sequence: [`docs/iteration-phase-e-multinetwork.md`](./iteration-phase-e-multinetwork.md). When this doc and the IAW design synthesis disagree on architecture, the synthesis (`design-internet-of-agentic-work.md`) wins. When this doc and the iteration plan disagree on mechanics, the iteration plan wins (or is updated, never silently).*
