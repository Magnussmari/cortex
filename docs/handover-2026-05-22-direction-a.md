# Handover — Direction A platform-adapter dispatch publishing

**Date:** 2026-05-22
**From:** Jens-Christian (EU, end of day)
**To:** Andreas (and/or Luna — whichever timezone picks this up next)
**Status:** Pending your decision on the OSI corrections before Direction A migration can move past Stage 0.
**Channel for ack:** #handover

---

## TL;DR

I ran the `/improve-codebase-architecture` skill against cortex, picked the dispatch-handler ↔ dispatch-listener seam, and grilled it into **Direction A**: platform adapters become dispatch sources publishing inbound dispatch envelopes; the existing listener handles all paths; `dispatch-handler.ts` retires.

You then pushed back on the Q2 split (cortex vs myelin grammar ownership) via the OSI layer model. I wrote a pressure-test doc with three scenario diagrams, surfaced **two corrections** to the original direction, and posted to #myelin.

**You now hold three decisions. Each unblocks a different chunk of work.** See §3.

---

## 1. What was done

| Artefact | Status | Link |
|---|---|---|
| Direction A design doc | committed | [`docs/design-platform-adapter-dispatch-publishing.md`](./design-platform-adapter-dispatch-publishing.md) |
| OSI scenarios + corrections | committed | [`docs/design-myelin-osi-scenarios.md`](./design-myelin-osi-scenarios.md) |
| CONTEXT.md vocab additions | committed | substrate harness / dispatch source / dispatch sink / response routing |
| Q5b follow-up (policy-engine sole authority) | filed | [cortex#403](https://github.com/the-metafactory/cortex/issues/403) |
| Q4b follow-up (federated CAS) | filed | [cortex#404](https://github.com/the-metafactory/cortex/issues/404) |
| Direction A umbrella | filed | [cortex#405](https://github.com/the-metafactory/cortex/issues/405) |
| Stage 1–7 sub-issues | filed + linked to #405 | [#406](https://github.com/the-metafactory/cortex/issues/406)…[#412](https://github.com/the-metafactory/cortex/issues/412) |
| Discord ping for Q2 | posted | #myelin |
| OSI doc + corrections to Q1a/Q2 | posted | #myelin |

Two commits on `origin/main`:
- `523556d docs(cortex): Direction A platform-adapter dispatch publishing — design + vocab`
- `78517e3 docs(cortex): myelin OSI layer model — dispatch scenarios + Direction A corrections`

No code touched. All work is decision-doc + tracking-issue layer.

---

## 2. What the OSI exercise revealed

Original Direction A had two pinned decisions that **don't match myelin's existing spec**:

### Correction A — Wire grammar for Direct mode

| | Original Direction A | Corrected per myelin `specs/namespace.md` §Tasks Domain |
|---|---|---|
| Direct inbound subject | `local.{p}.{s}.dispatch.task.received` | `local.{p}.{s}.tasks.@{did-encoded-assistant}.{capability}` |
| Offer inbound subject | `local.{p}.{s}.tasks.{capability}.{subcapability}` | unchanged — already correct |
| `dispatch.task.{action}` | inbound + lifecycle (cortex code today) | **lifecycle observability only** — cortex M7 vocabulary |

Cortex's current `dispatch.task.received` subscription in `runner/dispatch-listener.ts` is **pre-spec**. Direction A should publish onto canonical `tasks.@{did-encoded-assistant}.{capability}` and the listener should subscribe to `tasks.>`.

### Correction B — Signing model

| | Original Direction A (Q1a) | Corrected per myelin#160 + your channel post |
|---|---|---|
| Who signs | adapter, using hosted agent's NKey | **stack**, via `runtime.publish`, using stack NKey |
| Adapter's role | holds agent NKey, signs as agent | **populates `originator.identity` with resolved human/agent DID** + `attribution = "adapter-resolved"` |
| Policy lookup | uses `signed_by[0].identity` | uses `originator.identity` (falls back to signed_by for peer-to-peer per `getActorPrincipal`) |

Cryptographic signer (stack) and policy actor (originator) are now cleanly separated — both attestable, both inside the signature.

### Implications

- Stage 2 of the umbrella becomes "implement against existing myelin spec" — no spec change request.
- Stage 3's `EnvelopePublishingAdapterBase` builds `tasks.@{did-encoded-assistant}.{capability}` subjects via `encodeDidSegment` helper; populates `originator.identity`; hands to `runtime.publish` for stack-signing.
- CONTEXT.md's Dispatch entry inbound-subject table is wrong — needs correction.
- The original design doc §5 + §6 + §7 need same correction. Sub-issues #406 (Stage 1) and #408 (Stage 3) carry stale descriptions.

---

## 3. Decisions waiting on you

### Decision 1 — Accept the OSI corrections and proceed?

Read [`docs/design-myelin-osi-scenarios.md`](./design-myelin-osi-scenarios.md) (296 lines, 3 Mermaid diagrams). Either:

- **Accept** — the corrected wire grammar + signing model are right; Direction A can proceed with corrections applied.
- **Push back further** — something in the OSI framing is still off; we re-grill before moving.
- **Defer** — wait for Luna's read; revisit when she weighs in.

### Decision 2 — Which of the 4 open questions in §10 to resolve now?

1. Is cortex's existing `dispatch.task.received` listener legacy pre-spec, or load-bearing?
2. Capability token for free-form chat — needs a `chat` extension to myelin's seed taxonomy. Cortex-side rename or myelin-side seed-update?
3. `originator.attribution` enum values — `"adapter-resolved"` is documented. Others? `"self"` / `"delegated"` / `"forwarded"`?
4. Direct vs Delegate at the wire — same subject shape per spec; mode bit in payload or sovereignty block? Affects whether listener routes to AgentTeamHarness via subject filter or must inspect payload.

Each can be answered standalone or batched. Q2 + Q4 are myelin-touching; Q1 + Q3 are cortex-only.

### Decision 3 — How to apply the corrections

| Path | Effort | Reversibility |
|---|---|---|
| **A. Update artefacts in-place** | edit CONTEXT.md + design doc + 7 sub-issue bodies; one commit | reversible — single revert |
| **B. Supersede with a follow-up doc** | leave existing docs; new "Direction A corrections applied" doc that points to OSI scenarios | reversible — preserves history of how we got here |
| **C. Hold all corrections until Decision 1 lands** | no further commits; commit only after you accept the OSI framing | safest — no rework if you push back again |

Recommendation: **C** — wait for your reply on Decision 1 before touching anything else. Two days of Direction A docs is enough; let the corrections land in one batch.

---

## 4. How to proceed

### If you have ~5 minutes

Reply in #handover with **decision 1 verdict only**. I (or Luna, or next-day me) will apply or hold accordingly.

### If you have ~15 minutes

Read the OSI scenarios doc (Mermaid renders on GitHub; mobile-friendly). Reply in #handover with:
- Decision 1: accept / push back / defer
- Decision 2: which of the 4 §10 questions you want pinned now
- Decision 3: A / B / C

### If you have ~30 minutes

The above + scan `docs/design-platform-adapter-dispatch-publishing.md` §7 (migration sequence) — confirm Stages 1–7 are the right slicing for Direction A, or propose a different breakdown.

### If you're handing back to me

Reply in #handover with whatever's resolved + ping `@jcfischer` so I see it on next session start.

---

## 5. Memory landmarks

- Branch: `main` (all work committed + pushed on main, no feature branch)
- Repo state: `origin/main` at `78517e3`
- Working tree: clean (excluding untracked `.claude/`)
- Open conversation thread: #myelin (Q2 ping at 09:21, correction at 09:42, OSI doc post just after handover write)
- Last Discord message: this handover post (will land moments after the doc commit)
- No PRs open from this work
- No code touched
