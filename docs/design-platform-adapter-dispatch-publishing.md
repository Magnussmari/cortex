# Platform Adapter Dispatch Publishing — Design Spec

**Status:** Skeleton — surfaced from `/improve-codebase-architecture` grilling on the dispatch-handler / dispatch-listener seam (2026-05-22).
**Date:** 2026-05-22
**Driver:** Jens-Christian
**Scope:** Cortex `src/adapters/*`, `src/bus/dispatch-handler.ts`, `src/runner/dispatch-listener.ts`, `src/substrates/*`, `src/renderers/*`. Touches MIG-7.2 (agent identity model) as pre-requisite.
**Related:**
- `CONTEXT.md` — dispatch source / dispatch sink / substrate harness / response routing
- `src/common/substrates/types.ts` — `SessionHarness` interface (already in place)
- `docs/architecture.md` — M1–M7 stack model
- `docs/plan-cortex-migration.md` — migration phase plan

---

## 1. Why this exists

Today two parallel code paths drive Claude Code dispatches:

- `src/bus/dispatch-handler.ts` (F-007, pre-substrate-seam) — platform-message in, CC orchestration inline, platform-response out. Used by Discord / Mattermost / Slack adapters.
- `src/runner/dispatch-listener.ts` (MIG-4.5 / cortex#113 Phase A.1b) — bus-envelope in, substrate harness drives, lifecycle envelopes out.

Same word ("dispatch") in both files, different roles, different generation. The listener already lives behind the substrate-harness seam (`SessionHarness`). The handler does not — it still spawns `CCSession` directly and owns `AgentTeam` / `SessionManager` / `TaskTracker` / heartbeat inline.

This spec proposes **Direction A**: platform adapters become **dispatch sources** that publish inbound dispatch envelopes onto the bus. The existing `dispatch-listener` consumes all dispatches regardless of origin (platform message or peer bot). `dispatch-handler.ts` retires.

---

## 2. Direction A in one diagram

```
            Discord/Mattermost/Slack message
                       │
                       ▼
              ┌─────────────────────┐
              │ Platform adapter    │  ◄── dispatch source (CONTEXT.md)
              │ (signs as agent)    │
              └──────────┬──────────┘
                         │ publishes
                         ▼
       local.{principal}.{stack}.dispatch.task.received
                         │
                         ▼
              ┌─────────────────────┐
              │ dispatch-listener   │  ◄── existing
              │ (policy + trust)    │
              └──────────┬──────────┘
                         │ harness.dispatch(req)
                         ▼
              ┌─────────────────────┐
              │ Substrate harness   │  ◄── CC / agent-team / bus-peer / …
              └──────────┬──────────┘
                         │ yields lifecycle envelopes
                         ▼
       local.{principal}.{stack}.dispatch.task.{started|completed|failed|aborted}
                         │
                         ▼
              ┌─────────────────────┐
              │ Platform adapter    │  ◄── dispatch sink (CONTEXT.md)
              │ (subscribes by      │
              │  response_routing)  │
              └─────────────────────┘
                         │
                         ▼
            Platform response (postResponse / sendProgress)
```

Adapter plays two roles: **dispatch source** (inbound) and **dispatch sink** (outbound).

---

## 3. The pre/middle/post split

### 3.1 Pre-envelope (adapter, dispatch-source side)

Adapter receives raw platform message and produces a signed envelope. Steps that move out of `dispatch-handler.ts` and into the adapter:

1. Coarse access check (Q5c — adapter still owns "may this user speak at all")
2. Keyword parsing → dispatch mode (`async:` / `team:` / none)
3. Channel-context resolution (repo, entity, network)
4. Conversation history fetch
5. Attachment download (Q4a — adapter has auth context; payload carries base64)
6. Envelope build + sign (Q1a — adapter signs as the hosted agent)
7. Publish on `local.{principal}.{stack}.dispatch.task.received`

### 3.2 Bus middle (dispatch-listener)

No change from today's flow:

1. signed_by chain verify
2. Policy gate (Q5c — listener owns fine-grained authorization)
3. Intent resolution
4. Harness selection (claude-code / agent-team / …)
5. `for await (env of harness.dispatch(req))` → `runtime.publish(env)`

### 3.3 Post-envelope (adapter, dispatch-sink side)

Adapter registers a SurfaceAdapter on `dispatch.task.{started|completed|failed|aborted}` filtered by `response_routing.adapter_instance` + `correlation_id`:

1. `started` → `sendProgress(target, "thinking…")`
2. progress events → edit progress message
3. `completed` → `postResponse(target, text, files)`
4. `failed` / `aborted` → post error message
5. `clearProgress` after terminal

---

## 4. Pinned design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| Q1a | Adapter signs envelopes as the hosted agent | Matches existing trust model; first signer = hosted agent's nkey. Pre-requisite: MIG-7.2 (adapter holds an `agent` not legacy BotConfig). |
| Q2 | Cortex owns M7 dispatch subject grammar; myelin owns transport grammar | Subject *segments* `dispatch.task.{action}` and `tasks.{capability}` are application-layer (cortex M7). Subject *prefix* `{scope}.{principal}.{stack}` + signed_by + envelope schema are myelin. Confirm with myelin team. |
| Q3a | Stateless response routing on the wire | Inbound envelope payload carries `response_routing`. Listener echoes onto all lifecycle envelopes. Dispatch sink reads routing → posts. No in-memory `correlation_id → ResponseTarget` map. |
| Q4a | Inline base64 attachments in envelope payload | Federation-friendly (info flows back across stacks). Accepted cost: envelope bloat. Q4b (federated CAS) deferred. |
| Q5c | Two-pass access: adapter coarse + listener fine-grained | Adapter retains "may this principal speak at all" guard. Listener's policy-engine owns "what tools may this dispatch use". Q5b (policy-engine sole authority) is the long-term destination — filed as follow-up. |
| Q6c | AgentTeam-as-harness (new `HarnessId = "agent-team"`) | Delegate dispatch mode maps onto a meta-harness that composes single-agent harnesses. Listener stays substrate-agnostic. |
| Q7a + Q7c | Phased: Discord first behind a base class | Build envelope-publishing helpers into an adapter base; Discord adopts envelope mode behind a feature flag; mattermost + slack follow once Discord is stable. |

---

## 5. Subject grammar

Per `CONTEXT.md` updates from this grilling:

| Mode | Inbound subject | Lifecycle subject |
|------|-----------------|--------------------|
| Direct (intra-stack) | `dispatch.task.received` | `dispatch.task.{started|completed|failed|aborted}` |
| Direct (peer-to-peer) | `dispatch.task.dispatched` | same |
| Offer | `tasks.{capability}.{subcapability}` | same |
| Delegate | (undefined; see §8) | same |

All prefixed by `local.{principal}.{stack}.`. Lifecycle envelopes joined to inbound by `correlation_id`.

`response_routing` field on the inbound envelope payload — shape TBD; sketch:

```ts
type ResponseRouting = {
  surface: "discord" | "mattermost" | "slack" | "mc" | "pagerduty";
  adapter_instance: string;        // matches PlatformAdapter.instanceId
  channel_id: string;              // platform-native
  thread_id?: string;              // platform-native; optional
  message_id?: string;             // platform-native; for reply correlation
  _native?: unknown;               // escape hatch
};
```

Listener echoes this onto every `dispatch.task.{action}` lifecycle envelope.

---

## 6. signed_by chain examples

### 6.1 Discord-originated Direct dispatch

Adapter is hosted by `agent:luna` on stack `andreas/meta-factory`. Inbound envelope:

```
source: andreas.luna.meta-factory
signed_by: [
  { kid: "agent:luna", alg: "ed25519", sig: "…" }
]
type: dispatch.task.received
```

Listener verifies the chain via `verifySignedByChain` against `TrustResolver`. Single-signer envelopes pass when the kid resolves to a known agent on the local stack.

### 6.2 Peer-to-peer Direct (cross-stack)

Sender (cortex on `andreas/work` stack, agent `pilot`) publishes a `dispatch.task.dispatched` envelope. Recipient stack's bus-peer harness picks it up. signed_by carries the originating agent only — recipient stack signs *outbound* lifecycle envelopes with its own agent identity.

### 6.3 Delegate dispatch (AgentTeam harness)

Inbound looks identical to Direct (`dispatch.task.received`). Listener routes to `agent-team` harness based on payload `mode = "delegate"`. Sub-dispatches the team initiates carry the team-harness as additional signer in their `signed_by` chain.

---

## 7. Migration sequence

| Stage | Work | Pre-requisite |
|-------|------|----------------|
| 0 | This design doc; ADR equivalent recorded | — |
| 1 | Finish MIG-7.2 — adapter holds an `agent` not legacy `BotConfig.agent.discord[]` | — |
| 2 | Confirm Q2 with myelin team; pin signed_by chain rules for adapter-signs-as-agent | Stage 1 |
| 3 | Build `EnvelopePublishingAdapterBase` — shared dispatch-source helpers (sign, derive subject, payload schema, response_routing). Add `AgentTeamHarness` (Q6c). | Stages 1–2 |
| 4 | Discord adapter adopts envelope mode behind feature flag (`CORTEX_DISCORD_ENVELOPE_MODE=1`). Both paths coexist. | Stage 3 |
| 5 | Discord adapter dispatch-sink — subscribe to `dispatch.task.{started\|completed\|failed\|aborted}` filtered by routing; render via existing `postResponse` / `sendProgress`. Verify parity with handler path. | Stage 4 |
| 6 | Mattermost + Slack flip. Feature flag removed once all three on envelope mode in prod for a stable period. | Stage 5 |
| 7 | Delete `src/bus/dispatch-handler.ts`. Rename `dispatch-listener.ts` if a better name surfaces (likely `dispatch-runtime.ts` or similar). Update `docs/architecture.md`. | Stage 6 |

---

## 8. Open seams

- **Delegate inbound subject grammar.** `dispatch.task.received` works for v1 (mode in payload). Long-term: subject-level encoding (`tasks.@{assistant}.delegate.…`) is the CONTEXT.md-aligned destination. File as follow-up.
- **Q5b — policy-engine sole access authority.** Adapter retains coarse-access today (Q5c). Long-term: adapter holds only identity; listener's policy-engine computes everything. Filed as separate issue.
- **Q4b — federated CAS for attachments.** Inline base64 works v1; will blow up envelope size for video / large dumps. Replace with hash-addressed blob store keyed by `correlation_id`. Filed as separate issue.
- **Adapter-originated Direct to `tasks.@{assistant}.chat`.** CONTEXT.md example dialogue shows the intended grammar; today's `dispatch.task.received` is the pragmatic v1. Future seam.
- **Where AgentTeam lives during migration.** Today inside `dispatch-handler.ts` as a direct import. Stage 3 lifts it into a harness. The pre-harness path (handler's `team:` keyword) must be cut over with the rest in Stages 4–6.

---

## 9. Vocabulary additions to CONTEXT.md (already landed)

This grilling added four terms to `CONTEXT.md`:

- **Substrate harness** — M6 runtime executing one dispatch on one substrate
- **Dispatch source** — anything signing + publishing inbound dispatch envelopes
- **Dispatch sink** — anything consuming lifecycle envelopes and rendering to a surface
- **Response routing** — payload field with originating surface address; echoed on lifecycle envelopes

Plus reconciliation: `tasks` and `dispatch` are distinct, coexisting domains. Not a rename in flight.

---

## 10. Out of scope

- Any change to `myelin/` envelope schema beyond confirming the adapter-signs-as-agent rule
- Mission Control dashboard changes (dashboard remains a dispatch sink; only the consumer side may need a render-completion subscriber update)
- Renaming `src/renderers/` to `src/dispatch-sinks/` (code-name is `Renderer`; design term is `dispatch sink` — both stay)
- Q2 reconciliation with myelin's namespace.md if conflicts arise — out-of-band conversation with myelin team
