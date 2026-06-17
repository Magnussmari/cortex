# Roster-driven federation auto-wiring — registry roster → accept-list + presence subscription

Status: **draft** (2026-06-17)
Owner: cortex
Related: ADR-0001 (federated subject grammar), ADR-0003 (network-join control plane), ADR-0006 (hosted network-view feed), ADR-0007 (agent-presence protocol); G-1114 Phase E; signal#116 (transport roster); the #1082 local-pane fix.

## 1. Problem

A principal whose stack is a member of a network cannot see the other stacks /
principals / assistants on that network in Mission Control — even when the leaf
link is up and the peer is a known member.

Live evidence (`cortex network status --principal andreas`):

```
metafactory  [leaf:mf-hub]  link:established
  peers:    jc
  accept:   federated.andreas.meta-factory.>
  max_hop:  1
  counters: in=0 out=0
```

`jc` is a resolved peer and the leaf is connected, yet `in=0` and jc's
assistants never render. The Network view has the UI for foreign hubs
(`classifyOrigin → foreign`, "federated stack" rendering), the bus has the
trust-verified federated presence subscriber, and the registry has the roster —
but nothing turns *"jc is a member"* into *"accept `federated.jc.*` + subscribe +
render."*

## 2. Root cause — the accept-list is self-only and one-shot

`cortex network join` (`src/cli/cortex/commands/network-lib.ts:289-327`) resolves
the registry roster into `peers[]` **but** writes the accept-list as the OWN
subject only:

```ts
const resolvedPeers = buildPeers(stack.principalId, roster);     // ← peers resolved
const acceptSubject = `federated.${stack.principalId}.${stack.stackSlug}.>`;  // ← OWN only
const entry = { id, leaf_node, peers, accept_subjects: [acceptSubject], deny_subjects: [] };
```

Two defects fall out:

1. **Self-only accept-list.** The peers are recorded in `peers[]`, but their
   subtrees (`federated.{peer.principal}.{peer.stack}.>`) are never added to
   `accept_subjects`. The federation gate (`evaluateFederationGate`, read by the
   federated presence subscriber and the surface-router) therefore admits only
   the stack's own echo — inbound `federated.jc.*` is gated out (`in=0`).
2. **One-shot at join.** The roster is resolved once, at `network join`. A peer
   that joins the network *after* (the common case — jc announced into
   `metafactory` later) never lands on the accept-list; there is no reconcile.

Compounding: the producer-side federation dual-emit (`federate`) defaults OFF
(G-1114.E.1), so even the outbound side is dark unless opted in.

## 3. What already exists (reuse — do NOT rebuild)

This is a **wiring** feature. Almost every part is built:

| Capability | Where | State |
|---|---|---|
| Registry roster read (`/networks/{id}/roster` → peers, cached-descriptor DD-10 fallback) | `network-lib.ts` / `network-adapters.ts` | ✅ in cortex's `network` control plane |
| `RegistryIntentSource` seam (network → `{principal}/{stack}` peers) | **signal** `src/lib/transport-observability/registry-intent.ts` | ✅ file/static; the cortex-registry impl is the documented drop-in |
| Intent⋈reality reconciliation → `connected` / `registered-absent` ("the JC case") / `unregistered-present` | **signal** transport-roster + reconciler | ✅ signal#116 |
| `roster_snapshot` / `liveness_drift` projection on `system.transport.*` | **signal** collector | ✅ |
| cortex folds peers' `system.transport.*` (U3.3 federated-observability fold) + renders a **transport verdict badge** on Network hubs (U2.3) | `cortex.ts` `startFederatedObservabilityFold`, `network-nodes.tsx` `verdictBadge` | ✅ |
| Trust-verified **federated presence subscriber** — accept-list gate + chain-verify + signing-posture-aware fold into the registry, tagged foreign | `bus/agent-network/federated-subscriber.ts` (G-1114.E.2/E.5) | ✅ built, **inert until opted in** |
| Foreign-hub **UI** (3-way `classifyOrigin`, "federated stack", detail panel) | `dashboard-v2` | ✅ (#1060/#1070) |

**The boundary with signal is clean and already drawn:** signal owns
*roster⋈liveness as observability* (who SHOULD be on the net ⋈ whose leaf IS
connected → verdicts), projected on the bus and already consumed by cortex.
cortex owns *collaboration* — turning the same roster into an accept-list +
presence subscription so peers' **assistants** (not just transport verdicts)
render. We do **not** duplicate signal's reconciliation; we consume the roster
(same source) and, optionally, signal's liveness verdicts.

## 4. Signal is optional — cortex's simple status stands alone

**Signal is not always installed. Cortex must give a useful Network view out of
the box, with signal as an additive deep-observability layer — never a hard
dependency.** This already holds at the code level (verified 2026-06-17): cortex
has **zero** code dependency on signal (no import — the only `signal` matches in
the tree are undici's `AbortSignal`); signal's contribution arrives **bus-only**
(`system.transport.*`), is rendered **absent-safe**
(`transportVerdict !== undefined ? badge : null`, `network-nodes.tsx:92`), and is
gated behind an **opt-in overlay**.

The two layers are distinct, not redundant — they answer different questions:

| Layer | Answers | Source | Without it |
|---|---|---|---|
| **cortex presence** (ADR-0007, ~L7) | "is the agent PROCESS up + heartbeating?" — online/idle/offline, 5-min-TTL liveness FSM | cortex's own `agent.{online,heartbeat,offline}` + in-memory registry | — this IS the baseline |
| **signal transport** (P-13/P-14, ~L0/L1) | "is the LEAF actually connected to the network, and does it match the registry roster?" — connected / registered-absent / unregistered-present + RTT | signal `system.transport.*`, folded by cortex, badged on hubs | overlay simply absent |

A cortex agent can be heartbeating (cortex says **online**) on a stack whose leaf
has actually dropped (signal says **registered-absent**) — signal catches a
transport-reality discrepancy cortex's own presence cannot see. **Standalone
cortex = "my agents are up"; cortex + signal = "…and the network plumbing matches
the roster."**

This principle **constrains the auto-wiring below**: the reconciler reads the
roster via cortex's OWN registry client and renders peers from cortex's OWN
federated presence; signal, when present, only *enriches* with the transport
verdict. The feature must work with signal **not installed**.

## 5. The missing wire — a roster→federation reconciler

A single new component (cortex-side): the **federation roster reconciler**. For
each network the stack is a member of:

1. **Resolve** the registry roster via **cortex's OWN registry client**
   (`network-lib.ts` already resolves `network.meta-factory.ai`) — **no import
   from signal**. signal independently reads the same registry behind its
   `RegistryIntentSource` seam; the dependency direction is cortex→registry and
   signal→registry, never cortex→signal (a shared *registry*, not a shared
   *package*).
2. **Derive** the desired federation policy:
   - `accept_subjects` = OWN subject **∪** `federated.{peer.principal}.{peer.stack}.>`
     for every roster member (this is the fix for defect #1).
   - `peers[]` = the resolved roster peers (as today, registry = source of truth, DD-5).
3. **Apply** it to the live federation policy + (re)subscribe the federated
   presence subscriber to the new accept-listed subtrees. The subscriber's
   existing trust gate is unchanged: accept-list + chain-verify under `enforce`,
   accept-list-only under `off` (its documented posture ladder).
4. **Reconcile continuously** — re-run on a refresh interval and/or a roster-change
   signal, not just at `join` (the fix for defect #2). Preserve the #762
   "never clobber a hand-pin with 0 resolved peers" guard.
5. **Compose with signal's liveness — OPTIONAL enrichment, never required.**
   Baseline: foreign peers render from cortex's OWN federated `agent.*` presence
   (works with signal absent). WHEN signal is present, ALSO key the hub's
   transport badge off its already-folded `roster_snapshot`/`liveness_drift`
   verdict — a `registered-absent` peer (registered, no live leaf) renders muted
   rather than stale-online; an `unregistered-present` leaf is surfaced as an
   anomaly. Absent signal → no badge, peers still render. Never a hard dependency
   (§4).

Everything downstream (chain-verify, fold-into-registry, foreign-hub render) is
the existing path.

## 6. Trust & privacy invariants (unchanged, must hold)

- **Metadata only** — presence + dispatch-lifecycle; interiors never federate
  (ADR-0005/0007). The auto-wiring only widens *presence* acceptance; it must not
  open any interior subtree.
- **Registry is the authority, the wire is data** — membership comes from the
  roster (ADR-0003), never inferred from an arriving subject (a subject is
  provenance, not proof; ADR-0007 §2). The reconciler only accept-lists peers the
  **roster** names.
- **Chain-verify under enforce** — accept-listing a peer does NOT bypass
  `verifySignedByChain` / `resolveFederatedPeer`. A `payload.scope` that disagrees
  with the chain-verified source is still rejected.
- **Opt-in posture preserved** — federation stays opt-in at the trust-posture
  level; this feature automates the *roster→accept-list* step, not the decision to
  federate. (Whether enabling the reconciler is itself a per-network opt-in is
  Open Question 1.)
- **Signal-optional (cortex stands alone)** — the feature reads the roster via
  cortex's own registry client and renders peers from cortex's own federated
  presence. Signal is additive (the transport verdict badge), bus-only, absent-
  safe. No code dependency on signal; the Network view federates with signal not
  installed (§4).

## 7. Phasing & dependency order

- **P1 — registry-roster read (cortex-owned).** Harden cortex's OWN registry
  roster read (`network-lib.ts`) into the reconciler's input. **No signal import.**
  signal reads the same registry independently behind its own `RegistryIntentSource`
  seam — shared *registry*, not shared *package*. (cortex never depends on signal;
  if anything, signal's cortex-registry source depends on the registry cortex
  already calls.)
- **P2 — accept-list derivation fix.** `network join` (and the reconciler) derive
  `accept_subjects` from the roster (OWN ∪ peer subtrees), not OWN-only. Smallest
  correctness fix; makes a *manual* `network join` actually admit peers. **No
  signal needed.**
- **P3 — continuous reconciler + subscription follow.** The refresh loop +
  (re)subscribe; preserve hand-pin guard. **No signal needed** (peers render from
  cortex's own federated presence).
- **P4 — liveness enrichment (signal-OPTIONAL).** WHEN signal is present, key the
  hub transport badge off its folded `roster_snapshot`/`liveness_drift` verdict
  (`registered-absent` → muted). Absent signal → peers still render from federated
  presence, no badge. Strictly additive; not a dependency.
- **Parallel / independent — ADR-0006 Phase-3 (hosted).** The meta-factory.ai
  pane's NKey-signed own-slice push is a *separate* surface; this feature is the
  **local** pane's federation. They share the roster source (P1) but do not block
  each other. Sequence P1→P2 first (fastest path to "jc shows on my local pane"),
  then P3/P4; ADR-0006 Phase-3 on its own track.

## 8. Open questions

1. **Per-network opt-in granularity.** Is enabling the reconciler all-or-nothing
   per stack, or per-network (federate into `metafactory` but not `community`)?
   Recommendation: per-network (mirrors `policy.federated.networks[]`), default
   off, explicit enable.
2. **Accept-list semantics vs. peers[].** Confirm whether `accept_subjects` is the
   sole inbound gate (then P2 is mandatory) or whether a per-peer rule derived
   from `peers[]` already admits them (then P2 is redundant and the gate just
   needs to read `peers[]`). The live `in=0` with `peers:[jc]` strongly implies
   `accept_subjects` is the gate — verify against `evaluateFederationGate` before
   building.
3. **Reconcile trigger.** Baseline must be cortex-owned (signal-optional §4): a
   self-poll of the registry roster on an interval (and/or a registry change-feed).
   *Optimization when signal is present:* piggyback the reconcile on signal's
   `roster_snapshot` cadence (cortex already consumes it) to avoid a second poller —
   but the self-poll is the fallback so the feature works with signal absent.
4. **`registered-absent` rendering.** Show a roster member with no live leaf as a
   muted/offline hub (presence-absent) vs. omit it. Recommendation: render muted —
   the principal wants to see *who is on the network*, live or not.

## 9. Acceptance

- A peer that joins a shared network *after* the local stack joined renders on the
  local Network view within one reconcile interval, without a manual `network join`.
- `cortex network status` shows the peer's subtree on `accept:` and `in>0`.
- **With signal NOT installed**, foreign peers still render on the Network view
  from federated presence — the feature has no hard signal dependency; signal
  only adds the transport verdict badge when present.
- With signal present, a roster member with no live leaf renders muted (signal
  verdict `registered-absent`), not stale-online.
- No interior subtree is ever accept-listed; chain-verify still rejects a
  scope-spoofed envelope under `enforce`.
