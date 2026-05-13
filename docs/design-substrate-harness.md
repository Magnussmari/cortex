# SessionHarness — Multi-Substrate Agent Dispatch (Design)

**Status:** Draft — design for review. Implementation lands in follow-up PRs (A/B/C/D, §7).
**Date:** 2026-05-13
**Driver:** Andreas (post-v1-cutover direction)
**Closes design step of:** cortex#91
**Related:** cortex#58 (F-2 substrate harness schema seam — `AgentSchema.runtime` already optional), cortex#70 (Cursor substrate, downstream consumer), cortex#88 item 9 (`${PAI_DIR}` decoupling), `docs/design-arc-agent-bots.md` (predecessor — `agents.d/` fragments + substrate provenance), `docs/design-pi-dev-review-agent.md` (separates substrate from presence; sage is its incarnation), `the-metafactory/sage` (live bus-peer reference)

---

## 1. Goal + Non-Goals

### Goal

Decouple cortex from `~/.claude/` and the `claude-code` CLI by introducing a single substrate-facing abstraction — `SessionHarness` — that both the existing in-process Claude Code spawn pattern (`src/runner/cc-session.ts`) and the existing out-of-process bus-peer pattern (sage) collapse into. Cortex's runner, dispatcher, and dashboard speak only `MyelinEnvelope`; the harness is what bridges an envelope to the substrate that produces the next envelope.

The v1 cutover just landed. Two substrate patterns are already running in production:

1. **In-process child** — Luna/Echo/Forge via `cc-session.ts` spawning `claude --print --output-format stream-json`
2. **Out-of-process bus peer** — sage subscribing to `local.{org}.tasks.code-review.>` directly, executing via pi.dev, publishing back

We have one harness implementation (claude-code, in-process) and one harness pattern (bus peer, no implementation in cortex). This design formalises both as instances of a single contract so cortex can dispatch to either uniformly, and so additional substrates (Codex, Cursor, Gemini, Mistral, pi.dev direct) are single-file additions later.

### Non-goals

- **Not changing the Myelin envelope schema.** The whole point of myelin is that envelope shape is harness-independent — the schema commit (`SCHEMA_SOURCE_COMMIT` in `src/bus/myelin/envelope-validator.ts`) stays pinned.
- **Not changing Discord/Mattermost adapters, NATS link, role-resolver, persona markdown, or the Mission Control dashboard.** All already harness-agnostic.
- **Not implementing Codex / Cursor / Gemini / Mistral harnesses in this design.** The contract must support them, and §8 surfaces the open questions, but each is a separate follow-up issue (cortex#70 for Cursor, etc.).
- **Not changing sage.** Sage already does its half of the bus-peer pattern. This design describes the cortex-side handle; sage requires zero code changes.
- **Not redesigning capability registration.** The NATS-KV capability registry (sage's Phase-2 work) stays. Harnesses declare what they can do; capability routing is a separate concern.

---

## 2. Reality Today — Two Patterns Already Running

Cortex's dispatcher (`src/runner/dispatch-listener.ts`) currently has one path: parse a `dispatch.task.received` envelope, build `CCSessionOpts`, spawn `CCSession`, publish lifecycle envelopes. The second pattern (sage) runs entirely outside cortex — cortex never spawns sage, never knows sage exists at runtime beyond a NATS subject subscription.

### 2.1 In-process child (Luna / Echo / Forge)

```
                                  ┌─────────────────────────────┐
   local.{org}.dispatch.task.     │       NATS (myelin bus)     │
   received                       └──────────────┬──────────────┘
                                                 │
                                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │ cortex/src/runner/dispatch-listener.ts                     │
   │   parsePayload(envelope) → CCSessionOpts                   │
   │   emit dispatch.task.started                               │
   │   ↓                                                        │
   │ cortex/src/runner/cc-session.ts                            │
   │   Bun.spawn(["claude", ...args])                           │
   │   ─→ stream-json on stdout                                 │
   │   ─→ parsed events: init / text / tool_use / result        │
   │   ─→ emit  dispatch.task.{completed|failed|aborted}        │
   └────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
                                  ┌─────────────────────────────┐
                                  │       NATS (myelin bus)     │
                                  └─────────────────────────────┘
```

Side effects cortex currently owns directly:

- `~/.claude/hooks/Cortex*.hook.ts` install (PAI hook surface)
- `~/.claude/events/raw/` → `~/.claude/events/published/` JSONL pipeline (`src/taps/cc-events/cc-events.ts`)
- `GROVE_AGENT_ID` / `GROVE_CHANNEL` / `GROVE_BASH_GUARD` env-var contract
- `${PAI_DIR}` lookup for hook resolution (cortex#88 item 9)
- `bash-guard.hook.ts` / `EventLogger.hook.ts` shipped under `src/runner/hooks/`

All of those are claude-code-substrate concerns leaking into the cortex root.

### 2.2 Out-of-process bus peer (sage)

```
   local.{org}.tasks.code-review.>            ┌──────────────────┐
   local.{org}.tasks.@did-mf-sage.>           │  NATS (myelin)   │
                                              └──────────┬───────┘
                                                         │
                                                         ▼
            ┌──────────────────────────────────────────────────────┐
            │  sage (own daemon, own creds, own launchd plist)     │
            │    src/bus/bridge.ts        subscribe + validate     │
            │    src/lenses/workflow.ts   gh pr view + pi -p ...   │
            │    publish:                                          │
            │      local.{org}.dispatch.task.{started|completed}   │
            │      local.{org}.code.pr.review.{approved|...}       │
            └──────────────────────────────────────────────────────┘
                                                         │
                                                         ▼
                                              ┌──────────────────┐
                                              │  NATS (myelin)   │
                                              └──────────────────┘
                                                         │
                                                         ▼
                          cortex/src/surface/mc dashboard renders verdicts
                          pilot loop consumes review.decision
```

Cortex publishes the inbound task envelope (`tasks.code-review.*`) and subscribes to reply subjects (`code.pr.review.*`, `dispatch.task.*`). Cortex never spawns sage; arc installed the daemon at provisioning time.

Both patterns produce and consume `MyelinEnvelope`. The shape difference is where the spawn happens (`Bun.spawn` inside cortex vs `launchctl` at install time outside cortex). The lifecycle envelopes are identical.

### 2.3 What's missing

There is no shared interface in cortex's source that says "this thing turns a `DispatchRequest` into a stream of `MyelinEnvelope`". `dispatch-listener.ts` knows about `CCSession` directly (`import { CCSession } from "./cc-session"`). To add sage as a first-class addressable agent — say `@sage` mentioned in Discord that cortex should route to — we'd need a parallel code path next to `CCSessionFactory`, and we'd repeat the lifecycle event publishing logic. That doesn't scale to Codex/Cursor/Gemini.

The fix is one abstraction.

---

## 3. The SessionHarness Contract

```ts
// src/common/substrates/types.ts (NEW — lands in PR A)

import type { Envelope as MyelinEnvelope } from "../../bus/myelin/envelope-validator";

/** Stable substrate identifiers. Closed enum — adding a value is a breaking
 *  change because operators write it in `agents[].runtime.harness:` and the
 *  dashboard renders it as a column. New substrates extend this list in a
 *  follow-up PR. */
export type HarnessId =
  | "claude-code"
  | "bus-peer"
  | "openai-codex"
  | "cursor"
  | "gemini"
  | "mistral"
  | "pi-dev";

/** Substrate-agnostic capability descriptor. The harness DECLARES what it can
 *  do; the dispatcher decides whether to route a given task. Names are
 *  intentionally coarse — `code-review` and `tool-use` rather than
 *  `gh-pr-review-typescript`. Fine-grained routing happens via the NATS-KV
 *  capability registry (Phase 2 of the pi-dev review design). */
export type Capability =
  | "tool-use"        // can invoke tools (file ops, shell, web fetch, ...)
  | "file-ops"        // can read/write files in `allowedDirs`
  | "shell"           // can execute shell commands
  | "vision"          // can ingest images
  | "code-review"     // accepts `tasks.code-review.*` envelopes
  | "research"        // accepts `tasks.research.*` envelopes
  | "streaming";      // emits incremental envelopes (vs single terminal envelope)

/** Per-request tool authorisation. The dispatcher composes this from the
 *  agent's `roles[]` + the role-resolver's bundle, identically to today's
 *  `allowedTools` / `disallowedTools` on `CCSessionOpts`. The harness is
 *  responsible for translating to its substrate's native idiom (CC's
 *  `--allowedTools Bash,Edit,Write`; sage's pi.dev tool whitelist; etc). */
export interface ToolCapability {
  /** Allow-list. Empty = no tools (text-only). */
  allow: string[];
  /** Deny-list (applied after allow). Empty = no extra restrictions. */
  deny?: string[];
  /** Directories the harness may grant file access to. */
  allowedDirs?: string[];
}

export interface DispatchRequest {
  /** UUID-shaped task id — same as `envelope.correlation_id` upstream. */
  taskId: string;
  /** Logical agent id (`luna`, `echo`, `sage`, ...). Resolved from the
   *  inbound envelope by the dispatcher. */
  agentId: string;
  /** Resolved persona content (markdown). Optional: bus-peer harnesses
   *  typically ignore this (sage ships its own persona). */
  persona?: { path: string; content: string };
  /** The prompt or task description. Required for child-process substrates;
   *  bus-peer substrates may ignore in favour of `payload`. */
  prompt: string;
  /** Per-request tool authorisation. */
  tools: ToolCapability;
  /** Substrate-agnostic context (discord history, attachments, env hints). */
  context?: ContextRef[];
  /** Raw envelope payload — passed through for bus-peer substrates that
   *  parse their own contract (`pr_url`, `(owner, repo, number)`, etc.). */
  payload?: unknown;
  /** Operator + entity hints (project, github entity, operator id) — same
   *  shape as today's `GROVE_PROJECT` / `GROVE_ENTITY` / `GROVE_OPERATOR`. */
  hints?: {
    project?: string;
    entity?: string;
    operator?: string;
    channel?: string;
    network?: string;
  };
  /** Inactivity timeout for child-process substrates; overall timeout for
   *  bus-peer substrates. Default at harness level. */
  timeoutMs?: number;
}

export interface ContextRef {
  kind: "discord-history" | "attachment" | "env" | "file";
  uri: string;
  content?: string;
}

export interface SessionHarness {
  readonly id: HarnessId;
  readonly capabilities: Capability[];

  /** Dispatch the request. Returns an async iterable of MyelinEnvelopes —
   *  one or more progress/result envelopes followed by a terminal envelope
   *  with `status: "complete" | "error" | "timeout"` (the dispatcher reads
   *  the terminal envelope's status to decide which lifecycle event to
   *  publish: `dispatch.task.completed|failed|aborted`). */
  dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope>;

  /** Optional graceful shutdown. `graceful: true` should attempt to drain
   *  in-flight requests; `graceful: false` kills hard. Default is no-op for
   *  bus-peer harnesses (they don't own their substrate process). */
  shutdown?(opts: { graceful: boolean }): Promise<void>;
}
```

### Why `AsyncIterable<MyelinEnvelope>`?

Five reasons, in order of weight:

1. **Mirrors `myelin.NATSTransport.subscribe(): AsyncIterable<Envelope>`** — the bus-peer harness can wrap the NATS subscription directly without translation. The CC harness translates stream-json into envelopes and yields them; consumers don't see the difference.
2. **Supports streaming progress.** Today's `cc-session.ts` emits incremental `text` / `tool_use` events on the EventEmitter — those become incremental envelopes (e.g. `dispatch.task.progress`) for the dashboard to render mid-task. Same shape as sage's `dispatch.task.progress` envelopes.
3. **Terminal envelope = explicit completion signal.** The iterable ends when the harness yields a terminal envelope and closes the stream. No separate `.done()` method needed. Cortex's existing `dispatch.task.{completed|failed|aborted}` lifecycle envelopes are the natural terminal types.
4. **`for await` is the cancellation idiom.** Wrap the loop in `AbortSignal` (already in the surface-router contract) and the surface-router's render-timeout isolation handles harness cancellation uniformly. No new cancellation API.
5. **Future request/reply mapping.** A `request: { reply: subject }` envelope from cortex maps to a `reply` envelope from the harness. The harness yields one envelope and ends. Same iterable shape; different cardinality.

The alternative (`EventEmitter` as today, or a `Promise<Result>` blob) loses either the streaming partial outputs or the explicit completion semantics. Async iterables get both for free.

---

## 4. Implementation 1 — ClaudeCodeHarness

Wraps the existing `src/runner/cc-session.ts` spawn logic without changing behaviour. Lives at `src/substrates/claude-code/harness.ts`.

### 4.1 File layout

```
src/substrates/claude-code/
  harness.ts                  — implements SessionHarness; thin wrapper around cc-session
  cc-session.ts               — MOVED from src/runner/cc-session.ts (no logic change)
  claude-invoker.ts           — MOVED from src/runner/claude-invoker.ts
  stream-parser.ts            — MOVED from src/runner/stream-parser.ts
  event-translator.ts         — NEW: stream-json events → MyelinEnvelope
  security-preamble.ts        — MOVED from src/runner/security-preamble.ts
  hooks/
    bash-guard.hook.ts        — MOVED from src/runner/hooks/
    event-logger.hook.ts      — MOVED from src/runner/hooks/
  pai-install.ts              — NEW: installer for ~/.claude/hooks/* + settings.json fragment
  __tests__/
    harness.test.ts           — substrate-level (uses fake CCSession)
    cc-session.test.ts        — MOVED from src/runner/__tests__/
```

### 4.2 The translation

`cc-session.ts` emits stream-json events on an EventEmitter. `event-translator.ts` maps each event to a MyelinEnvelope:

| stream-json event | Yielded envelope (subject suffix) | Notes |
|---|---|---|
| `init` (with sessionId) | `dispatch.task.started` | Already emitted by `dispatch-listener.ts` today; in PR A the listener stops doing this and lets the harness yield. |
| `text` | `dispatch.task.progress` (kind=`text`) | New — gives the dashboard mid-task streaming. |
| `tool_use` | `dispatch.task.progress` (kind=`tool_use`) | Same. |
| `result` (success) | `dispatch.task.completed` | Terminal. |
| `result` (error / non-zero exit) | `dispatch.task.failed` | Terminal. |
| inactivity timeout / `kill()` | `dispatch.task.aborted` | Terminal. Reason carried in payload. |

The lifecycle event helpers (`createDispatchTaskStartedEvent`, etc.) in `src/bus/dispatch-events.ts` stay where they are — the translator imports them. This means the envelope schema is unchanged; only the producer site moves.

### 4.3 CC-specific surface lives here

After PR D (the cleanup), all of these are under `src/substrates/claude-code/` and load only when at least one agent declares `runtime.harness: claude-code`:

- `~/.claude/hooks/Cortex*.hook.ts` install — moves into `pai-install.ts`, run by the harness constructor on first use
- `~/.claude/events/raw/` ↔ `~/.claude/events/published/` JSONL pipeline (`src/taps/cc-events/cc-events.ts` becomes substrate-local)
- `${PAI_DIR}` env-var resolution
- `GROVE_AGENT_ID` / `GROVE_CHANNEL` / `GROVE_BASH_GUARD` env-var contract
- `bash-guard.hook.ts` allow-list config
- `--output-format stream-json` flag
- `claude` binary path resolution
- `--add-dir` / `--allowedTools` / `--disallowedTools` translation from `ToolCapability`

`src/taps/cc-events/cc-events.ts` is the most awkward of these — it currently lives at the cortex top level because the EventLogger hook writes to a global JSONL directory. After PR D it becomes `src/substrates/claude-code/cc-events-tap.ts` and is started/stopped by the harness's lifecycle, not by cortex's main entrypoint. The dashboard's `src/surface/mc/hooks/poller.ts` (which today polls `~/.claude/events/raw/`) is replaced by the harness publishing progress envelopes onto the bus — the dashboard then reads from the bus, which it already does. The poller becomes dead code after PR D.

### 4.4 Backward-compat shim

`src/runner/cc-session.ts` becomes a thin re-export so any in-tree code that still imports the old path keeps compiling during PR A and PR B:

```ts
// src/runner/cc-session.ts (after PR A)
/** @deprecated — moved to substrates/claude-code/. Re-exported for transition. */
export { CCSession, CCSessionOpts, CCSessionResult } from "../substrates/claude-code/cc-session";
```

PR D deletes the shim once `dispatch-listener.ts` is rewritten to consume the harness interface.

---

## 5. Implementation 2 — BusPeerHarness

Wraps the publish-dispatch + subscribe-reply pattern sage already implements. Lives at `src/substrates/bus-peer/harness.ts`.

### 5.1 The contract sage already follows

Sage's bridge subscribes to inbound subjects and publishes back on a parallel reply pattern. From the sage README and `docs/design-pi-dev-review-agent.md`:

```
Inbound  (sage subscribes):
  local.{org}.tasks.code-review.>              broadcast (competing consumer)
  local.{org}.tasks.@did-mf-sage.>             direct (named recipient)

Outbound (sage publishes):
  local.{org}.dispatch.task.{started|progress|completed|failed}
  local.{org}.code.pr.review.{approved|changes-requested|commented}
```

`BusPeerHarness` is the cortex-side handle for this pattern. It does not assume sage specifically — any future bus-peer (a pi-dev research agent, a third-party reviewer daemon) follows the same shape.

### 5.2 Subject conventions

Per cortex#91 + the existing sage subjects, we adopt:

| Direction | Subject | Notes |
|---|---|---|
| Dispatch (cortex → peer) | `local.{org}.dispatch.{peerId}.{requestId}` | Direct request to a named peer. `requestId = envelope.correlation_id`. |
| Reply (peer → cortex) | `local.{org}.review.{peerId}.{requestId}` OR a peer-declared subject | Per G-1111 taxonomy; sage uses `code.pr.review.*` for verdict envelopes + `dispatch.task.*` for lifecycle. The harness subscribes to whatever the agent's `runtime.peer.outboundSubject` declares. |

Subjects are declared per-agent in the YAML schema (§6) so a peer can re-use either the dispatch/review or the broadcast/direct pattern depending on its install posture. Sage today uses both — broadcast for capability-based routing and direct for named addressing. The harness handles either.

**Terminal envelope detection.** The harness watches the reply subscription for an envelope with `payload.status` in `{"complete", "error", "timeout"}` (matching cortex's existing `dispatch.task.{completed|failed|aborted}` semantics) OR any envelope on the `dispatch.task.{completed|failed|aborted}` subject. Either yields, then the iterable ends.

### 5.3 Timeout

`agents[].runtime.peer.timeoutMs` is the wall-clock deadline (default 5 minutes — sage's typical PR review runs <60s; the buffer is for cold pi.dev model spin-up). If no terminal envelope arrives, the harness yields a synthetic `dispatch.task.aborted` envelope with `reason: "timeout"` and ends the iterable.

### 5.4 Sage requires no changes

Sage already publishes valid envelopes on the reply subjects. The harness construction is purely cortex-side. To dispatch a review to sage from `#cortex`, the operator just drops a fragment:

```yaml
# ~/.config/cortex/agents.d/sage.yaml — installed by `arc install github:the-metafactory/sage`
id: sage
displayName: Sage
persona: ~/.config/cortex/personas/sage.md
roles: [reviewer]
trust: [luna, holly, ivy]
runtime:
  harness: bus-peer
  peer:
    inboundSubject: "local.{org}.tasks.@did-mf-sage.review.{requestId}"
    outboundSubject: "local.{org}.code.pr.review.>"
    timeoutMs: 300000
  capabilities: [code-review]
presence:
  discord:
    enabled: false   # sage has no Discord identity — bus-peer with no surface
```

That's the full contract. Mentioning `@sage` in `#cortex` routes through `BusPeerHarness` → publishes `local.metafactory.tasks.@did-mf-sage.review.<uuid>` → sage's bridge picks it up → sage runs the lens workflow → publishes verdict + lifecycle envelopes → cortex's harness yields them → dashboard renders.

---

## 6. cortex.yaml Schema Changes

`AgentSchema.runtime` already exists (cortex#58 — F-2 substrate harness schema seam) at `src/common/types/cortex-config.ts` ~line 226. Today it carries `substrate` + `mode` + `capabilities`. This design **extends** it; it does not replace it.

### 6.1 Updated runtime schema

```ts
// src/common/types/cortex-config.ts — AgentRuntimeSchema

export const AgentRuntimeSchema = z.discriminatedUnion("harness", [
  // ─── claude-code substrate (current default; v1 behaviour) ──────────
  z.object({
    harness: z.literal("claude-code"),
    mode: z.enum(["in-process"]).default("in-process"),
    capabilities: z.array(z.string().min(1)).default([]),
    // claude-code-specific knobs (all optional; all already in CCSessionOpts):
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    allowedDirs: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  // ─── bus-peer substrate (sage and future peers) ─────────────────────
  z.object({
    harness: z.literal("bus-peer"),
    mode: z.literal("standalone").default("standalone"),
    capabilities: z.array(z.string().min(1)).min(1),
    peer: z.object({
      inboundSubject: z.string().min(1),
      outboundSubject: z.string().min(1),
      timeoutMs: z.number().int().positive().default(300_000),
    }),
  }),
  // ─── future substrates (placeholder; each lands in its own PR) ──────
  // z.object({ harness: z.literal("openai-codex"), ... }),
  // z.object({ harness: z.literal("cursor"),       ... }),
  // z.object({ harness: z.literal("gemini"),       ... }),
  // z.object({ harness: z.literal("mistral"),      ... }),
  // z.object({ harness: z.literal("pi-dev"),       ... }),
]);
```

### 6.2 Backward-compat

`AgentSchema.runtime` stays optional. When an agent omits `runtime` entirely, cortex defaults to `{ harness: "claude-code", mode: "in-process", capabilities: [] }` — exactly the v1 behaviour. All existing inline `agents[]` in `cortex.yaml` keep working without edit.

Today's `substrate: "claude-code" | "codex" | "pi-dev" | "custom"` field becomes `harness:` (rename only — the closed enum drives a discriminated union now). A one-shot migration in `loader.ts` rewrites `substrate` to `harness` at parse time with a deprecation warning so operator configs don't break overnight. The warning carries until v2 cutover.

### 6.3 Fragment merge

Both inline `cortex.yaml` agents and `agents.d/<name>.yaml` fragments support `runtime`. Merge rules from `design-arc-agent-bots.md` §5 stay unchanged:

- Same `id` in two fragments → load-time error
- Same `id` inline + fragment → inline wins, fragment shadowed (operator override)
- `trust:` references that don't resolve → load-time error

This means `arc install github:the-metafactory/sage` drops a `sage.yaml` fragment with `runtime.harness: bus-peer`, cortex reloads, the dashboard shows Sage as a `bus-peer` agent, mentions route through `BusPeerHarness`. Zero operator config beyond the `arc install` line.

---

## 7. Migration Sequence (PR-by-PR)

Four PRs. A is foundation, B is the second substrate, C is the proof-out, D is the cleanup that finally severs cortex from `~/.claude/`.

### PR A — Foundation (no behaviour change)

**Lands:**
- `src/common/substrates/types.ts` — `SessionHarness`, `HarnessId`, `Capability`, `ToolCapability`, `DispatchRequest`, `ContextRef`
- `src/substrates/claude-code/harness.ts` — `ClaudeCodeHarness implements SessionHarness`
- `src/substrates/claude-code/event-translator.ts` — stream-json → MyelinEnvelope
- Moves: `src/runner/{cc-session,claude-invoker,stream-parser,security-preamble}.ts` → `src/substrates/claude-code/`
- Moves: `src/runner/hooks/*.hook.ts` → `src/substrates/claude-code/hooks/`
- `src/runner/cc-session.ts` becomes a re-export shim (deprecation comment, deletes in PR D)
- `src/runner/dispatch-listener.ts` reworked to consume `SessionHarness` instead of `CCSessionFactory`; the factory becomes a `HarnessFactory` that switches on `agent.runtime.harness` (only `claude-code` is wired in this PR, so behaviour is byte-identical)
- All existing `cc-session.test.ts` + `dispatch-listener.test.ts` pass unchanged

**Does not land:** `BusPeerHarness`, schema extensions for bus-peer, sage fragment.

**Behavioural delta:** zero. Same envelopes published, same CC sessions spawned, same logs.

**Test surface:**
- Unit: `harness.test.ts` against a fake CCSession factory
- Integration: existing dispatch-listener tests pass against the new factory plumbing
- Type-check: `AgentRuntimeSchema` discriminated union compiles + parses both shapes

### PR B — Bus-peer substrate

**Lands:**
- `src/substrates/bus-peer/harness.ts` — `BusPeerHarness implements SessionHarness`
- Schema extension: `AgentRuntimeSchema` discriminated union adds `bus-peer` variant (§6)
- `HarnessFactory` adds the bus-peer branch
- `__tests__/bus-peer-harness.test.ts` — tests against a fake NATS transport that mints reply envelopes on demand (no real sage process needed)
- Documentation: `agents.d/<name>.yaml` example fragment for a bus-peer agent (sage's exact shape)

**Behavioural delta:** still zero in production until an agent declares `runtime.harness: bus-peer`. Live test is a mock peer in CI.

**Test surface:**
- Unit: fake NATS transport, parameterised reply scenarios (immediate, streaming, timeout, error envelope)
- Integration: a local NATS instance + a fake peer subscriber that mimics sage's reply pattern

### PR C — Sage as a real bus-peer (end-to-end proof)

**Lands:**
- `~/.config/cortex/agents.d/sage.yaml` fragment installed on the v1 cutover host (this is operator-side config, not a cortex code change — it ships separately or via `arc install github:the-metafactory/sage`)
- Smoke test: `@sage review #cortex` in Discord → cortex dispatches via `BusPeerHarness` → sage's lens runs → verdict envelope returns → dashboard renders → completion lifecycle on the bus
- Possibly: a `cortex agents test <id>` CLI command that publishes a synthetic envelope and waits for the reply (useful for operator debugging — could land in B if cheap)

**Behavioural delta:** sage shows up as a first-class agent in `#cortex`. Mentions get reviewed.

**Risk:** sage's existing subscription pattern may not match the BusPeerHarness's exact subject layout — likely small adapter shim needed on sage's side (or, more likely, a small generalisation of BusPeerHarness's subject template).

### PR D — Cleanup (sever cortex from `~/.claude/`)

**Lands:**
- Move `src/taps/cc-events/cc-events.ts` → `src/substrates/claude-code/cc-events-tap.ts`
- Move `src/runner/hooks/` (already done in A) — verify nothing in cortex root still references it
- Delete `src/runner/cc-session.ts` re-export shim
- `pai-install.ts` becomes responsible for the `~/.claude/settings.json` registration block (today done by arc at install time)
- `${PAI_DIR}` env-var lookup moves under `src/substrates/claude-code/` (cortex#88 item 9)
- `src/common/types/cortex-config.ts`'s `paths.publishedEventsDir` default `"~/.claude/events/published"` becomes substrate-specific config — it's only meaningful for the claude-code harness, so the field moves into `runtime` for that variant
- Dashboard's `src/surface/mc/hooks/poller.ts` deleted (the harness publishes progress envelopes directly; the dashboard reads them from the bus)
- `grep -rn '\.claude\|PAI_DIR\|claude-code' src/` outside `src/substrates/claude-code/` returns zero hits (acceptance criterion from cortex#91)

**Behavioural delta:** none for end users. Cortex root is now harness-agnostic.

---

## 8. Open Questions to Surface

Each is narrow and answerable in 1-2 sentences. Marked `?` for Andreas to weigh in. Tagged **[blocks PR A]** or **[can wait]** so the implementation order is unambiguous.

**Q1 — Tool capability translation: who owns it?** `?`
CC uses `Bash,Edit,Write,Read,...`. Cursor has a different surface (rules + workspace permissions). Codex has its own. Does cortex carry a canonical capability vocabulary that each harness translates from, or does each harness declare its own native names and cortex passes through unchanged?
**Recommended:** harness owns its native names; cortex passes the union of `agent.runtime.allowedTools` (substrate-native strings) and skips translation. The `ToolCapability.allow: string[]` is intentionally a free string array.
**Tag:** [blocks PR A] — the interface shape depends on this.

**Q2 — Event-logging surface for non-CC child-process harnesses (Codex, Cursor, Gemini).** `?`
Today CC's hooks write JSONL to `~/.claude/events/raw/` which `src/taps/cc-events/` forwards to NATS. For `BusPeerHarness` this is moot (sage publishes directly). For future Codex/Cursor harnesses: do they need a similar hook surface (each substrate writes its own JSONL → tap → bus), or do we wrap their stdout/stderr in cortex and synthesise envelopes from process output?
**Recommended:** each harness chooses. CC keeps its hook surface (it's already there). Codex/Cursor wrap stdout via a generic `stdio-tap` helper. Decision per-harness.
**Tag:** [can wait] — affects PR D and any non-sage non-CC follow-up. Not blocking.

**Q3 — Multi-substrate persona portability.** `?`
`personas/luna.md` is markdown — the voice/role parts transfer. But CC uses skills + hooks; Cursor uses rules; Codex uses instructions. Where do substrate-specific persona blocks live?
**Recommended:** persona file stays platform-neutral (§9.3 of `architecture.md`). Substrate-specific add-ons live in `agents[].runtime` config (e.g. `runtime.skills: [...]` for CC, `runtime.rules: [...]` for Cursor).
**Tag:** [can wait] — only matters when we add the second substrate that has its own instruction surface (i.e. Cursor / Codex follow-ups).

**Q4 — Capability negotiation: validate at dispatch or pass through?** `?`
When cortex dispatches `tools: { allow: ["Bash", "Edit"] }` to a `bus-peer` harness whose substrate doesn't support `Edit`, does cortex reject at dispatch time (comparing `tools.allow` against `harness.capabilities`), or does cortex pass through and let the harness reject?
**Recommended:** harness rejects via an envelope (`status: "error"`, `reason: "unsupported tool: Edit"`). Cortex stays out of substrate-specific validation. Keeps cortex code path simple; surfaces the error end-to-end (visible in the dashboard the same way any other failure would be).
**Tag:** [can wait] — naive pass-through works for PR A + B. The validation question matters only when Codex/Cursor harnesses with tighter tool surfaces land.

**Q5 — Streaming progress envelope subject.** `?`
`ClaudeCodeHarness` will emit per-text-chunk progress envelopes (§4.2). Should those land on `dispatch.task.progress` (new subject), or `dispatch.task.streaming` (separate), or attach them to existing `dispatch.task.started`'s correlation chain via myelin's correlation_id without a new subject?
**Recommended:** new subject `dispatch.task.progress` under the existing `dispatch.task.*` taxonomy. Predictable, consistent with `started/completed/failed/aborted`, and the dashboard's existing subject-pattern subscription (cortex#86 subject-pattern primitive, just landed) picks it up for free.
**Tag:** [blocks PR A] — the translator yields these envelopes; the schema needs to be picked before the translator ships.

**Q6 — Inactivity-timeout vs wall-clock timeout uniformity.** `?`
Today `CCSessionOpts.timeoutMs` is **inactivity** (resets on every stream event). Today's sage subscription would naturally be **wall-clock** (no equivalent of "still typing" exists in a bus reply). Is `DispatchRequest.timeoutMs` inactivity or wall-clock? Or do we make the field per-harness?
**Recommended:** `DispatchRequest.timeoutMs` is wall-clock. CC's inactivity-timer behaviour is internal to `ClaudeCodeHarness` (it can keep using inactivity for its child-process semantics, but exposes a wall-clock outer timeout that defaults to e.g. 2×inactivity). Caller-visible contract is wall-clock.
**Tag:** [blocks PR A] — interface field semantics.

**Q7 — Harness lifecycle: singleton or per-dispatch?** `?`
Does cortex construct one `ClaudeCodeHarness` instance at startup (singleton, multiple `dispatch()` calls concurrent), or one harness per dispatch (factory per call)?
**Recommended:** singleton per `(harnessId, agentId)`. The harness owns substrate-level resources (the hook install for CC, the NATS subscription for bus-peer); per-dispatch construction would re-install hooks + re-subscribe, which is wasteful and racy. Concurrent `dispatch()` calls on one harness are independent (each gets its own iterable).
**Tag:** [blocks PR A] — drives the factory shape.

---

## 9. Risks + Tradeoffs

| | Risk / Tradeoff | Mitigation |
|---|---|---|
| 1 | **Time investment.** ~2-3 weeks of focused work for PR A+B+D (C is operator-side config). | Phased PRs each ship behaviour-neutral changes; rollback is `git revert`. PR A is the riskiest single change; if it doesn't pass the existing dispatch-listener test suite, it doesn't merge. |
| 2 | **Coupling debt is real but contained.** Only 3-4 files in cortex root know about CC (`dispatch-listener.ts`, `cc-events.ts`, `poller.ts`, config defaults). Everything else is already abstract. | The migration matrix in §7 names every file. Acceptance criterion in cortex#91 is `grep -rn '\.claude' src/` outside `substrates/claude-code/` returns empty — measurable. |
| 3 | **Schema-discriminator change is operator-facing.** `runtime.substrate` → `runtime.harness` rename touches operator YAML. | Loader does the rename at parse time with a one-cycle deprecation warning. Operator YAML keeps working through PR A + B; explicit rename can land in PR D or be left as a permanent backward-compat alias. |
| 4 | **Sage doesn't change but its install path does.** Today sage is operator-installed; the design assumes `arc install github:the-metafactory/sage` drops the fragment. | `arc install` for cortex agents is already designed in `design-arc-agent-bots.md` and the `CortexHostAdapter` is described there. If arc isn't ready, the fragment can be hand-dropped (it's just a YAML file). |
| 5 | **Streaming-progress envelopes are new traffic on the bus.** Even for short tasks, CC emits 5-20 events. That's 5-20 extra envelopes per dispatch. | The dashboard already subscribes to `local.{org}.>` and filters; the extra envelopes are O(tokens) and well within NATS's headroom. If it becomes a problem, the harness can debounce or batch — but that's optimisation, not architecture. |
| 6 | **AbortSignal plumbing must reach the harness.** The surface-router's per-render timeout signal needs to abort the harness's iterable. | The iterable contract supports this naturally (`for await` with a `throw on cancel`); the harness implementation must wire `signal.aborted` to `cc-session.kill()` (CC) or `subscription.unsubscribe()` (bus-peer). Tested in PR A. |

---

## 10. References

- **cortex#91** — this issue. The design doc closes the "design-step" checkbox; implementation lands in PRs A/B/C/D.
- **cortex#70** — Cursor as a runtime substrate. Downstream consumer of this design; lands after PR B.
- **cortex#58** — F-2 substrate harness + dispatch mode schema seam. The `AgentSchema.runtime` field already exists; §6 extends it.
- **cortex#88 item 9** — `${PAI_DIR}` decoupling. PR D resolves this in passing.
- **cortex#86** — subject-pattern subscription primitive. The streaming-progress envelopes (Q5) use this for dashboard pickup.
- **`the-metafactory/sage`** — first non-CC substrate; reference implementation of the bus-peer pattern. `BusPeerHarness` is the cortex-side handle for what sage already does.
- **`docs/architecture.md` §9** — agent + presence + renderer model. Persona is platform-neutral (§9.3); this design preserves that.
- **`docs/design-arc-agent-bots.md`** — predecessor. Substrate-pluggable bot packaging via arc, `agents.d/` fragments, install lifecycle, multi-backend `HostAdapter` (arc#117). The substrate field on agents was introduced there; this design fleshes out the substrate runtime contract.
- **`docs/design-pi-dev-review-agent.md`** — separates substrate from presence; the conceptual foundation that sage incarnates. Influences the `BusPeerHarness` shape directly.
- **`docs/plan-cortex-migration.md`** — v1 cutover plan. Just completed. This design is the natural next step (decouple from PAI).
- **`myelin/src/transport/types.ts`** — `TransportPublisher` / `TransportSubscriber` interfaces. `SessionHarness.dispatch()` mirrors `subscribe()`'s return type (`AsyncIterable<Envelope>`).
- **`src/runner/dispatch-listener.ts`** — consumer of the harness in PR A. Today imports `CCSession` directly; after A it accepts a `HarnessFactory`.

---

## Appendix A — Worked example: dispatching to Luna (claude-code) and Sage (bus-peer) from the same `#cortex` channel

Operator types `@luna refactor this function` and `@sage review #45` in `#cortex`. Both hit the Discord adapter, both produce `dispatch.task.received` envelopes with different `agent_id`. The dispatcher:

1. Looks up agent by `agent_id` in the registry → reads `runtime.harness`
2. Calls `HarnessFactory.for(harnessId, agentId)` → returns the appropriate singleton
3. Awaits `for await (const env of harness.dispatch(req)) { publish(env) }`

For Luna: `ClaudeCodeHarness` spawns `claude --print --output-format stream-json --allowedTools Edit,Read,Write`. Stream-json events translate to envelopes; the dashboard renders streaming text in the Luna card.

For Sage: `BusPeerHarness` publishes `local.metafactory.tasks.@did-mf-sage.review.<uuid>` carrying the PR ref. Subscribes to `local.metafactory.code.pr.review.>` filtered by `correlation_id`. Sage's bridge picks up the inbound, runs the workflow, posts the verdict via `gh`, publishes the verdict envelope. The harness yields it, plus the `dispatch.task.completed` terminal envelope. Dashboard renders the verdict in the Sage card.

Same dispatcher code path. Different harnesses. Same envelope shape on the bus.

---

## Appendix B — What this design intentionally does not specify

- **Capability registry semantics** (NATS KV — sage Phase 2). Out of scope; the design accepts whatever capability format the registry mints. Harnesses declare `capabilities: Capability[]` on the contract; the registry is a separate routing concern.
- **Multi-tenant org isolation.** The `local.{org}.` subject prefix is taken from G-1111 and used as-is. Cross-org dispatch (a cortex deployment dispatching to a sage in a different org) is a network-level concern (myelin federation) and out of scope.
- **Persona inheritance / role-resolver semantics.** Unchanged from `design-arc-agent-bots.md` §4 + `docs/architecture.md` §9. Personas remain platform-neutral; roles resolve to capability bundles; the dispatcher composes `ToolCapability` from the role bundle. The harness sees only the resolved `ToolCapability`.
- **Failure-mode taxonomy beyond `complete | error | timeout`.** The terminal envelope's status is one of those three. Finer failure detail (auth error, rate limit, substrate crash) lives in the envelope's payload, not as a top-level status. Consumers that care can parse the payload.
- **Cost / usage accounting.** CC's `usage` block (already on `CCSessionResult`) becomes a progress envelope. Sage's pi.dev usage is similar. A unified `dispatch.task.usage` envelope is a separate follow-up — not required for the harness contract.
