# Cortex — Context

Cortex is the M7 collaboration surface of the metafactory Myelin layer model: it consumes the bus, runs agents, dispatches work, and presents activity to the principal through Mission Control and chat adapters.

This is the canonical domain glossary for the **cortex** bounded context — one canonical term per concept; aliases are listed under _Avoid_. Boundary terms shared with soma, myelin, and signal are reconciled in `compass/ecosystem/CONTEXT-MAP.md`. Resolved by a `grill-with-docs` session (Q1–Q14).

## Language

### Principals, stacks, networks

**Principal**:
The human who owns and runs Cortex stacks — root of the trust and policy model, and the identity that scopes every subject the principal's stacks emit. One principal runs one or more **stacks** (e.g. `andreas` runs `andreas/meta-factory`, `andreas/work`, `andreas/halden`).
_Avoid_: operator, user, owner, human, org

**Stack**:
One running cortex deployment under a **principal** — its own `cortex.yaml`, signing identity, subject sub-namespace, and JetStream consumers. A principal runs one or more stacks side by side, purpose-named. The second subject segment: `local.{principal}.{stack}.…`.
_Avoid_: deployment, instance, node. Never use `stack` for the M1–M7 architecture — that is the **Myelin layer model**.

**Network**:
A federation of **principals** whose **stacks** interconnect at the NATS leaf-node layer — `metafactory` is the network this ecosystem runs on. A network is **not a subject segment**: it is deployment topology. Cross-principal reach is the `federated.` **scope** prefix, never a network name on the wire. A principal may belong to more than one network.
_Avoid_: federation (that is the relationship, not the thing), mesh, fabric, org, cluster

### Assistants & agents

**Assistant**:
The named being cortex runs — Luna, Echo, Forge, Pilot. Has a persona, a voice, and continuity of identity. An assistant is hosted by an **agent**. The assistant name is what the bus routes to: the `@{assistant}` segment in Direct/Delegate **dispatch** (`@forge`, `@pilot`).
_Avoid_: persona, bot, DA, character

**Agent**:
The stack-local, long-lived runtime identity (daemon) that hosts an **assistant** on the bus — its own NKey signing identity and a JetStream consumer. An agent has **no independent name**: it is reached via the **assistant** it hosts plus the **stack** it runs on. The same assistant may be hosted by different agents on different stacks ("same assistant, different agent surfaces").
_Avoid_: bot, persona, daemon (as the domain term)

**Sub-agent**:
A short-lived task spawned via Claude Code's `Agent` tool — e.g. the Engineer or Explore sub-agents the pilot loop uses. Not an **agent**: no bus identity, no persistence. Always carries the `sub-` qualifier; never bare `agent`.
_Avoid_: agent (bare), worker, helper

### The bus

**Subject**:
The dotted NATS routing string a message is published to or subscribed on — `{scope}.{principal}.{stack}.{domain}.{entity}.{action}`. Routing lives in the subject, not in code. Subscribers match with NATS wildcards (`*`, `>`).
_Avoid_: topic (the Kafka/MQTT word — NATS subjects have different semantics), channel, path

**Scope**:
How far a **subject** may travel, set by its prefix — exactly three values: `local` (never leaves the **principal** boundary), `federated` (crosses to peer principals in a **network**), `public` (unrestricted; carries no principal/stack segment).
_Avoid_: reach, visibility, tier, level

**Domain**:
The functional-domain segment of a **subject** — groups related signals. Values: `tasks`, `agent`, `system`, `code`, `review`, `dispatch`. Always the segment ("the tasks domain"). The `tasks` and `dispatch` domains are distinct and coexist: **`tasks.{capability}.{subcapability}`** is the work-request namespace (where Offer-mode work is published, capability-routed); **`dispatch.task.{action}`** is the task-lifecycle namespace (events about an active dispatch — `received`, `dispatched`, `started`, `completed`, `failed`, `aborted`). Not a rename in flight.
_Avoid_: channel, category — and never use `domain` for the DDD bounded-context sense (that is always written **bounded context**).

**Envelope**:
The signed wrapper that travels on a **subject** — metadata (`sovereignty`, `signed_by[]`, `correlation_id`, `source`, `type`) around a **payload**. Every bus message is an envelope.
_Avoid_: message (too loose — say envelope for the wrapper, payload for the content), packet

**Payload**:
The inner content body of an **envelope** — the domain data, distinct from the envelope's routing/trust metadata.
_Avoid_: message, body, data

**Capability**:
A declared, bus-routable ability — e.g. `code-review.typescript`. An **assistant** declares the capabilities it offers; the `tasks.{capability}.{subcapability}` **subject** routes on it; an **agent**'s JetStream consumer filters by it. A capability may be *fulfilled by* a soma skill, but the capability is the wire-facing ability, not the implementation.
_Avoid_: skill (that is the SOMA implementation term), ability, function, command, tool

**Dispatch**:
The act of routing a unit of work to an **assistant** over the bus. Three modes, by how the recipient is chosen — **Offer**: published to a **capability**, any capable assistant *claims* it (competing consumers, exactly-one delivery); **Direct**: sent to one named assistant (`@{assistant}`), one-shot; **Delegate**: sent to one named assistant that orchestrates a multi-step outcome. Unclaimed work escalates to **dead-letter**.

Inbound subjects per mode:
- **Offer** → `tasks.{capability}.{subcapability}` (capability routing, competing consumers)
- **Direct, intra-stack** → `dispatch.task.received` (local **dispatch source** publishes; the stack-local listener consumes)
- **Direct, peer-to-peer** → `dispatch.task.dispatched` (peer stack publishes via a bus-peer bridge)
- **Delegate** → currently undefined; under design as part of the AgentTeam **substrate harness** work

Lifecycle envelopes for any mode flow on `dispatch.task.{started|completed|failed|aborted}`, joined by `correlation_id`.
_Avoid_: routing, assignment, hand-off. Never call the Offer mode "broadcast" — exactly one assistant claims an offered task, not all.

### Surfaces, substrates, dispatch routing

**Substrate harness** (or just **harness**):
The M6 runtime layer that executes a single **dispatch** on one execution substrate and yields lifecycle **envelopes**. Closed enum of `HarnessId` values: `claude-code`, `bus-peer`, `openai-codex`, `cursor`, `gemini`, `mistral`, `pi-dev`, `agent-team`. The harness boundary is what makes the runner substrate-agnostic — the same `DispatchRequest` flows into any harness; the same `dispatch.task.{action}` envelopes flow out. The `agent-team` harness composes other harnesses to fulfil **Delegate**-mode dispatches.
_Avoid_: backend, executor, engine, runtime (overloaded with `MyelinRuntime`)

**Dispatch source**:
Anything that creates and publishes an inbound dispatch **envelope** onto the bus. A platform adapter (Discord, Mattermost, Slack) is a dispatch source: it turns a platform message into a `dispatch.task.received` envelope signed by the hosted **agent**. The GitHub webhook tap is a dispatch source. The MC dashboard's "send task" action is a dispatch source. Future peer-stack agents publishing Offers cross-federation are dispatch sources. A dispatch source is the only thing that signs an envelope into existence; it carries the originating agent's signing key.
_Avoid_: producer, ingress, intake

**Dispatch sink**:
Anything that consumes lifecycle envelopes for one dispatch and renders them to a surface. A platform adapter is both a dispatch source (inbound) and a dispatch sink (outbound) — its outbound side subscribes to `dispatch.task.{started|completed|failed|aborted}` filtered by the dispatch's **response routing** and turns lifecycle events into platform calls (`postResponse`, `sendProgress`). The Mission Control dashboard is a dispatch sink; PagerDuty is a dispatch sink. A dispatch sink does NOT sign envelopes; it consumes them.
_Avoid_: consumer, egress, renderer (renderer is the cortex-internal interface name in `src/renderers/types.ts`; **dispatch sink** is the architectural role)

**Response routing**:
The payload field on an inbound dispatch envelope that tells the dispatch sink where to deliver lifecycle events. Carries the originating surface address — for a Discord-sourced dispatch: `{adapter_instance, channel_id, thread_id?}`. Echoed by the runner onto every `dispatch.task.{action}` lifecycle envelope so the originating dispatch sink can correlate completion → platform target without keeping state. Response routing is wire-level, not in-memory.
_Avoid_: callback, return-address, reply-to

## Relationships

- A **principal** runs one or more **stacks**, and belongs to one or more **networks**.
- A **stack** hosts one or more **agents**.
- An **agent** hosts exactly one **assistant**; the same assistant may be hosted by different agents on different stacks.
- An **agent** may spawn zero or more **sub-agents**.
- An **assistant** declares one or more **capabilities**.
- Work is **dispatched** to an **assistant** as an **envelope** published on a **subject**.
- A **subject** = `{scope}.{principal}.{stack}.{domain}.…`; its **scope** sets how far it travels.
- An **agent** dispatches work via a **substrate harness** — the M6 runtime layer that executes one dispatch and yields lifecycle envelopes.
- A **dispatch source** publishes inbound dispatch envelopes (signed by the hosted agent); a **dispatch sink** consumes lifecycle envelopes and renders to a surface. A platform adapter plays both roles.
- A dispatch's inbound envelope carries **response routing**; the runner echoes it onto every lifecycle envelope so the originating dispatch sink can find its target without state.

## Example dialogue

> **Dev:** Pilot timed out asking for a code review. Where did it go?
> **Domain expert:** Pilot is an **assistant** — it ran an **Offer** **dispatch**: published a review task to a **capability**, `code-review.typescript`, on the **subject** `local.andreas.meta-factory.tasks.code-review.typescript`.
> **Dev:** So any reviewer could claim it?
> **Expert:** Right — Offer mode. Any **agent** whose **assistant** declares that **capability** can claim the **envelope**. Echo's agent on the `andreas/meta-factory` **stack** should have.
> **Dev:** It didn't. The subject said `local.metafactory.meta-factory.…`.
> **Expert:** There's the bug. The second segment is the **principal** — `andreas`. `metafactory` is the **network**, not a principal; it must never be a subject segment. Pilot built the subject with the wrong **principal**, so Echo's agent never saw the envelope.
> **Dev:** And if I want *only* Echo to review it?
> **Expert:** Then it's a **Direct** dispatch — `local.andreas.meta-factory.tasks.@echo.code-review.typescript`. `@echo` is the **assistant**. If Echo had to drive it to merge across several steps, that'd be **Delegate**.

## Flagged ambiguities

- **`operator` → `principal`.** cortex historically said `operator` (`operator.id`, "operator cockpit", the `{org}` segment). Resolved: **`principal`** ecosystem-wide, matching `soma:principal`. Carries into `cortex.yaml` schema, subject derivation, Mission Control copy.
- **`agent` was overloaded** — the named being, the runtime identity, *and* a Claude Code spawned task. Resolved into **assistant** / **agent** / **sub-agent**.
- **`persona` → `assistant`.** `persona` is not a domain entity. `personas/luna.md` stays a valid filename ("the assistant's persona file").
- **The `@`-segment names an `assistant`** — `@{assistant}`. myelin's `namespace.md` calls it a "principal address"; its examples ("Forge", "Pilot") are assistants. The hosting **agent** is resolved from `(stack, assistant)`; it carries no wire name.
- **`stack` meant two things** — the M1–M7 layering *and* a deployment unit. Resolved: `stack` is the **deployment unit**; the M1–M7 layering is the **Myelin layer model**.
- **`domain` meant two things** — the `{domain}` subject segment *and* the DDD sense. Resolved: bare `domain` is only the segment; the DDD concept is always **bounded context**.
- **`topic` → `subject`.** "Topic" is the Kafka/MQTT word; NATS uses **subject**.
- **`reach` → `scope`.** myelin's `namespace.md` heads the prefix column "Reach"; canonical is **scope**.
- **`broadcast` → `Offer`.** A broadcast reaches everyone; that dispatch mode is claimed by exactly one assistant. The modes are **Offer / Direct / Delegate**.
- **`tasks` and `dispatch` are distinct domains**, not aliases. `tasks` = work-request namespace (Offer-mode subject convention). `dispatch` = task-lifecycle namespace (events about an active task). Both will continue to exist.
- **`renderer` vs `dispatch sink`.** The cortex-internal interface is `Renderer` (`src/renderers/types.ts`); the architectural role is **dispatch sink**. Same thing from different angles — code says `Renderer`; design discussion says `dispatch sink`.
- **Adapter-originated Direct subject (`tasks.@{assistant}.chat`) is a future seam.** The example dialogue above shows the intended subject grammar; cortex code today publishes adapter-originated Direct dispatches to `dispatch.task.received` (the existing intra-stack inbound subject). Migration to subject-level mode encoding (Direct = `tasks.@{assistant}.…`) is deferred — payload-level mode field carries the information today.

## Boundary with adjacent contexts

Reconciled in full in `compass/ecosystem/CONTEXT-MAP.md`:

- `cortex:principal` **≡** `soma:principal` — identical concept, identical term (Q2).
- `cortex:assistant` **≡** `soma:assistant` — the named being.
- `cortex:agent` **≡** `soma:"Cortex agent"` — SOMA always qualifies `agent`; within cortex's own bounded context bare `agent` is canonical.
- `cortex:sub-agent` **≡** `soma:"Claude Code sub-agent"`.
- `cortex:capability` is **distinct from** `soma:skill` — a capability is the bus-routable ability tag; a skill is the packaged implementation that may fulfil it.
- **myelin** owns the **subject** grammar (a published language cortex consumes). Pending myelin alignment, filed as a namespace.md issue: `{org}` → `{principal}`, the `@`-segment relabelled an *assistant address*, "Reach" → "Scope".
