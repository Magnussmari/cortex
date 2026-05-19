# Plan — Agent Network Topology (G-1114)

**Status:** draft for review
**Branch:** `feat/g-1114-agent-network-topology`
**Driver:** Andreas
**Design:** [`docs/design-agent-network-topology.md`](design-agent-network-topology.md)
**Umbrella issue:** _(to be filed once this plan is agreed)_
**Process:** umbrella → phase sub-issues → sub-feature PRs; one PR per sub-feature; pilot review loop with Echo primary

---

## 1. What we're building (recap from design spec)

A Cortex stack today knows which agents are *configured* (from
`cortex.yaml`) but not which are *actually running*, when they joined,
when they went quiet, or which agents exist on other stacks reachable
via NATS leaf federation. G-1114 adds:

1. **Announce / heartbeat / offline protocol** on the bus — agents
   publish their own liveness using a small set of subjects under the
   new `agent` domain (`local.{org}.{stack}.agent.{action}.@{principal}`).
2. **Bus-built runtime registry** in cortex — a subscriber observes
   those envelopes and maintains an observable store of "who is here,
   in what state, with what capabilities."
3. **Network view in Mission Control** — graph render using the same
   stack Strata uses (`@xyflow/react` + `elkjs`). Operator sees the
   stack-local and federated agents, clicks to see capabilities + trust
   + recent activity.
4. **Federation namespace** — re-publish onto `federated.{org}.{stack}.agent.*`
   so peer stacks federated via NATS leaf nodes see each other.

The existing capability-matched dispatch path (cortex#237 / Wave 3) is
unchanged. The runtime registry is an observability + discovery layer
on top.

### 1.1 Iterative delivery — each phase ships visible value

Same principle as G-1113: every phase ships an operator-visible
improvement. No big-bang.

| Phase | What the operator sees after this phase |
|---|---|
| A — Grounding | Design + plan on `main`; protocol envelope shapes in the cortex codebase as inert types (no producer / no subscriber yet). |
| B — Local producer + subscriber | The local agent panel in MC shows your stack-local agents from bus envelopes; new agents pop up on boot, drop off after 5 min of silence. |
| C — Capabilities delta + liveness FSM | The same panel shows live capability badges that update without restart; offline agents render as muted with last-seen. |
| D — Network view (stack-local) | A new "Network" tab with the React Flow + ELK render of the stack-local agent graph. Click for details panel. |
| E — Federation | The Network view extends to federated stacks. `cortex.yaml` federation block controls opt-in. Foreign agents render with provenance. |
| F — Capability-routing UX | Hover a task in MC → matching agents highlight in the Network view. Right-click an agent → "dispatch direct." |

## 2. What this plan covers

Execution plan for `docs/design-agent-network-topology.md`. Same shape
as the G-1113 cockpit plan (umbrella → phase sub-issues → sub-feature
PRs). When this plan and reality disagree, this plan wins (or is updated,
never silently). When this plan and the design spec disagree on what
the protocol *is*, the design spec wins.

## 3. Issue + PR structure

```
G-1114  Agent Network Topology (umbrella issue)
  ├── G-1114.A  Phase A — Grounding & Protocol Types     (sub-issue → 1 PR)
  ├── G-1114.B  Phase B — Stack-Local Producer + Subscriber
  ├── G-1114.C  Phase C — Capabilities Delta + Liveness FSM
  ├── G-1114.D  Phase D — Network View (stack-local)
  ├── G-1114.E  Phase E — Federation
  └── G-1114.F  Phase F — Capability-Routing UX
```

Sub-issue + PR conventions identical to G-1113 (see G-1113 plan §3).
Branch name `feat/g-1114-{phase-letter}-{slot}-{slug}`. Title
`feat(cortex): G-1114.X.Y — {scope}`.

## 4. Phase sequencing

```
A  Grounding ──→ B  Producer+Subscriber ──→ C  Caps+FSM ──→ D  Network View ──┐
                                                                              ├──→ F  Cap-Routing UX
                                                       E  Federation ─────────┘
```

Mirrors `blueprint.yaml`:

- `G-1114.A` ← no deps
- `G-1114.B` ← `[G-1114.A]`
- `G-1114.C` ← `[G-1114.B]`
- `G-1114.D` ← `[G-1114.C]`
- `G-1114.E` ← `[G-1114.D]`
- `G-1114.F` ← `[G-1114.D, G-1114.E]`

Linear with one branch: E (federation) and a hardening of D could
parallelize once D ships. F waits on both. Sub-feature parallelism within
each phase is fine where dependencies allow.

## 5. The phases

### 5.1 Phase A — Grounding & Protocol Types (G-1114.A)

**Goal:** land design + plan on `main`, define the envelope TypeScript
shapes as inert types, and put a "G-1114 protocol incoming" stub on the
dashboard so the operator can see the work is in flight.

**Visible deliverable:**

- Design + plan docs on `main`.
- Inert TypeScript shapes for `AgentDescriptor` + `AgentOnlineEnvelope`
  + `AgentHeartbeatEnvelope` + `AgentOfflineEnvelope` +
  `AgentCapabilitiesChangedEnvelope` under `src/bus/agent-network/`.
- A "Network (preview)" tab in the dashboard shows a placeholder card
  linking to the design + plan. No registry data yet.

**Sub-features:**

- [ ] **G-1114.A.1** — Grounding PR · single PR
  - Add `docs/design-agent-network-topology.md` + `docs/plan-agent-network-topology.md`.
  - Add envelope shape types at `src/bus/agent-network/envelopes.ts`
    (no implementation; types only).
  - Add a stub "Network (preview)" tab in `src/surface/mc/dashboard-v2/`
    rendering a placeholder card with links to the design + plan.
  - Add G-1114 nodes to `blueprint.yaml`.

**Acceptance criteria:**

- Build succeeds, types compile.
- "Network (preview)" tab visible in dashboard, links resolve.
- Design + plan reachable via repo docs index (if one exists) or
  directly via path.

**Dependencies:** none.

---

### 5.2 Phase B — Stack-Local Producer + Subscriber (G-1114.B)

**Goal:** wire the protocol end-to-end in one stack. Agent boot emits
`agent.online`; periodic `agent.heartbeat`; graceful shutdown emits
`agent.offline`. A subscriber on the same stack builds the runtime
registry.

**Visible deliverable:**

- The "Network (preview)" tab from Phase A becomes a real **agents
  panel** listing your stack-local agents observed from the bus.
- A new agent (e.g. boot a second cortex process) pops up within
  seconds.
- A killed agent drops off after 5 min (or immediately on graceful
  shutdown).

**Sub-features (sketched — refined at phase start):**

- [ ] **G-1114.B.1** — Envelope builders + signing path
  - Concrete builders for the four envelope shapes using existing
    stack-signing infrastructure.
- [ ] **G-1114.B.2** — Producer wired into cortex boot lifecycle
  - `agent.online` on boot (after capabilities published).
  - `agent.heartbeat` every 60 s via a small scheduler.
  - `agent.offline` on graceful shutdown.
- [ ] **G-1114.B.3** — Runtime registry subscriber
  - Subscribes to `local.{org}.{stack}.agent.>`.
  - Observable store with `online`/`offline` state per NKey.
  - 5-min reaper for stale entries.
- [ ] **G-1114.B.4** — Agents panel UI
  - Replaces the Phase A placeholder card.
  - Lists agents with state (online/offline), last-seen, display name.
- [ ] **G-1114.B.5** — Dual-emit with existing `agents.capabilities.registered`
  - Keep emitting the legacy envelopes alongside the new ones during
    the deprecation window (per design §4.4).

**Acceptance criteria:**

- Boot a fresh cortex process → its agent appears in the panel within
  ~5 s.
- Stop a cortex process → its agent drops within 5 min (or instantly
  on graceful shutdown).
- Existing `capability-registry.ts` continues to publish; no regressions
  in code-review dispatch.

**Dependencies:** Phase A.

---

### 5.3 Phase C — Capabilities Delta + Liveness FSM (G-1114.C)

**Goal:** capability changes flow through the bus without restart, and
the liveness state machine handles offline correctly. The agents panel
becomes the operator's live view.

**Visible deliverable:**

- Capability badges on each agent card update live when the agent's
  declared capabilities change (e.g. plugin loaded, permission granted)
  without restarting the agent.
- Offline agents stay in the panel rendered as muted with a last-seen
  timestamp ("offline 3 min ago"); they don't vanish.
- Hover an agent card → tooltip with full capabilities list.

**Sub-features (sketched):**

- [ ] **G-1114.C.1** — `agent.capabilities-changed` producer
  - Cortex side emits when its declared capabilities mutate.
- [ ] **G-1114.C.2** — `agent.capabilities-changed` subscriber + diff
  - Runtime registry applies deltas; reconciles against heartbeat
    digest.
- [ ] **G-1114.C.3** — Liveness state machine in registry
  - Single 5-min TTL transition online ↔ offline (per design §3.4).
  - Graceful-offline path; restart returns to online.
- [ ] **G-1114.C.4** — Panel UI: capability badges + offline rendering
- [ ] **G-1114.C.5** — Fixture tests
  - Replay scripted envelope streams; assert registry state transitions.

**Acceptance criteria:**

- Capability changes propagate without restart; UI updates within ~5 s.
- Offline agents render distinctly; last-seen accurate.
- All four envelope types exercised by fixture suite.

**Dependencies:** Phase B.

---

### 5.4 Phase D — Network View (stack-local) (G-1114.D)

**Goal:** the graph view. Lift Strata's React Flow + ELK pattern into
the MC dashboard. Operator sees the stack-local agent network as a
graph and can click for details.

**Visible deliverable:**

- A "Network" tab (replaces the Phase A "Network (preview)" tab) with
  a React Flow + ELK rendered graph of the stack-local agents.
- Click an agent node → detail panel with identity, scope, liveness,
  capabilities, presences, trust roots, recent envelopes.
- Filter controls: by state (online / include offline) and by capability.
- `Cmd+K` spotlight search over agents.

**Sub-features (sketched):**

- [ ] **G-1114.D.1** — Lift Strata UI primitives
  - Vendor or import `FlowCanvas`, `ContextMenu`, `DetailPanel`,
    `SpotlightSearch`, `Legend` from `~/Developer/arc-library/strata/ui/`.
  - Adapt naming + types to cortex.
- [ ] **G-1114.D.2** — Graph data adapter
  - Convert runtime registry → React Flow nodes + edges.
  - Initial edges: trust (from `signed_by[]` observed).
- [ ] **G-1114.D.3** — ELK layout config
  - Layered-direction layout for trust edges; tune spacing for typical
    stack sizes (≤ 20 agents).
- [ ] **G-1114.D.4** — Detail panel
  - Wired to runtime registry; populates from `AgentRecord`.
- [ ] **G-1114.D.5** — Filters + spotlight search
- [ ] **G-1114.D.6** — Recent-envelope edge derivation (cheap path)
  - Bounded tail of observed subjects per agent; render as light edges
    in a secondary mode.

**Acceptance criteria:**

- Network tab renders the stack's agents as a graph with stable layout.
- Click → detail panel populates accurately.
- Filters + spotlight work.
- No regressions in other dashboard tabs.

**Dependencies:** Phase C.

---

### 5.5 Phase E — Federation (G-1114.E)

**Goal:** the same Network view extends to federated peer stacks via
opt-in `federated.{org}.{stack}.agent.*` re-publish.

**Visible deliverable:**

- A scope toggle on the Network view: `Stack` / `Federated` / `All`.
- When federation is enabled in `cortex.yaml`, peer stacks' agents
  render in the graph with a distinct visual treatment + the
  `{org}/{stack}` provenance shown.
- Trust edges crossing stacks render as such.

**Sub-features (sketched):**

- [ ] **G-1114.E.1** — Federation policy schema in `cortex.yaml`
  - Opt-in per envelope-type (presence / capabilities / both / none).
- [ ] **G-1114.E.2** — Republisher
  - Re-publish `local.{org}.{stack}.agent.*` onto
    `federated.{org}.{stack}.agent.*` per policy.
- [ ] **G-1114.E.3** — Subscriber path for federated namespace
  - Runtime registry consumes `federated.>.agent.>` with scope tagging.
- [ ] **G-1114.E.4** — UI: scope filter + foreign-agent visuals
- [ ] **G-1114.E.5** — Trust extension
  - `signed_by[]` verification of foreign agent envelopes; registry
    population for foreign principals.

**Acceptance criteria:**

- With two stacks federated via NATS leaf, both stacks' Network views
  show the other's agents (per opt-in policy).
- Cross-stack trust edges render correctly.
- Disabling federation cleanly removes foreign agents from the view.

**Dependencies:** Phase D.

**Open question:** federation default — opt-in (safe) or opt-out
(easier discovery)? Resolved during E.1.

---

### 5.6 Phase F — Capability-Routing UX (G-1114.F)

**Goal:** make capability-matched dispatch visible and operator-driven.

**Visible deliverable:**

- Hover a task in the task table → matching agents pulse / highlight
  in the Network view.
- Hover an agent in the Network view → tasks the agent could pick up
  highlight in the task table.
- Right-click an agent → "Dispatch direct…" opens the dispatch dialog
  pre-filled with the agent's principal address.

**Sub-features (sketched):**

- [ ] **G-1114.F.1** — Capability-match index
  - Builds task ↔ agent match map from runtime registry + task source.
- [ ] **G-1114.F.2** — Hover affordances
  - Cross-component highlight via shared selection store.
- [ ] **G-1114.F.3** — "Dispatch direct" affordance
  - Right-click menu + dialog; publishes to
    `local.{org}.{stack}.tasks.@{principal}.{capability}`.

**Acceptance criteria:**

- Hover-highlight works in both directions.
- Direct dispatch publishes a correctly-shaped envelope claimable by
  the targeted agent.

**Dependencies:** Phase D + Phase E.

---

## 6. Sequencing summary

| Phase | Depends on | Indicative PR count |
|---|---|---|
| A — Grounding & types | — | 1 |
| B — Local producer + subscriber | A | 5 |
| C — Capabilities delta + FSM | B | 5 |
| D — Network view (stack-local) | C | 6 |
| E — Federation | D | 5 |
| F — Capability-routing UX | D + E | 3 |

Total indicative: **~25 PRs** across the umbrella.

## 7. Open decisions

Carried from design §11. Resolve at the start of the phase that depends
on each, not now:

1. Federation default — opt-in vs opt-out. → resolved by E.1.
2. Subject-rewrite mechanism — cortex republisher vs leaf-node policy.
   → resolved by E.2.
3. Payload size limits on `AgentDescriptor`. → resolved during B.1.
4. Cross-org identity collision UX. → resolved during D.4.
5. Deprecation window for `agents.capabilities.registered`. → resolved
   during B.5.
6. Recent-work edge source — bounded tail vs dedicated envelope.
   → resolved during D.6.
7. Operator annotations (pin / mute / trust) persistence. → resolved
   during D.4.
8. Soma assistant grouping in graph. → resolved during D.2 / D.4.

## 8. Process notes

- **Worktree discipline.** Each sub-feature gets its own worktree under
  `../cortex-g-1114-{slot}-{slug}` cut from `origin/main`. The umbrella
  branch (`feat/g-1114-agent-network-topology`) only carries this plan +
  the design spec; sub-feature work happens on fresh branches.
- **Review loop.** Echo primary on PR review via the pilot loop; in-session
  sub-agent (Engineer subagent_type) fallback when Echo dispatch flakes.
- **Tick discipline.** Merging a sub-feature PR ticks the box in this plan
  AND comments-and-closes the sub-feature sub-issue. The phase sub-issue
  closes when all its sub-features tick. The umbrella closes when all
  phases close.
- **Plan vs blueprint.** The dependency graph lives in `blueprint.yaml`
  under `G-1114` + `G-1114.A` .. `G-1114.F` (+ `G-1114.A.1` pre-filed).
  Sub-feature blueprint nodes for B..F are filed at phase start, matching
  the sub-issue filing convention in §3.
- **Relation to G-1113.** Independent umbrellas. G-1113 Phase D will
  surface a config-driven Stack Agents panel; G-1114 supersedes it with
  the bus-driven runtime registry when G-1114.D lands. No hard blocking
  between the two umbrellas.
- **Relation to myelin.** This design extends the myelin namespace with a
  new `agent` domain. The agent-lifecycle subjects themselves are cortex
  M7 territory per myelin/specs/namespace.md line 292. A follow-up myelin
  PR may codify the `agent` domain in the namespace spec for ecosystem
  consistency; not blocking on it.
- **No GitHub Projects board.** The umbrella + sub-issues are the board.
- **Autonomous work mode.** Once this plan is agreed, the TaskList is
  populated from §5: one TaskCreate per open `G-1114.X.Y` checkbox.
  Agents pick the next ready task (dependencies satisfied) and work it
  through to merged PR.
