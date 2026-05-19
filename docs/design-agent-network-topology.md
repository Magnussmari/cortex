# Agent Network Topology

**Status:** draft for review
**Branch:** `feat/g-1114-agent-network-topology`
**Owners:** Andreas + Soma
**Scope:** Bus-driven agent announce / heartbeat / offline protocol, runtime
network registry, federation namespace, and the Mission Control "Network"
view that renders the resulting topology.

## 1. Purpose

A Cortex stack today knows which agents are *configured* (from `cortex.yaml`)
and which capabilities they declared at boot (one-shot
`agents.capabilities.registered` envelopes). It does **not** know:

- which configured agents are actually running right now
- when an agent joined or left the network
- which agents exist on *other* stacks reachable via NATS leaf federation
- whether a "supposed to be there" agent has gone quiet

This document specifies the protocol + the consumer-side runtime registry +
the Mission Control surface that makes the network of agents observable,
addressable, and reasoned-about as a first-class concept.

The operator should be able to open Mission Control, see the network they
are part of, click an agent, see its capabilities, see whether it is
reachable, and route work to it — direct or capability-matched.

## 2. Inspiration

TCP/IP and service-mesh primitives give us mature, well-tested vocabulary
for "nodes on a network." We borrow concepts, not specifics:

| Networking concept | Agent-network analogue |
|---|---|
| MAC address (immutable identity) | Agent NKey public key |
| IP address (logical address within scope) | Stack-scoped subject `local.{org}.{stack}.{agent}` |
| Subnet / segment | Stack |
| ARP / mDNS announce | `system.agent.online` envelope |
| TCP keepalive / heartbeat | `system.agent.heartbeat` envelope |
| Graceful disconnect | `system.agent.offline` envelope |
| Routing table | Bus-built runtime registry of who-is-where |
| DNS-SD / service discovery | Capability advertisement on the bus |
| Service mesh work dispatch | Capability-matched pull on JetStream consumers |
| BGP / federation | NATS leaf-node federation between stacks |

The analogy is a mnemonic, not a constraint. We are not building TCP/IP.
We are building the smallest bus protocol that gives Cortex stacks a
shared, queryable view of their agents — local, federated, or public.

### 2.1 Non-goals

- **Not a service mesh control plane.** No traffic shaping, no rate
  limiting, no circuit breakers. Bus subscriptions remain the routing
  mechanism; this design surfaces who's there, not who handles what under
  load.
- **Not a replacement for `cortex.yaml`.** Config remains the declarative
  source of "agents that should exist in this stack." The runtime registry
  is the observed view of "agents currently alive." Both coexist.
- **Not a new identity layer.** NKey + `signed_by[]` chain stays the
  authoritative identity. Announce envelopes are *signed by* the agent, not
  a new identity primitive.
- **Not internet-scale public discovery.** A future opt-in `public.*`
  scope is sketched, but Phase 1 lands stack-local and federated.
- **Not work-queue redesign.** Capability-matched dispatch (cortex#237 /
  Wave 3 cutover) is the existing pattern. This design surfaces it; it
  does not change it.

## 3. Core Concepts

### 3.1 Network

A **network** is the set of agents reachable via a connected NATS
deployment, scoped by subject namespace. Three scopes:

- **Stack** — `local.{org}.{stack}.*`. One Cortex stack. The smallest
  network; always present.
- **Federated** — multiple stacks federated via NATS leaf nodes, sharing
  a controlled subject namespace. Opt-in per stack; opt-in per subject.
- **Public** — opt-in broadcast namespace, intended for ecosystem-wide
  discovery (e.g. `public.metafactory.agent.*`). Phase 2+ — sketched
  here, not specified in detail.

A network is identified by an operator-supplied **network ID**
(`metafactory`, `andreas-personal`, etc.) that namespaces the federation
subject space.

### 3.2 Agent

An agent on the network has:

- **Identity** — NKey public key. Stable across restarts.
- **Stack scope** — `{org}/{stack}` it lives in.
- **Network ID** — which federation it participates in (may be `local`-only).
- **Display name** + **assistant name** (Soma layer split: assistant =
  persistent named being, Cortex agent = the stack-local process identity).
- **Declared capabilities** — what kinds of work it accepts.
- **Liveness state** — see §3.4.
- **Presences** — platform adapters it is currently bound to
  (Discord/Mattermost/Slack/...).
- **Trust relationships** — `trust:[]` from `cortex.yaml` plus
  `signed_by[]` chains observed in envelopes.

### 3.3 Capability

A capability is a declared ability to handle a class of work, expressed
in the existing cortex capability vocabulary (`code-review.typescript`,
`code-review.documentation`, custom).

Capabilities are advertised by the agent itself and may change over the
agent's lifetime (e.g. plugin loaded, permission granted). The runtime
registry tracks current advertisements.

### 3.4 Liveness state

An agent moves through a small state machine:

```
              ┌──────┐
              │unknown│  (never seen by this subscriber)
              └───┬───┘
                  │  online envelope received
                  ▼
              ┌──────┐
   ┌─────────►│online│◄──────────┐
   │          └───┬──┘            │ heartbeat
   │              │ TTL exceeded  │
   │              ▼ (5 min)       │
   │          ┌───────┐           │
   │          │offline│───────────┘  (heartbeat received again)
   │          └───────┘
   │              ▲
   └──────────────┘  offline envelope received (graceful)
```

- `unknown` — subscriber hasn't observed the agent yet.
- `online` — last heartbeat within TTL (5 min).
- `offline` — last heartbeat older than 5 min, or graceful `offline`
  envelope received. A subsequent heartbeat / online envelope transitions
  back to `online`.

Defaults: heartbeat envelope every 60 s; TTL **5 minutes**. Single tier —
no separate quiescent state. Tunable per scope if federated traffic
proves chatty.

### 3.5 Routing table

The bus-built runtime registry. A `Map<NKey, AgentRecord>` maintained by
subscribing to `system.agent.*` envelopes. The "table" in mental model;
in code it is a single observable store consumed by the UI and by
capability-routing code.

Each `AgentRecord` includes: identity, scope, liveness state, last-seen
timestamp, declared capabilities, observed envelope subjects (i.e. "what
subjects has this agent published on recently"), and any operator
annotations (pinned, muted, trusted).

## 4. Subject grammar

All envelopes are signed (via existing stack signing — cortex#324). All
subjects follow `~/Developer/myelin/specs/namespace.md`. Per that spec
(line 292), **agent lifecycle subjects are cortex M7 territory** — myelin
governs the grammar but does not define the agent-presence subjects
themselves.

This design introduces a new `agent` **domain** alongside the existing
`tasks` / `code` / `security` / etc. domains, and uses the established
`@{principal}` principal-address segment for the publisher's identity.

### 4.1 Stack-local subjects

```
local.{org}.{stack}.agent.online.@{principal}
local.{org}.{stack}.agent.heartbeat.@{principal}
local.{org}.{stack}.agent.offline.@{principal}
local.{org}.{stack}.agent.capabilities-changed.@{principal}
```

Form: `{prefix}.{org}.{stack}.{domain}.{action}.{principal}` per the
myelin segment-semantics table. Principal segment is DID-encoded via
myelin's `encodeDidSegment(did)` helper (`@nkey:UABC...` → safe segment).

- `online` — emitted once on agent boot. Payload: full agent descriptor
  (identity, stack, network, capabilities, presences, trust roots).
- `heartbeat` — emitted every 60 s while alive. Payload: liveness +
  capabilities digest + optional load info.
- `offline` — emitted on graceful shutdown. Payload: reason
  (`shutdown` | `restart` | `error`).
- `capabilities-changed` — emitted when capabilities change between
  heartbeats (immediate delta; the next heartbeat carries the digest of
  the new steady state).

### 4.2 Federation subjects

```
federated.{org}.{stack}.agent.online.@{principal}
federated.{org}.{stack}.agent.heartbeat.@{principal}
federated.{org}.{stack}.agent.offline.@{principal}
federated.{org}.{stack}.agent.capabilities-changed.@{principal}
```

Identical shape with `federated.` prefix — matches the pattern myelin
already uses for `federated.{org}.{stack}.tasks.*` (namespace.md §Federated
counterparts). The `{org}.{stack}` segments preserve provenance:
`federated.andreas.work.agent.online.@nkey-...` is unambiguously from
`andreas/work`.

Stacks that opt in to federation re-publish (or subject-rewrite via
leaf-node policy) their `local.{org}.{stack}.agent.*` envelopes onto the
`federated.{org}.{stack}.agent.*` namespace.

### 4.3 Public subjects (deferred)

Out of scope for G-1114. The myelin namespace spec already lists
`public.community.agent.registered` as a future capability-announcement
subject; a separate design will pick up public-scope discovery,
authentication, and authorization. Tracked as a candidate G-1115
umbrella.

### 4.4 Relation to existing `agents.capabilities.registered`

The existing `agents.capabilities.registered` envelopes
(`src/bus/capability-registry.ts`) emit per agent×capability at boot.
This design **supersedes** that pattern:

- Agent descriptor in `agent.online` carries the full capabilities list
  in one envelope per agent (not one per capability).
- `agent.capabilities-changed` carries deltas.
- Migration: `capability-registry.ts` continues to dual-emit during a
  deprecation window (length TBD per §11); new subscribers consume from
  `agent.online` / `agent.capabilities-changed` directly.

## 5. Envelope shapes

Illustrative TypeScript:

```ts
interface AgentDescriptor {
  identity: {
    nkeyPublicKey: string;
    displayName: string;
    assistantName: string | null;
  };
  scope: {
    org: string;
    stack: string;
    network: string;
  };
  capabilities: Array<{
    id: string;
    sovereignty: "stack" | "federated" | "public";
    constraints?: Record<string, unknown>;
  }>;
  presences: Array<{
    platform: "discord" | "mattermost" | "slack" | "bus-only";
    bound: boolean;
    address?: string;
  }>;
  trust: {
    roots: string[];
    declared: string[];
  };
  version: {
    cortex: string;
    runtime: string;
  };
}

interface AgentOnlineEnvelope {
  type: "system.agent.online";
  agent: AgentDescriptor;
  startedAt: string;
}

interface AgentHeartbeatEnvelope {
  type: "system.agent.heartbeat";
  agent: {
    nkeyPublicKey: string;
    scope: AgentDescriptor["scope"];
  };
  sentAt: string;
  capabilitiesDigest: string;
  load?: {
    activeSessions: number;
    queuedTasks: number;
  };
}

interface AgentOfflineEnvelope {
  type: "system.agent.offline";
  agent: {
    nkeyPublicKey: string;
    scope: AgentDescriptor["scope"];
  };
  reason: "shutdown" | "restart" | "error";
  detail?: string;
  sentAt: string;
}

interface AgentCapabilitiesEnvelope {
  type: "system.agent.capabilities";
  agent: {
    nkeyPublicKey: string;
    scope: AgentDescriptor["scope"];
  };
  capabilities: AgentDescriptor["capabilities"];
  sentAt: string;
}
```

All envelopes share the standard myelin envelope wrapper (sovereignty,
signed_by chain, correlation_id, sender, etc.).

## 6. Runtime registry

A cortex-side subscriber maintains a single observable store:

- Subscribes to `local.{org}.{stack}.agent.>` (always).
- Subscribes to `federated.>.agent.>` (when federation enabled — narrowed
  by federation policy in `cortex.yaml`).
- Public scope is out of scope for G-1114 (see §4.3).

For each envelope:

- `online` → upsert `AgentRecord`; state := `online`; set last-seen.
- `heartbeat` → set last-seen; state := `online`; check
  `capabilitiesDigest` and refetch on mismatch.
- `capabilities` → replace capabilities; bump last-seen.
- `offline` → state := `offline`; record reason.

A background reaper transitions records: `online` → `quiescent` after
heartbeat TTL; `quiescent` → `offline` after stale TTL.

The registry exposes:

- `getAll(): AgentRecord[]`
- `getByNkey(pk): AgentRecord | undefined`
- `getByCapability(capId): AgentRecord[]`
- `getInScope(scope: 'stack' | 'federated' | 'public'): AgentRecord[]`
- `subscribe(cb)` — observable, fires on every change

The registry is the source of truth for:

- The Mission Control "Network" view
- Capability-matched dispatch decisions (when not addressing directly)
- `signed_by[]` chain verification cache (already exists, gets a runtime
  population path instead of pure config)

## 7. UI — Mission Control "Network" view

A new tab or sidebar surface in `src/surface/mc/dashboard-v2/`. Built on
the same stack Strata's UI uses:

- **`@xyflow/react`** for the canvas
- **`elkjs`** (`elkjs/lib/elk.bundled.js`) for auto-layout
- Components lifted/adapted from `~/Developer/arc-library/strata/ui/`:
  `FlowCanvas`, `ContextMenu`, `DetailPanel`, `SpotlightSearch`, `Legend`

### 7.1 Graph shape

- **Nodes** — one per agent in the registry. Visual chrome encodes:
  liveness (online/quiescent/offline), scope (stack/federated/public),
  assistant identity (color/avatar).
- **Edges** — derived relationships:
  - `trust` edges from `signed_by[]` chains observed in recent envelopes
  - `recent-work` edges from observed envelope subjects (e.g. agent A
    published a `tasks.code-review.*` envelope that agent B consumed)
  - `capability-flow` edges from capability matches
- **Layout** — ELK directional layered for trust; force-directed for
  recent-work; user can switch.

### 7.2 Filters

- By scope: stack-only / federated / public / all
- By state: online / include quiescent / include offline
- By capability: highlight nodes matching a capability id
- By recent activity: time window

### 7.3 Detail panel

Click a node → side panel with:

- Identity (NKey, display name, assistant)
- Scope (stack, network)
- Liveness (state, last-seen, uptime)
- Capabilities (full list + sovereignty)
- Presences (Discord channel + role, etc.)
- Trust roots + declared trust
- Recent envelopes (last N subjects observed from this agent)
- Actions: dispatch work, mute, pin, view in Discord

### 7.4 Spotlight search

`Cmd+K` over agents — by name, NKey prefix, capability, presence.

## 8. Work routing on the network

Two routing modes, both already supported by the bus:

### 8.1 Capability-matched pickup (broadcast)

Producer publishes to `local.{org}.{stack}.tasks.{type}.{flavor}`.
Subscribers — agents that declared the matching capability — pull from
their per-agent JetStream consumer and claim envelopes.

This is the cortex#237 / Wave 3 cutover pattern. **Already operational
for code-review.** This design generalizes it: any agent advertising a
capability becomes a candidate consumer for matching task subjects.

The network view should make this visible: highlight nodes whose
capabilities match a hovered task, and the inverse (highlight tasks an
agent could pick up).

### 8.2 Direct addressing

Producer publishes to a stack-and-agent-scoped subject. Already supported
via the subject grammar; this design adds nothing new here. The network
view supports "right-click → dispatch direct" as an operator affordance.

## 9. Federation

NATS leaf-node federation already connects stacks. This design adds:

- **Opt-in subject re-publish.** A stack-local subscriber to
  `local.{org}.{stack}.system.agent.>` re-publishes to
  `federated.{network}.agent.{org}.{stack}.>`, signing each envelope
  with the stack's federation NKey. Re-publish is per-subject and
  per-direction (publish vs subscribe), configured in `cortex.yaml`.
- **Trust across stacks** — `signed_by[]` already validates across
  network boundaries when the verifier has the foreign principal in its
  registry. Federation extends the registry-population path: subscribing
  to `federated.{network}.agent.online.>` populates known foreign
  agents.
- **Provenance preserved.** Subject + signed_by chain combined preserve
  "this agent on this stack from this network."

### 9.1 Federation scope question (open)

Two stances:

- **Opt-in per envelope-type** — stacks declare which kinds of envelopes
  they re-publish (presence only, capabilities only, never tasks, etc.).
- **Opt-in per stack pair** — bilateral federation contracts between
  named peer stacks.

Probably both, layered. Resolution belongs in Phase B.

## 10. Relation to existing cortex / myelin

This design **adds** subjects + envelope types to the myelin vocabulary.
The myelin schema repository may need a contract update; the cortex side
of the protocol can land independently using vendored envelope shapes
until myelin upstream merges.

It **extends** the cortex AgentRegistry (`src/common/agents/registry.ts`):
the existing config-driven registry remains; a new bus-driven runtime
registry sits alongside it. The two are reconciled where appropriate
(e.g. trust verification uses union, capability dispatch prefers runtime).

It **supersedes** the boot-time `agents.capabilities.registered` per-pair
emission with the unified-descriptor model in §4.4, with a deprecation
window.

It **does not change** the Wave 3 capability-dispatch path (cortex#237).
That pattern keeps working; the network registry is an observability +
discovery layer on top.

## 11. Open Questions

Resolved decisions are in §3.4 (single 5-min TTL), §4 (myelin-aligned
subject grammar with `agent` as domain and `@{principal}` tail), §4.3
(public scope deferred to G-1115), §4.4 (supersession with deprecation
window), §5 (unified `AgentDescriptor`).

1. **Federation default.** Opt-in (safe) or opt-out (easier discovery)?
2. **Subject-rewrite mechanism.** Republisher in cortex, NATS leaf-node
   policy file, or both?
3. **Backpressure / large payloads.** Agent descriptors with many
   capabilities + presences may grow. Cap, split, or paginate?
4. **Cross-org / cross-stack identity collisions.** Two stacks named
   `work` in different orgs are unambiguous by `{org}.{stack}`. Within
   the same org? (NKey is the tiebreaker, but UX choice for display.)
5. **Deprecation window for `agents.capabilities.registered`.** How
   many releases of dual-emit before removal? Suggest 2 minor versions.
6. **Graph edge sources.** Are "recent-work" edges derived from a
   bounded tail of envelopes (cheap, lossy) or from a dedicated
   `dispatch.work.flow` envelope (heavier, exact)?
7. **Manual operator annotations.** Pin, mute, trust — stored where?
   Local MC DB only, or published as operator-signed envelopes so other
   stacks can observe operator opinion?
8. **Relation to Soma's assistant layer.** Multiple Cortex agents may
   host the same assistant identity. Surface that as edge ("hosts") or
   as visual grouping?

## 12. First Implementation Slices

Slices to be elaborated in the corresponding plan doc
(`docs/plan-agent-network-topology.md`). Sketched here for visibility:

### Slice 1 — Grounding & Protocol Draft

- Add this design document.
- Draft the envelope shape contract in a separate myelin-shape doc.
- Decide naming + sovereignty defaults.
- Stub the runtime registry interface with no producer wired.

### Slice 2 — Stack-Local Producer + Subscriber

- Implement `system.agent.online` / `heartbeat` / `offline` emission in
  cortex boot lifecycle.
- Implement the runtime registry subscriber, scoped to
  `local.{org}.{stack}.system.agent.>`.
- Coexist with existing `agents.capabilities.registered` (dual-emit).

### Slice 3 — Capabilities Delta + Liveness State Machine

- `system.agent.capabilities` delta envelope.
- Quiescent / stale transitions.
- Tests against fixture envelopes + injected clock.

### Slice 4 — Stack-Local Network View

- Lift Strata's React Flow + ELK pattern into
  `src/surface/mc/dashboard-v2/`.
- Render the runtime registry as a graph.
- Detail panel + filters + spotlight search.

### Slice 5 — Federation

- Subject re-publish on `federated.{network}.*`.
- Subscriber path for federated namespace.
- `cortex.yaml` federation block (opt-in per envelope-type).
- Network view scope filter.

### Slice 6 — Capability-Routing UX

- Highlight matching nodes for a hovered task / capability.
- Highlight matching tasks for a hovered agent.
- "Dispatch direct" affordance.

### Slice 7 — Public Scope

**Deferred to a separate umbrella (candidate G-1115).** Public-scope
discovery, authentication, and authorization are a substantial design
conversation in their own right. G-1114 ships stack-local + federated;
public-scope is out of scope and revisited as a follow-up.
