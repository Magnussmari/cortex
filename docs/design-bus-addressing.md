# Design — Bus Addressing & Routing Model

**Status:** canonical reference — draft for review
**Owners:** Andreas + Soma
**Audience:** anyone building or operating a tool that publishes to or subscribes on the metafactory NATS bus — cortex, pilot, arc, signal, future M7 apps
**Grammar authority:** [`myelin/specs/namespace.md`](https://github.com/the-metafactory/myelin/blob/main/specs/namespace.md) defines the wire grammar; this doc resolves *what the segments mean* and *how every tool must derive them consistently*.

---

## 1. Why this document exists

The same class of bug keeps recurring:

- **cortex#262** — stack-aware subject grammar landed
- **cortex#317** — `NatsLink.close()` drain
- **cortex#318** — pilot published 6-segment subjects, cortex subscribed 4-segment
- **2026-05-20** — `pilot request-review` times out: pilot publishes review tasks to `local.metafactory.meta-factory.tasks.code-review.*` but the cortex bot consumes `local.andreas.meta-factory.tasks.code-review.*`. The tasks land in a JetStream consumer no bot polls.

Every instance is the same underlying defect: **tools disagree on what the segments of a NATS subject mean, because the meaning was never written down canonically.** The myelin spec defines the *grammar* but its own examples are ambiguous (it shows both `local.andreas.research.*` and `local.metafactory.default.*` as valid — implying the first segment could be a person *or* an organisation).

This document ends the ambiguity. It is the canonical statement. When a tool's behaviour disagrees with this doc, the tool is wrong.

## 2. The verified root cause (2026-05-20 investigation)

| Tool | How it derives the first subject segment (`{org}`) | Result for this deployment |
|---|---|---|
| **cortex** | From `operator.id` in `cortex.yaml` (`src/common/types/cortex-config.ts` — "Operator identifier — used as the `{org}` subject segment"). Review-consumer subscribes `local.${operator.id}.${stack}.tasks.code-review.>`. | `local.andreas.meta-factory.…` |
| **pilot** | **Hardcoded.** `publish-review-request.ts` sets envelope `source: "metafactory.pilot.${network}"`; myelin's `deriveNatsSubject()` takes `source.split('.')[0]` → `metafactory`. Pilot never reads `operator.id`. | `local.metafactory.meta-factory.…` |
| **arc** | `arc nats provision-streams --network <X>` mints the consumer filter with `{org} = <X>`. `--network metafactory` → consumer filters `local.metafactory.…` | `cortex-review-consumer-metafactory-echo` |

**The mismatch:** cortex says `{org} = andreas`. pilot and arc say `{org} = metafactory`. Pilot's publish lands in the `metafactory`-org consumer; the cortex bot polls the `andreas`-org consumer. They never meet.

This is not a grammar bug (cortex#318 genuinely fixed the segment *count*). It is a **semantic bug**: the first segment's *meaning* is contested. pilot treats it as the organisation/network name; cortex treats it as the operator. Both cannot be right.

## 3. Core vocabulary — definitions are canonical

Five identifiers. They are **not interchangeable**. Most of the recurring pain comes from treating two of them as one.

### 3.1 Operator

A **human or team** that runs one or more Cortex stacks. Identified by a short slug: `andreas`, `team-research`, `acme-platform`.

The operator is the **unit of sovereignty**. `local.` signals never cross an operator boundary. Trust, signing identity, and policy principals are all scoped to an operator.

> **The operator IS the `{org}` subject segment.** myelin's spec calls the segment `{org}` and says stacks are "under the operator identified by `{org}`" — i.e. the spec's own prose equates `{org}` with the operator. For a solo operator there is no separate "organisation"; `andreas` is both. This doc makes the equivalence explicit and binding: **`{org}` ::= operator id**, always, in every tool.

### 3.2 Network

A **federation of operators** connected at the NATS layer via leaf nodes. `metafactory` is a network. So is a hypothetical `acme-clients` network.

> **A network is NOT a subject segment.** It is deployment topology — which leaf nodes peer with which. An operator participates in a network by connecting their NATS leaf node to it. Cross-operator reach is expressed by the **`federated.` prefix**, never by putting a network name in the subject.
>
> This is the single most important correction in this document. `metafactory` must never appear as the first segment of a subject. pilot doing so is the bug.

An operator may belong to **more than one** network (see §9). The network name lives in deployment config (NATS leaf-node config, `arc` provisioning), not on the wire.

### 3.3 Stack

A **deployment unit** under an operator — one running Cortex process, one `cortex.{stack}.yaml`, one signing identity, one subject sub-namespace. Identified `{operator}/{stack}`: `andreas/meta-factory`, `andreas/work`, `andreas/halden`.

The stack is the second subject segment. An operator runs many stacks side by side; the `{stack}` segment lets subscribers, JetStream consumers, audit trails, and federation routers tell them apart without payload inspection.

### 3.4 Principal

An **addressable agent identity** — `@echo`, `@luna`, `@forge`, `@cortex-halden`. Carried in the `@`-prefixed segment of the `tasks` domain (and the `agent` domain, per G-1114). Used for **point-to-point** routing: "this envelope is for *that specific agent*."

A principal is backed by an NKey / DID and verified via the `signed_by[]` chain. Principals are how Direct and Delegate routing target one recipient instead of a competing-consumer pool.

### 3.5 Scope

The **reach** of a signal — one of three, set by the subject prefix:

| Scope | Prefix | Reach |
|---|---|---|
| **internal** | `local.` | never leaves the operator boundary |
| **federated** | `federated.` | crosses to peer operators in the same network, subject to envelope sovereignty rules |
| **public** | `public.` | unrestricted; no `{org}` or `{stack}` segment at all |

### 3.6 Summary — the five-identifier model

```
operator   andreas              the human/team — the {org} segment, the sovereignty boundary
network    metafactory          a federation of operators — NATS topology, NOT on the wire
stack      meta-factory         a deployment under the operator — the {stack} segment
principal  @echo                an addressable agent — the @{principal} segment
scope      local/federated/public   reach — the subject prefix
```

## 4. The canonical subject grammar

Per `myelin/specs/namespace.md`, with this doc binding the segment meanings:

```
local.{operator}.{stack}.{domain}.{entity}.{action}
federated.{operator}.{stack}.{domain}.{entity}.{action}
public.{domain}.{entity}.{action}
```

- `{operator}` — the operator slug. **Derived from one source of truth per stack** (see §10). Never hardcoded, never a network name.
- `{stack}` — the stack slug (second half of `{operator}/{stack}`). `default` for single-stack operators.
- `{domain}` — functional domain: `tasks`, `code`, `agent`, `system`, `review`, `dispatch`, …
- `{entity}.{action}` — the signal, or for the `tasks`/`agent` domains the capability/action grammar below.
- `public.` carries **no operator/stack** — public signals are not operator-scoped.

### 4.1 The `tasks` domain — routed work

```
local.{operator}.{stack}.tasks.{capability}.{subcapability}      ← Broadcast
local.{operator}.{stack}.tasks.@{principal}.{capability}         ← Direct / Delegate
local.{operator}.{stack}.tasks.dead-letter.{capability}          ← unclaimable escalation
```

### 4.2 The `agent` domain — presence + lifecycle (G-1114)

```
local.{operator}.{stack}.agent.{action}.@{principal}
federated.{operator}.{stack}.agent.{action}.@{principal}
```

where `{action}` ∈ `online | heartbeat | offline | capabilities-changed`. This is the grammar G-1114 (Agent Network Topology) builds on — consistent with this model: operator is `{org}`, network is not on the wire, federation via the `federated.` prefix.

## 5. Worked example — operator `andreas`, network `metafactory`, three stacks

Operator `andreas` belongs to the `metafactory` network and runs three stacks:

| Stack | FQSI | `local.` prefix | `federated.` prefix |
|---|---|---|---|
| meta-factory | `andreas/meta-factory` | `local.andreas.meta-factory.>` | `federated.andreas.meta-factory.>` |
| work | `andreas/work` | `local.andreas.work.>` | `federated.andreas.work.>` |
| halden | `andreas/halden` | `local.andreas.halden.>` | `federated.andreas.halden.>` |

Note what is **absent**: the word `metafactory` appears nowhere in any subject. It is the network — the leaf-node federation `andreas` participates in. It is config, not wire-form.

A code-review request for a PR, dispatched by pilot from the meta-factory stack, broadcast to any qualified reviewer:

```
local.andreas.meta-factory.tasks.code-review.typescript
```

The same request, directed point-to-point to Echo:

```
local.andreas.meta-factory.tasks.@echo.code-review.typescript
```

Echo announcing itself on the bus (G-1114):

```
local.andreas.meta-factory.agent.online.@echo
```

## 6. Scopes in practice

- **internal (`local.`)** — the default. Everything within one operator's stacks. Cross-*stack* but same-*operator* traffic is still `local.` — e.g. the meta-factory stack observing the work stack uses `local.andreas.work.>` (a wildcard the operator owns end-to-end). Leaf-node config prevents `local.>` from replicating off the operator's cluster.

- **federated (`federated.`)** — cross-*operator*, same network. When `andreas` and another operator both peer into the `metafactory` network, a review request `andreas` is willing to send to an external reviewer goes on `federated.andreas.meta-factory.tasks.code-review.typescript`. The receiving operator's leaf node validates the envelope `sovereignty` block before accepting.

- **public (`public.`)** — unrestricted, no operator scoping. Registry announcements, network heartbeats, `public.community.agent.registered`. Deferred for cortex's own use (see G-1114 §4.3); listed here for completeness.

## 7. Routing patterns

Two axes: **how many recipients** and **chosen how**.

| Pattern | Subject shape | Semantics |
|---|---|---|
| **Broadcast** (one-to-many, open market) | `…tasks.{capability}.{sub}` | Any agent that declared `{capability}` may claim. JetStream queue-group gives exactly-one delivery per consumer group. The dispatcher does not pick the worker; the qualified pool competes. |
| **Direct** (point-to-point) | `…tasks.@{principal}.{capability}` | Routed to exactly one named agent. "Forge, cut a release." Broker-side filter on the `@{principal}` segment — no payload inspection. |
| **Delegate** (point-to-point, orchestrating) | `…tasks.@{principal}.{capability}` | Same wire shape as Direct; the difference is operator-facing — the recipient internally orchestrates a multi-step outcome and emits a `dispatch.*` lifecycle stream. "Pilot, drive PR #32 to merge." |
| **Dead-letter** | `…tasks.dead-letter.{capability}` | A task that exhausted `max_deliver` without a claim, or hit a compliance block, escalates here for operator review. Capability segment preserved for per-capability monitoring. |

The choice is the **publisher's**: broadcast when any qualified agent will do; direct/delegate when a specific agent is wanted. Both are first-class; both are already in the myelin grammar.

## 8. Multi-stack (one operator, many stacks)

`andreas` runs three stacks. Consequences:

- **`{operator}` is constant** across all three (`andreas`); `{stack}` varies. One operator, one sovereignty boundary, one `local.` namespace `local.andreas.>`.
- **Cross-stack visibility is cheap and internal.** A Mission Control instance on the meta-factory stack can subscribe `local.andreas.>` to see all three stacks — same operator, no federation needed.
- **Each stack has its own signing identity** (NKey) and its own JetStream consumers, named `(operator, stack, agent)` — e.g. `cortex-review-consumer-andreas-meta-factory-echo`. The consumer name MUST encode operator + stack, not a network.
- **Per-stack `context.md`** (see §11) is how each stack's addressing identity is declared once and read by every tool.

## 9. Multi-network (one operator, many networks)

An operator may peer into more than one network — e.g. `andreas` in `metafactory` and also in a client network `acme-clients`.

- The network is **still not on the wire.** Both networks see `andreas`'s subjects as `local.andreas.{stack}.>` / `federated.andreas.{stack}.>`.
- Networks are kept apart at the **NATS leaf-node layer** — which leaf nodes peer with which cluster. A `federated.` subject reaches only the operators whose leaf nodes are peered into the *same* network.
- If the same operator slug must mean different things in two networks, that is an **operator-naming collision** and must be resolved by namespacing the operator slug (`andreas-mf`, `andreas-acme`) — not by adding a network segment. (Open question §13.1.)

## 10. Conformance rules — binding on every tool

1. **`{org}` ::= operator id. Always.** Every tool that builds a subject MUST set the first post-prefix segment to the operator identity. No hardcoded literals. No network names.

2. **One source of truth per stack.** The operator + stack + network for a deployment are declared once, in that stack's `cortex.{stack}.yaml` (`operator.id`, `stack.id`) and surfaced in its `context.md` (§11). Tools READ that source. They never re-derive the operator from their own config, an env var, or a literal.

3. **A subject is derivable from a single stack's context.** Building a subject requires only: scope + that stack's operator + that stack's stack-slug + the domain/action. It never requires knowledge of the whole network. (Federation reach is the `federated.` prefix's job.)

4. **Network is provisioning input, never wire-form.** `arc nats` and leaf-node config consume a network name; the bus never sees it. An `arc nats provision-streams` flag that places a value in the `{org}` segment must take the *operator*, not the *network*.

5. **Consumer names encode `(operator, stack, agent)`.** Never `(network, agent)`. A consumer named `cortex-review-consumer-metafactory-echo` is malformed under this model — `metafactory` is a network.

## 11. The per-stack `context.md` standard

Every Cortex stack carries a **`context.md`** — the human- and agent-readable declaration of that stack's bus-addressing identity. It is the artefact a tool (or an agent at session start) reads to answer "where am I, and what subjects do I own?"

`context.md` is **rendered from `cortex.{stack}.yaml`** — `cortex.yaml` stays the single machine source of truth (rule §10.2); `context.md` is its readable projection. It lives beside the config: `~/.config/cortex/context-{stack}.md`.

### 11.1 Standard template

```markdown
# Stack Context — {operator}/{stack}

| Field | Value |
|---|---|
| operator | {operator} |
| stack | {stack} |
| network(s) | {network[, network…]} |
| fully-qualified stack identity | {operator}/{stack} |
| signing identity (NKey pub) | {nkey_pub} |

## Subject namespace this stack owns

- internal:   `local.{operator}.{stack}.>`
- federated:  `federated.{operator}.{stack}.>`

## Principals on this stack

- `@{agent}` — {displayName}, capabilities: {…}

## Routing into this stack

- broadcast a task:  `local.{operator}.{stack}.tasks.{capability}.{sub}`
- direct to an agent: `local.{operator}.{stack}.tasks.@{principal}.{capability}`

## Conformance

Any tool publishing toward this stack MUST set the operator segment to
`{operator}` — read it from here or from cortex.{stack}.yaml. Never
hardcode; never substitute a network name. See docs/design-bus-addressing.md.
```

### 11.2 Worked example — `andreas/meta-factory`

```markdown
# Stack Context — andreas/meta-factory

| Field | Value |
|---|---|
| operator | andreas |
| stack | meta-factory |
| network(s) | metafactory |
| fully-qualified stack identity | andreas/meta-factory |
| signing identity (NKey pub) | UD7OGEVBNJAUQ57H5NHSPJZOKKOXOZ4DEUJVAO5URHBIUAVSVTJGL4QV |

## Subject namespace this stack owns

- internal:   `local.andreas.meta-factory.>`
- federated:  `federated.andreas.meta-factory.>`

## Principals on this stack

- `@echo`  — Echo, capabilities: code-review.{typescript,documentation,security,…}
- `@luna`  — Luna
- `@forge` — Forge

## Routing into this stack

- broadcast a review:  `local.andreas.meta-factory.tasks.code-review.typescript`
- direct to Echo:      `local.andreas.meta-factory.tasks.@echo.code-review.typescript`
```

## 12. Remediation — the concrete defects this model exposes

| # | Defect | Fix | Owner |
|---|---|---|---|
| R1 | **pilot hardcodes `source: "metafactory.pilot.{network}"`** (`publish-review-request.ts`) → every published subject has `{org}=metafactory`. | pilot must derive the envelope `source` operator segment from the target stack's `operator.id` (read from `cortex.{stack}.yaml` / `context.md`). This is what pilot#133 ("derive envelope source from `agent.operatorId`, no more `metafactory.*` hardcode") was meant to do — verify it actually landed for the `request-review` path; the current repo still shows the hardcode. | pilot |
| R2 | **`arc nats provision-streams --network <X>`** places `<X>` in the consumer's `{org}` filter segment. | The flag that determines the `{org}` segment must be the **operator**, not the network. Rename/repurpose: `--operator` derives the org segment; `--network` (if kept) only selects NATS topology. Existing `cortex-review-consumer-metafactory-*` consumers are malformed and should be re-provisioned as `…-andreas-{stack}-…`. | arc |
| R3 | **myelin namespace spec ambiguity** — examples show both `local.andreas.*` and `local.metafactory.*` without stating that the segment is the operator. | Add a normative sentence to `myelin/specs/namespace.md`: "`{org}` is the operator identity. A network/federation name never appears as a subject segment." Cross-link this doc. | myelin |
| R4 | **No per-stack source of truth that tools agree to read.** | Adopt the `context.md` standard (§11). Render one per stack; point pilot/arc/cortex at it. | cortex |

Until R1 lands, the pilot review loop cannot deliver verdicts on this deployment (arc#182, compass#65 are blocked on exactly this). The interim path is in-session sub-agent review.

## 13. Open questions

1. **Operator-slug collisions across networks.** If `andreas` peers into two networks and a *different* `andreas` exists in the second, the operator slug collides. Resolve by globally-unique operator slugs, or by a network-scoped operator registry? (§9.)
2. **`context.md` generation + drift.** Should `arc` render `context.md` on `arc upgrade Cortex`? A drift check (rendered ≠ committed) in CI? (Mirrors the compass CLAUDE.md generation question — arc#181.)
3. **Federation principal mapping.** When a `federated.` task is claimed by an agent from another operator, whose principal scope does it carry? (myelin#43 territory — cross-ref, don't re-solve here.)
4. **Should the network ever be observable?** A diagnostic case for "which network did this reach" — but per §3.2 it must not be a subject segment. An envelope metadata field, perhaps. Deferred.

---

## Relationship to other docs

- **`myelin/specs/namespace.md`** — the wire grammar authority. This doc binds the segment *meanings* that spec leaves ambiguous.
- **`docs/architecture.md` §3.5** — the existing namespace-reconciliation note; this doc supersedes it with the canonical model.
- **`docs/design-agent-network-topology.md` (G-1114)** — consumes this model for the `agent` domain.
- **`docs/design-mission-control-cortex-cockpit.md` (G-1113)** — the Network view renders the topology this model defines.
