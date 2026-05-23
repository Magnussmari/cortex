# Plan — Direction A Implementation

**Status:** Active campaign. Tracks the cortex#405 umbrella from design (PR #414) through Stage 7 cutover.
**Date opened:** 2026-05-23
**Driver:** Andreas (orchestrator); main session drives stage-by-stage; pilot-loop drives per-PR review.

**Refs:**
- `docs/design-platform-adapter-dispatch-publishing.md` — the design spec
- `docs/design-myelin-osi-scenarios.md` — OSI scenarios, framing corrections, locked answers
- `docs/design-internet-of-agentic-work.md` + `docs/plan-internet-of-agentic-work.md` — federation baseline
- `docs/plan-cortex-migration.md` — phase migration plan (MIG-0..MIG-8) that contains MIG-3b adapter port
- cortex#405 umbrella; #406–#412 stage sub-issues; #413 channel-topology; #414 design corrections PR; myelin#180 enum rename

---

## TL;DR

Direction A is locked at the design layer. Three implementation tracks bring the domain to life:

- **Track 1 — Direction A migration**: 1 keystone (MIG-3b adapter port) + 7 stages (#406–#412). Critical path to "cortex on the bus for all platform dispatches".
- **Track 2 — IoAW federation**: Phase D (single-network) → Phase E (#117 multi-network). Critical path to "cross-principal collaboration on the bus" (Scenario 4 model B + Scenario 5 cross-principal).
- **Track 3 — Boundary / UX cleanup**: myelin#180 (enum rename), cortex#413 (channel-topology config). Independent; cortex maps at boundaries until they land.

This plan focuses on **Track 1** end-to-end. Tracks 2 and 3 progress independently; this doc names their interaction points but does not own them.

---

## §1 — The three tracks

### Track 1 — Direction A migration (cortex#405)

```
PR #414 (design corrections) ─── JC review ─── merge ─┐
                                                       │
   feat/c-104-adapters-surface ───────────────────────┤
   (MIG-3b — adapter port from grove-v2, KEYSTONE)    │
                                                       ▼
              ┌──────────────────────────────────────────────┐
              │ Stage 1 (#406) — agent identity flip         │
              └────────────────────┬─────────────────────────┘
                                   │
              ┌────────────────────┴─────────────────────────┐
              │ (parallel)                                   │
              ▼                                              ▼
   Stage 2 (#407)                              Stage 3 skeleton (TDD)
   • myelin chat capability                    • test suite + interface stub
   • encodeDidSegment wiring                   for EnvelopePublishingAdapterBase
                                                              │
                                                              ▼
                            ┌──────────────────────────────────────────────┐
                            │ Stage 3 (#408)                               │
                            │ • EnvelopePublishingAdapterBase              │
                            │ • AgentTeamHarness (HarnessId='agent-team')  │
                            └────────────────────┬─────────────────────────┘
                                                 ▼
                            ┌──────────────────────────────────────────────┐
                            │ Stage 4 (#409) — Discord envelope mode       │
                            │ • model A default                            │
                            │ • model B opt-in per #413                    │
                            └────────────────────┬─────────────────────────┘
                                                 ▼
                            ┌──────────────────────────────────────────────┐
                            │ Stage 5 (#410) — Discord dispatch sink       │
                            │ • routed-sink filter by response_routing     │
                            └────────────────────┬─────────────────────────┘
                                                 ▼
                            ┌──────────────────────────────────────────────┐
                            │ Stage 6 (#411) — Mattermost + Slack flip     │
                            │ • feature flag widens, then removes          │
                            └────────────────────┬─────────────────────────┘
                                                 ▼
                            ┌──────────────────────────────────────────────┐
                            │ Stage 7 (#412) — cutover                     │
                            │ • delete dispatch-handler.ts                 │
                            │ • remove legacy dispatch.task.received       │
                            │   subscription                                │
                            │ • flip IAW Phase D integration test          │
                            │ • update docs/architecture.md + CONTEXT.md   │
                            └──────────────────────────────────────────────┘
                                                 │
                                                 ▼
                                       cortex#405 closes
```

### Track 2 — IoAW federation (cortex#110)

Phases A–E. Phase E (#117) delivers multi-network bridges + the delegation pattern. Until Phase E is operationally available between two principal pairs, cross-principal traffic for that pair falls back to model A (Discord-as-bridge — Scenario 4) and Scenario 5 (bot-to-bot direct chat) cannot reach the peer principal.

**Track 1 / Track 2 interaction:**
- Stage 4 (#409) ships **model A default** — works without Track 2 progress.
- Stage 4 **model B opt-in** requires Phase E + #413 (channel-topology config).
- Scenario 5 (bot-to-bot direct chat across principals) requires Phase E.

Track 2 is **not driven by this plan**. The IoAW plan doc (`docs/plan-internet-of-agentic-work.md`) owns it.

### Track 3 — Boundary / UX cleanup

- **myelin#180** — `DistributionMode 'broadcast' → 'offer'` rename. cortex wraps at the boundary; not blocking Track 1. Backward-compat path recommended in the issue.
- **cortex#413** — Channel-topology config for Scenario 4 model B. Four candidate mechanisms; needs Andreas's decision before Stage 4 model B ships. Stage 4 model A doesn't need it.

Track 3 progresses independently; Track 1 stages do not block on it (model A path always available).

---

## §2 — Track 1 critical path

| # | Step | Owner | Blocker | Status |
|---|------|-------|---------|--------|
| 0a | PR #414 (design corrections) | Andreas → JC review | JC review | OPEN |
| 0b | MIG-3b adapter port — open PR | Main session | MIG-3b branch readiness | NOT OPEN |
| 0c | MIG-3b — review + merge | Main session orchestrates; pilot-loop drives | Reviews | NOT MERGED |
| 1 | Stage 1 (#406) — agent identity flip | Main session | MIG-3b merged | BLOCKED |
| 2 | Stage 2 (#407) — myelin chat capability + spec wiring | Main session | None (parallel-ready) | UNBLOCKED |
| 3 | Stage 3 (#408) — base class + AgentTeamHarness | Main session | Stages 1 + 2 | BLOCKED |
| 4 | Stage 4 (#409) — Discord envelope mode (model A) | Main session | Stage 3 | BLOCKED |
| 5 | Stage 5 (#410) — Discord dispatch sink | Main session | Stage 4 | BLOCKED |
| 6 | Stage 6 (#411) — Mattermost + Slack flip | Main session | Stage 5 | BLOCKED |
| 7 | Stage 7 (#412) — cutover + cleanup | Main session | Stage 6 | BLOCKED |

**Two things are unblocked today:**
- Opening MIG-3b PR (0b)
- Stage 2 (#407) myelin-side capability extension

Everything else cascades from MIG-3b merging.

---

## §3 — Implementation SOP per stage

Each stage follows the same procedural pattern. Documented here so the main session and any future driver hits the same shape.

### 3.1 Per-stage workflow

```
1. Read the stage's sub-issue body (#406–#412) for current scope + acceptance.
2. Worktree:
     git worktree add ../cortex-stage{N}-{slug} -b feat/c-{N}-{slug} origin/main
3. Implement against the acceptance criteria.
4. Push branch; open PR with body:
     - cite umbrella #405 + stage sub-issue (Closes #4xx)
     - reference design doc sections that govern this stage
     - acceptance checklist (copied from issue + ticked as completed)
5. Invoke pilot-review-loop skill (§3.2).
6. Orchestrate from main session:
     - Read Luna's findings
     - Fix small in-place; defer big to follow-up issues
     - Re-push; re-trigger review
     - Repeat until Luna approves
7. Merge (squash). Sub-issue auto-closes.
8. Tick the stage's row in §2 above.
9. Update blueprint.yaml status if applicable.
10. Move to next stage.
```

### 3.2 Pilot-loop skill invocation

```
Skill: pilot-review-loop
Args:
  - PR number
  - Reviewer: Luna (AI reviewer)
  - Loop body:
      → pilot ping Luna with PR context
      → ScheduleWakeup polling for review return
      → fix-small / defer-big classification
      → re-push if any fixes
      → re-ping Luna
      → exit on approval + merge
```

Pilot-loop runs **per PR** with a fresh context window. The main session is the orchestrator and does NOT enter the loop — it spawns the loop, monitors via TaskGet/Monitor or notification, and moves to the next stage when the loop reports success.

### 3.3 Escalations from pilot-loop to main session

The main session interrupts the loop only on:
- A review finding that requires a design decision (not a code fix). Surface to Andreas.
- A merge conflict that can't be auto-rebased. Surface to Andreas.
- A test failure that can't be reproduced locally. Investigate before continuing.
- 3+ review rounds without progress. Surface to Andreas — something's wrong with the stage scope.

Everything else: pilot-loop fixes and re-pushes autonomously.

---

## §4 — Current state map

### What's done

- Design layer: `docs/design-platform-adapter-dispatch-publishing.md` + `docs/design-myelin-osi-scenarios.md` + `CONTEXT.md` corrections (PR #414, awaiting review)
- Sub-issues #406–#412 with updated bodies (C-405 corrections applied 2026-05-23)
- Track 3 issues filed: myelin#180, cortex#413
- This plan doc

### In-flight

- PR #414 — design corrections; awaiting JC review
- `feat/c-104-adapters-surface` — MIG-3b adapter port; 7 commits ahead of main; no PR open yet
- Track 2 IoAW phases — owned by `docs/plan-internet-of-agentic-work.md`

### Not started

- MIG-3b PR opening
- Stages 1–7 implementation
- Stage 2 (#407) myelin chat capability — UNBLOCKED but not started
- cortex#413 design — channel-topology config mechanism (needs Andreas decision on 4 options)
- IoAW Phase D status — tracking issue location unclear (#132 is the wrong issue; needs locating)

### Blocked

- Stages 1, 3–7: blocked on MIG-3b merge
- Stage 4 model B opt-in: blocked on Track 2 Phase E + #413
- Scenario 5 cross-principal: blocked on Track 2 Phase E

---

## §5 — Risk + open seams

### Risk 1 — MIG-3b is bigger than a normal stage PR

The branch is +2229 / -104,798 across 457 files (mostly legacy deletion). Review effort is substantial. Mitigation:
- Open with a clear review checklist segmenting the diff (port vs deletion vs new test).
- Tag JC + Luna; consider also Echo for an independent read.
- Be prepared for multiple review rounds — 3+ is plausible.
- Worst case: split the branch into smaller follow-up PRs if review can't converge.

### Risk 2 — Stage 2 myelin work needs myelin maintainer attention

cortex IS the myelin team, but adding `chat` to seed taxonomy touches the namespace spec + schema. A small but real myelin-side PR. Mitigation:
- Land the myelin PR early (parallel to MIG-3b) so cortex code can consume the new capability when Stage 4 ships.

### Risk 3 — cortex#413 channel-topology decision blocks Stage 4 model B

Stage 4 model A can ship without this; model B opt-in cannot. Mitigation:
- Pursue the decision in parallel (4 options on table; pick A/B/C/D when Andreas is ready).
- Worst case: ship Stage 4 with model A only; file model B opt-in as a Stage 4.5 follow-up.

### Risk 4 — IoAW Phase D status unknown

`design-internet-of-agentic-work.md` says Phase D = single-network federation; entry criterion for Phase E (#117). The actual tracking issue isn't yet located. Mitigation:
- Audit issue tracker for IAW Phase D; if it doesn't exist as a real issue, file it.
- Track 1 doesn't strictly depend on Phase D for Stage 4 model A path. But Direction A's full benefit requires Track 2 progress.

### Risk 5 — Pilot-loop on long-running PRs

MIG-3b is large; pilot-loop polling intervals + ScheduleWakeup cadence may need tuning. Mitigation:
- Start with default cadence; adjust if it burns cache too fast or wakes too slowly.
- Escalate to Andreas if the loop runs >24h on a single PR without convergence.

---

## §6 — Operating notes for the autonomous loop

The main session is the **orchestrator**, not the implementer in the strict sense. It:

1. Opens PRs (worktree → branch → push → `gh pr create`)
2. Spawns `pilot-review-loop` for each PR (fresh context, runs in background)
3. Receives notifications when a loop completes or escalates
4. Moves to the next stage on success
5. Surfaces to Andreas on escalations per §3.3

The main session does NOT:
- Drive every review fix itself (that's the loop's job)
- Block on long reviews (uses ScheduleWakeup with reasonable cadence)
- Make design decisions autonomously (those escalate to Andreas)
- Open issues that the user already filed (checks first per repo CLAUDE.md)

**Cadence guidance:** For long-running PR reviews, use ScheduleWakeup with 1200s–1800s polling (cache-friendly per system guidance) until review returns; tighter cadence (270s) only when actively waiting on a sub-minute external state change.

**Cross-track interaction:** This plan owns Track 1. If Track 2 or Track 3 produce findings that affect Track 1 scope (e.g. IoAW Phase E ships and Stage 4 model B becomes shippable), update §2 and §4 of this plan; do not silently re-scope sub-issues without updating both the plan and the issue body.

---

## §7 — Done definition

Track 1 is done when:
- All 7 stages (#406–#412) closed via merged PRs
- cortex#405 umbrella closed
- `git grep "dispatch.task.received"` returns zero hits in `src/`
- `git grep "BotConfig.agent.(discord|mattermost|slack)"` returns zero hits in `src/`
- Production cortex deploy stable on envelope mode for all three platforms (1+ release cycle)
- `docs/architecture.md` reflects the post-Direction-A state
- `CONTEXT.md` "Legacy" callout on Dispatch entry removed (Stage 7 work)
- Release notes call out the wire-grammar change for any external bus subscriber

Cross-principal Direct/Delegate (model B opt-in) and bot-to-bot direct chat (Scenario 5) become operational when Track 2 Phase E + Track 3 #413 land — those are separate done-definitions outside Track 1.
