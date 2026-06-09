# Design — `cortex network ping`: an active federated reachability probe (the ICMP of the agent network) + its signal P-11 OAM tie-in

**Date opened:** 2026-06-10
**Driver:** Andreas
**Author:** Luna (architect)
**Status:** DECIDED (2026-06-10) — Andreas signed off the recommended set; **D-responder = always-on between configured `peers[]`** (his explicit call). All §13 decisions resolve per the recommendations (built-in echo responder; `federated.…tasks.@{assistant}.probe.echo` / reply `…probe.reply.echo`, NOT `system.probe.*`; verdict taxonomy `reachable`/`no-responder`/`timeout`/`refused`/`not-configured`; timeout-only v1; Direct default; cortex fires + signal P-11 observes; no-amplification = SEV-1 gate). Ready to build: cortex echo-responder + `cortex network ping` first; signal P-11 observability follows.
**Relates:** signal#113 / P-13 (the *passive* transport-observability spike — the complement to this), signal P-11 (reserved OAM / synthetic-probe phase), cortex#117 Phase E (OAM home), cortex network-join control plane (`docs/sop-network-join.md`, `docs/adr/0003`).
**Binding sources (this spec conforms to, does not re-derive):** `compass/sops/federation-wire-protocol.md` (the 5 FG checks), `docs/adr/0001-federated-subject-grammar.md` (subject grammar), `docs/adr/0002-federated-dispatch-addressing-and-verdict-back.md` (addressing + reply-back), `CONTEXT.md` §Network/§Scope/§Domain/§Dispatch/§capability.

---

## 0. TL;DR

A peer **cannot** see another peer's hub connection — the hub monitor is firewalled, which is the correct security posture (signal#113 §3.2: a leaf is structurally blind to its peers; the hub-side `$SYS`/`leafz` surfaces are privileged and held by the hub principal alone). signal#113 / P-13.A gives the **passive** answer — a hub-side scrape projects a sovereignty-filtered roster onto the bus. This spec is the **active** complement: a synthetic probe a peer fires *itself* that proves another peer is reachable **end-to-end over the federation** — our leaf → hub → their leaf → their stack → reply back — and reports round-trip time (RTT). It is the **ICMP / `ping` analog** for the agent network, and it is signal's reserved **P-11 OAM tier** made concrete (cortex fires the probe; signal observes the probe traffic for network-wide RTT + loss).

The recommendations, up front:

1. **Probe transport = a cheap, built-in echo responder — NOT a `chat` / CC-session dispatch.** The receiving cortex answers a reserved probe subject **in the runtime, with no LLM spawn**: echo the nonce + a server timestamp, then publish the reply back. The probe is cheap, repeatable, idempotent, and never surprises the assistant (no Discord post, no session, no side effect). A `chat`-dispatch "ping" would spin a Claude Code session per probe — expensive, slow, side-effecting, and a DoS multiplier. The echo responder is the design.
2. **Reserved subject (recommended): the `tasks` domain, Direct mode, a reserved `probe.echo` capability** — `federated.{target-principal}.{target-stack}.tasks.@{did-encoded-assistant}.probe.echo` for a Direct probe, or `federated.{target}.{stack}.tasks.probe.echo` for an Offer probe. This rides the **existing federated dispatch grammar** verbatim (FG-2/3/4 hold unchanged); a *new* `system.probe.*` or top-level `probe.*` domain would need a new wire-domain, a new subscription, and — critically — `system.*` is **local-scope, principal-only sovereignty** by definition, so it can never cross the federation boundary. The probe MUST be federated, therefore it MUST NOT be `system.*`. The responder short-circuits the dispatch *before* the substrate harness — it is recognised by capability, answered inline, and never reaches `ClaudeCodeHarness`.
3. **Verdict taxonomy:** `reachable` (+ RTT) · `no-responder` (subject routed, nobody echoed — peer up, probe-responder absent/old) · `timeout` (no echo, no route — leaf down / hub partition / peer offline) · `refused` (we are not in the peer's `peers[]` — fail-closed at their gate) · `not-configured` (peer not in **our** `peers[]` / roster — fail-closed at our publish boundary, nothing emitted).
4. **signal P-11 split:** cortex **fires** the probe and renders a **one-shot** verdict (this slice). signal **passively observes** the `*.probe.*` envelopes flowing past and aggregates **fleet-wide** end-to-end RTT + loss (the OAM row of §4.5). Scheduled / continuous probing is deferred to P-11 proper (cortex#117 Phase E).
5. **No new privilege; no amplification.** The probe rides the *existing* federated dispatch path + the `peers[]` gate — it grants no capability that a `chat` dispatch doesn't already have. The responder MUST rate-limit and MUST NOT amplify (one bounded reply per probe, reply only to the keyed-back requester scope, no fan-out) so a probe can never be a reflection/DoS vector. No `$SYS`. The echo reveals only liveness + a timestamp + the echoed nonce — nothing sensitive.

**v1 slice (ships immediately, answers the JC question once `peers[]` is configured):** the built-in echo responder + `cortex network ping`. The signal observability is the P-11 follow-on.

---

## 1. Why active, and why it is the complement to P-13 (not a duplicate)

signal#113 resolved the **passive** transport tier: a hub-side `transport-collector` scrapes `leafz` and projects a sovereignty-filtered `system.transport.*` roster onto the bus, yielding *roster-as-liveness* (intent ⋈ reality: `connected` / `registered-absent` / `unregistered-present`). That answers **"is the peer's leaf up, as the hub sees it?"** from the **hub's** vantage.

It does **not** answer the question this probe answers:

> **"Can a dispatch I send right now actually traverse the full path to that peer's stack and come back — and how long does it take?"**

The difference is the difference between **link-state** and **reachability**:

| | P-13 (passive) | **`cortex network ping` (active — this spec)** |
|---|---|---|
| Vantage | hub-side (one privileged collector) | **peer-side (any peer fires its own)** |
| Data source | observe link state that already exists (`leafz`) | **generate synthetic traffic and time the round trip** |
| Question | "is the leaf attached to the hub?" | **"is the peer reachable end-to-end, and what's the RTT?"** |
| Coverage | L1 link / L2 frames | **L1→L7 path: leaf → hub → leaf → stack → reply** |
| Privilege | requires hub access (held by hub principal) | **none beyond the existing `peers[]` federated path** |
| Failure it catches | "leaf never came up / dropped" | **"leaf is up per the hub, but the stack isn't actually answering" (the gap P-13 cannot see)** |

The two are complementary by the same logic netops uses: P-13 is the **interface table** (`show interfaces`); `ping` is the **active reachability test**. A leaf can be `connected` in the hub roster while the peer's stack is wedged, mis-configured, not subscribed to its own federated subject, or gating us out — P-13 reports `connected`, `ping` reports the truth. This is exactly the OSI/OAM layering signal §4.5 already names: **P-13 = passive L1/L2 link-state; P-11 = active OAM synthetic probes**, and signal#113 §1 is explicit that *"P-13 ships first and is a soft prerequisite for P-11."* This spec makes P-11's "concrete first step … a `pilot.probe.*` envelope class" (signal architecture §9) real — as a `cortex` `probe.echo` capability rather than a pilot-scheduled cadence.

---

## 2. The probe transport — KEY DECISION

### 2.1 Recommendation: a built-in echo responder (the ICMP-analog), not a chat dispatch

The probe is answered by the receiving cortex **in the runtime, before any substrate harness runs**. Concretely:

- The receiving stack's dispatch path recognises the reserved **`probe.echo`** capability on an inbound federated dispatch.
- It does **not** call `parsePayload` → `buildDispatchRequest` → `ClaudeCodeHarness.dispatch`. It short-circuits to a tiny pure responder: validate, rate-limit, build the echo reply, publish it back, done. **No `claude --print`, no session, no Discord post, no worklog, no Skill tool.**
- The reply carries the echoed nonce + a receiver server timestamp + the responder's version; the requester times the round trip.

This is the literal ICMP model: a kernel-level echo that costs almost nothing and has no application-visible side effect.

### 2.2 Why not a `chat` / CC-session dispatch

A naive "ping" could just send a `chat` dispatch ("reply 'pong'") on `federated.{target}.{stack}.tasks.@{assistant}.chat`. **Rejected**, on four grounds:

1. **Cost.** Every probe would spawn a Claude Code session on the target (the `dispatch-listener` → `ClaudeCodeHarness` path). A reachability check that costs an LLM invocation is unusable for repeated / scheduled probing, and turns P-11's "fixed-cadence synthetic probes" into a token-burn engine.
2. **Latency conflation.** A CC session's wall-clock is dominated by model time, not network RTT. The whole point of a probe is to measure **transport** RTT; a chat dispatch measures "how long did the LLM take to say pong," which is noise for the OAM SLA signal.
3. **Side effects.** A chat dispatch posts to a surface, writes a worklog, may resume a session, and **surprises the assistant** (it appears as real work). A probe must be invisible to the assistant and the principal's surfaces.
4. **Security blast radius.** A chat dispatch is full work-granting; making it a "probe" tempts callers to use the heavy path for a light purpose, and a flood of chat-pings is a far worse DoS multiplier than a flood of bounded echoes (each chat-ping spawns a process; each echo is O(1) and rate-limited).

The echo responder is cheaper, more accurate, side-effect-free, and strictly less privileged.

### 2.3 The reserved subject + responder — and how it stays FG-compliant

**Reserved capability:** `probe.echo` (a `<domain>.<entity>` capability id, matching the `tasks.{capability}.{subcapability}` grammar). It lives in the **`tasks` domain** because a probe is a unit of work routed to an assistant — it is a dispatch, just one the runtime answers itself. (See §2.4 for why NOT `system.*`.)

**Request subject (requester → target).** Two flavors, both standard per ADR-0002 §2 and CONTEXT.md §Dispatch:

| Mode | Request subject | `distribution_mode` |
|---|---|---|
| **Direct** (recommended default) | `federated.{target-principal}.{target-stack}.tasks.@{did-encoded-assistant}.probe.echo` | `direct` |
| **Offer** (any responder on the stack) | `federated.{target-principal}.{target-stack}.tasks.probe.echo` | `broadcast` (→ Offer) |

Direct is the recommended default: a probe wants to confirm a *specific* stack is reachable, and the echo responder is a stack-level built-in (no need to pick an assistant for routing — but the `@{assistant}` segment is required by the Direct grammar, so the CLI defaults it to the stack's primary assistant or a reserved `@stack` DID; see §13 D2-followups). Offer is offered as an alternative for "any agent on the stack, are you there."

**FG compliance (the 5 checks — each PASS).** The probe rides the federated dispatch grammar verbatim; nothing new on the wire:

1. **No network on the wire.** The subject carries `{target-principal}.{target-stack}`; the network is resolved from the target principal via `policy.federated.networks[].peers[]` at `selectLink` exactly as every other federated dispatch. No `network_id` in the subject, `source`, or `extensions`-for-routing. **PASS.**
2. **Subject addresses the TARGET.** `deriveNatsSubject` builds `{principal}.{stack}` from `envelope.source`, so the probe sets `source = {target-principal}.{target-stack}.{sender-assistant}`. The **responder subscribes to its own** `federated.{me}.{my-stack}.tasks.*.>` (the listener's existing canonical Tasks-Domain subscription) and matches the `probe.echo` capability. **PASS.**
3. **Requester rides in `originator.identity`.** The requester is carried as the canonical DID `did:mf:{requester-principal}-{requester-stack}` (= `stack.id` with `/`→`-`), `originator.method = federated`. The responder **decodes the requester from `originator.identity`** — strip `did:mf:`, split on the FIRST hyphen — NEVER from the subject or `source` (those address the target). **PASS.**
4. **Reply keyed on the REQUESTER.** The echo reply is published to the requester's own scope, derived from `originator.identity`: `federated.{requester-principal}.{requester-stack}.probe.reply.echo` (the reply mirrors the dispatch's verdict-back pattern). The CLI's `--wait` subscribes its **own** `federated.{us}.{our-stack}.probe.reply.>`, matched by `correlation_id`. The responder **fails closed** — drops, no reply — if `originator` is absent/malformed OR the requester is not a configured `peers[]` member. **PASS.**
5. **Scope is correct.** `federated.` throughout; lifecycle/reply mirror the inbound scope. A probe NEVER uses `local.` to cross the principal boundary. **PASS.**

**Request envelope shape (sketch — wire-faithful, not final):**

```
REQUEST  (us → peer)
  subject         federated.jc.default.tasks.@<did-encoded-assistant>.probe.echo
  source          jc.default.luna                         # addresses the TARGET (jc/default); sender assistant = luna
  originator      { identity: "did:mf:andreas-community",  # the REQUESTER (us)
                    method:   "federated" }
  type            probe.echo.request
  classification  federated · distribution_mode direct · max_hop 1 · NO network_id
  correlation_id  <uuid>                                   # join key for the reply
  payload         { nonce: "<random>", sent_at: "<iso8601>", seq: 1 }

REPLY    (peer → us)        # built-in echo, no LLM
  requester  = decode(originator.identity) = andreas/community   # NOT the subject, NOT source
  subject         federated.andreas.community.probe.reply.echo
  source          andreas.community.<responder>            # addresses US (the requester)
  type            probe.echo.reply
  classification  federated · max_hop 1
  correlation_id  <same uuid>
  payload         { nonce: "<echoed>", received_at: "<iso8601 of peer>",
                    responder_version: "<semver>", seq: 1 }
```

RTT is `reply_observed_at − sent_at` measured **on the requester** (one clock — robust to peer clock skew). `received_at` from the peer is informational only (one-way-delay estimate, skew-dependent — surfaced but not the primary metric).

### 2.4 Why NOT `system.probe.*` (an important constraint)

It is tempting to model a probe as `system.probe.*` (it *feels* like operational telemetry, a sibling of `system.transport.*`). **This is wrong on the wire:** per `CONTEXT.md` §Domain and `src/bus/system-events.ts`, the `system.*` domain is **local-scope, principal-only sovereignty** — "what is *this* cortex doing right now," explicitly NOT cross-principal. A probe's entire purpose is to **cross the federation boundary** to another principal's stack. A federated `system.probe.*` would be a category error (and would force a new federated-system subtree + gate). The probe MUST be `federated.*`, therefore it lives in the **`tasks` domain** (the federated dispatch grammar) on the way out, and a **`probe.reply.*`** subtree on the way back, mirroring how `review.verdict.*` is the reply-back subtree for code-review dispatches (ADR-0002 §3). The local *audit* of "I fired a probe / I answered a probe" MAY additionally emit a `system.probe.*` **local** envelope for signal to tail (see §4) — that is a separate, local, principal-only event and does not travel on the wire.

---

## 3. The CLI — `cortex network ping`

### 3.1 Synopsis

```
cortex network ping <peer> [--assistant <a>] [--network <id>] [--count N] [--timeout <ms>] [--json]
```

- `<peer>` — the target principal, or `{principal}/{stack}` to name a specific stack (defaults stack to `default`). This is the **identity** addressed; it is NOT a network.
- `--assistant <a>` — for a **Direct** probe, the named assistant whose DID encodes into the subject. Omitted ⇒ probe the stack's primary/reserved responder (see §13 D2). Mutually informs Direct vs Offer (see §13 D-mode).
- `--network <id>` — **topology selector only**, used to disambiguate *which* network's leaf to route over when the peer is reachable on more than one shared network. It is a **connection concern, NEVER a subject segment** (ADR-0002 §4: "No `--network` on the wire"). When the peer is in exactly one shared network, it is inferred from `peers[]` and the flag is unnecessary.
- `--count N` — number of echo probes to send (default 1; like `ping -c`). Sequenced via `seq`; the CLI reports per-probe RTT + min/avg/max + loss.
- `--timeout <ms>` — per-probe wait budget for the echo reply (default e.g. 2000ms).
- `--json` — emit the standard `{ status, items, data, error }` envelope (consistent with the rest of `cortex network`).

The command slots in as a fifth `network` subcommand alongside `join`/`leave`/`status`/`create` in `src/cli/cortex/commands/network.ts`. Like the others it derives principal/stack/seed/registry from the loaded `cortex.yaml` (the `#753` config-derivation seam), so the one-liner is `cortex network ping jc`.

### 3.2 What it emits / awaits

- **Emits:** the `probe.echo.request` envelope of §2.3, `source` addressing the peer, `originator.identity` = our DID, signed by our stack via `runtime.publish` (under `signing: permissive`/`enforce`; under `signing: off` it publishes unsigned exactly like every other dispatch today).
- **Awaits:** the `probe.echo.reply` on our **own** `federated.{us}.{our-stack}.probe.reply.>`, matched by `correlation_id` (subject-agnostic matcher, mirroring `pilot --wait`), within `--timeout`.

### 3.3 Verdict taxonomy (the `ping` exit-status analog)

| Verdict | Meaning | Most likely cause | Exit |
|---|---|---|---|
| **`reachable`** | echo reply received within timeout | peer up, federation path healthy; report RTT | 0 |
| **`no-responder`** | subject routed (we got *something*, or the dispatch was accepted) but **no echo** within timeout | peer's leaf is up and gating passed, but the **probe responder is absent or too old** (version floor unmet) — peer stack reachable, capability missing. *This is the gap P-13 cannot distinguish from healthy.* | 3 |
| **`timeout`** | no echo, no sign of routing | **no route**: peer's leaf down, hub partition, peer offline, or wrong network. (P-13 `registered-absent` correlates here.) | 4 |
| **`refused`** | our request reached the peer but their gate **fail-closed** us | **we are not in the peer's `peers[]`** (FG-4) — or signing posture rejected us under `enforce`. Peer is up; trust is one-directional. | 5 |
| **`not-configured`** | the CLI never emitted | **the peer is not in OUR `peers[]` / roster** — fail-closed at our publish boundary (no `selectLink` route resolvable). Nothing went on the wire. | 2 |

Notes on distinguishing `no-responder` vs `timeout`: in the pure-echo design the requester cannot *directly* see "the dispatch was accepted but not answered." Two ways to disambiguate, for the principal to choose (§13 D4): **(a)** correlate with P-13's roster (`connected` + no echo ⇒ `no-responder`; `registered-absent` ⇒ `timeout`) — clean, but couples ping to signal; or **(b)** have the responder emit a cheap **`probe.ack`** before the echo so the requester can tell "routed but slow/old responder" from "no route at all." Recommendation: ship v1 with the **timeout-only** distinction (everything-not-reachable is `timeout`), add the P-13 correlation as the natural refinement once P-13.B lands, and treat `probe.ack` as a deferred nicety (it doubles wire traffic for a corner case).

### 3.4 Example output

```
$ cortex network ping jc --count 3
PING jc/default (network: metafactory-community) via federated dispatch:
  seq=1  reachable  rtt=42ms
  seq=2  reachable  rtt=39ms
  seq=3  reachable  rtt=44ms
--- jc/default ping statistics ---
3 probes sent, 3 echoes received, 0% loss
rtt min/avg/max = 39/41.7/44 ms
```

---

## 4. signal P-11 tie-in (the OAM observability)

### 4.1 The split (cortex fires; signal aggregates)

| Concern | Owner | What it does |
|---|---|---|
| **Fire one probe, render a one-shot verdict** | **cortex** (this spec) | `cortex network ping` emits the request, awaits the echo, prints `reachable`/RTT or a failure verdict. Interactive, on-demand, single round-trip. |
| **Observe probe traffic fleet-wide, aggregate RTT + loss** | **signal P-11** | signal passively taps the `*.probe.*` envelope class as it flows through the bus, joins request↔reply on `correlation_id`, and produces **network-wide end-to-end RTT + loss** — the SLA OAM row of §4.5 (Y.1731 / Ethernet SAM analog). |
| **Scheduled / continuous probing at fixed cadence** | **deferred to P-11 proper** | The cron-style synthetic-probe scheduler (per-scope SLA monitoring) is cortex#117 Phase E + signal P-11; this spec deliberately ships only the on-demand one-shot. |

This mirrors the P-13 cortex↔signal boundary verbatim (signal#113 §10): **cortex owns the acting stack's own control-plane action** (fire a probe, like `cortex network status` reads its own leaf); **signal owns the network-wide observability** (aggregate everyone's probe RTT, like the `transport-collector` aggregates everyone's link state). Neither subsumes the other; they reconcile in `compass/ecosystem/CONTEXT-MAP.md`.

### 4.2 The envelope class signal taps

signal's envelope-tail already re-encodes cortex's segment-4 myelin domains as OTLP. P-11 extends the tail to the probe class:

- **`tasks.@*.probe.echo` / `tasks.probe.echo`** (the request, on the federated path) and **`probe.reply.echo`** (the reply) — joined on `correlation_id` to compute end-to-end RTT per probe and loss per (requester, target, network) tuple.
- Optionally the **local `system.probe.*` audit** envelopes (§2.4) — "this stack fired/answered N probes" — as a per-stack counter, principal-only, NOT self-tailed into a loop (the signal#99 self-capture guard applies: `system.probe.*` is cortex-produced and must be explicitly listed or excluded, never swept by a bare `system.>`).

**signal does NOT generate probes in this slice** — it observes the ones `cortex network ping` (and later the P-11 scheduler) fire. This keeps signal's "observe, never act" carve-out intact, exactly as P-13 keeps it.

### 4.3 Federation namespace for the observability

When probe RTT crosses a principal boundary for fleet-wide aggregation, it rides the **same opt-in, ACL-gated, sovereignty-filtered federation path P-8 built** (signal#113 D5). **Do not re-decide it here** — defer to cortex#21 / signal#26, exactly as P-13 did.

---

## 5. Prerequisites & gates

A probe to peer `jc/default` from `andreas/community` requires, on both sides:

1. **Mutual `peers[]` membership (FG-4, fail-closed).**
   - **Our side:** `jc/default` must be in our `policy.federated.networks[].peers[]` — otherwise `selectLink` resolves no route and the CLI returns `not-configured` (exit 2, nothing emitted).
   - **Their side:** `andreas/community` must be in JC's `peers[]` — otherwise their gate fail-closes our request and we observe `refused` (exit 5) — or, if their gate drops silently, `timeout`.
2. **The responder exists on the target (version floor).** JC's stack must run a cortex new enough to recognise the `probe.echo` capability and answer it built-in. An older stack routes the subject but never echoes ⇒ `no-responder` (exit 3). The version floor is the cortex release that ships this feature; surfaced in the verdict detail.
3. **The target stack is running and joined to a shared network.** JC's daemon up, leaf attached to `metafactory-community`. (P-13 `connected` is the passive precondition; this probe is the active confirmation.)
4. **Signing posture.** Orthogonal to scope (CONTEXT.md §Scope). Under `signing: off` the probe publishes unsigned and the gate is `peers[]`-only (application-layer). Under `permissive`/`enforce` the stack signs the request (the same `resignSigner` / stack-NKey path the dispatch listener uses) and the responder's `enforce` gate additionally crypto-verifies the `signed_by` chain + `originator` signature before echoing. A probe NEVER weakens posture.

**The concrete JC checklist:** `jc/default` in **our** `peers[]` + `andreas/community` in **JC's** `peers[]` + JC's stack running a responder-capable cortex on `metafactory-community`. Once those three hold, `cortex network ping jc` returns `reachable` + RTT — the active answer to the 2026-06-09 question that was previously unanswerable from our side.

---

## 6. Security

The probe introduces **no new privilege** and MUST NOT become an attack primitive.

1. **No new capability surface.** The probe rides the *existing* federated dispatch path + the `peers[]` gate. It grants nothing a `chat` dispatch doesn't already grant; in fact it grants strictly less (the responder runs no harness, no Bash, no tools, no Skill). The runner's existing `evaluateFederationGate` / `resolveSourceNetwork(principalFromEnvelope(...))` membership check on the inbound path (ADR-0002 §5 defense-in-depth) covers the probe with zero new code-path.
2. **No amplification / reflection.** This is the load-bearing security property. The responder MUST:
   - emit **exactly one** bounded reply per request (no fan-out, no multi-packet, no payload echo beyond the fixed-size nonce);
   - reply **only** to the requester scope decoded from `originator.identity` — never to an attacker-supplied reply address, never broadcast;
   - **rate-limit** per source principal (a small token bucket) so a flood of probes cannot be turned into a flood of replies aimed at a victim, and cannot exhaust the responder. The reply is O(1) and far smaller than the cost of spawning a session, so even under abuse the blast radius is bounded — but the rate-limit makes "probe → reflected reply at a third party" structurally impossible (the reply only ever goes to the *cryptographically attributed* requester, and only at a capped rate).
   - **Never reflect to a forged originator under `enforce`:** the `originator` signature check ensures the reply-to is the real requester; under `signing: off` the `peers[]` membership gate bounds the set of principals who can elicit a reply to known, mutually-configured peers only.
3. **No `$SYS`, no privileged surface.** Unlike P-13 (which needs hub-side `leafz`), the active probe needs **nothing privileged** — it is peer-to-peer over the already-authorized federated path. This is a security *advantage* of the active approach: a peer can confirm reachability without any hub credential.
4. **Minimal disclosure.** The echo reveals only: liveness (it answered), a server timestamp, the responder version, and the echoed nonce. No internal state, no agent roster, no config, no IPs. The responder version is the one mild disclosure (it tells a peer "you're running an old cortex") — acceptable between mutually-configured `peers[]`, and useful for the `no-responder` diagnosis.
5. **Audit.** Each probe fired / answered MAY emit a local `system.probe.*` audit envelope (principal-only) so the principal can see "who has been probing my stack, how often" — the abuse signal. This is local, never federated, never self-tailed.

---

## 7. Phasing

| Phase | Scope | Deps |
|---|---|---|
| **Ping-A (cortex slice — ships first)** | Built-in `probe.echo` responder (short-circuit in the dispatch path, before the harness) + rate-limit + `cortex network ping` CLI with the §3.3 verdict taxonomy (timeout-only `no-responder`/`timeout` distinction for v1). Usable immediately for the JC question once `peers[]` is configured. | The federated dispatch path (shipped); `peers[]` configured on both sides (ops). |
| **Ping-B (signal P-11 observability)** | signal taps the `*.probe.*` envelope class, joins request↔reply on `correlation_id`, aggregates network-wide RTT + loss; the `no-responder` vs `timeout` refinement via P-13 roster correlation. | P-13.B (roster, for the correlation refinement); signal P-11 phase; cortex#21 / signal#26 for the federated namespace (defer, don't re-decide). |
| **Ping-C (scheduled OAM — deferred)** | Fixed-cadence synthetic probing for continuous per-scope SLA (the full Y.1731 OAM tier). | cortex#117 Phase E + signal P-11 proper. Out of scope for this spec. |

---

## 8. Open implementation notes (non-binding — for the build, after sign-off)

- **Where the short-circuit lives.** The responder recognition belongs in the inbound dispatch path *before* `handleDispatchEnvelope` reaches `parsePayload`/`buildDispatchRequest` — either a capability check in `dispatch-listener.ts` that diverts `probe.echo` to a pure responder, or (cleaner) a dedicated `probe-responder` that subscribes the `tasks.*.probe.echo` pattern alongside the runner. The federation gate + `peers[]` check still runs first (it is subject-domain-scoped to `federated.*` and runs before harness dispatch today), so the probe inherits the gate for free.
- **The `@{assistant}` segment for Direct probes.** The Direct grammar requires a `@{did-encoded-assistant}` segment, but the responder is stack-level. Options: default to the stack's primary assistant DID; or reserve a `@stack` / `@probe` DID for the built-in responder. This is a §13 follow-up.
- **Clock model.** RTT is measured single-clock on the requester (`sent_at` → `reply_observed_at`); the peer's `received_at` is informational. No clock-sync assumption.
- **Reply subtree naming.** `probe.reply.echo` mirrors `review.verdict.{...}`. Confirm the subtree name in §13.

---

## 9. Verification strategy (verify-before-claiming)

- **Live oracle (the JC scenario):** stand up two stacks on a shared network with mutual `peers[]`. `cortex network ping <peer>` → `reachable` + RTT. Stop the peer's daemon → `timeout`. Run the peer on a pre-responder cortex → `no-responder`. Remove us from the peer's `peers[]` → `refused`. Remove the peer from our `peers[]` → `not-configured` (nothing emitted). These five are the close-criteria.
- **FG conformance:** a unit test asserting the request subject addresses the target, `originator` carries our DID, and the reply is keyed to *our* scope decoded from `originator` (not the subject). Run `/wire-check` on the emit + responder code.
- **No-amplification test (SEV-1 if it fails):** a forged/absent `originator` ⇒ no reply (fail-closed); a flood ⇒ rate-limited; the reply never targets anything but the attributed requester; one request ⇒ exactly one reply.
- **No-harness test:** assert a `probe.echo` dispatch never constructs a `ClaudeCodeHarness` / spawns a session.
- **Posture matrix:** `off` (unsigned, `peers[]`-gated) and `enforce` (signed, chain + originator verified) both yield `reachable` between configured peers; `enforce` with an unconfigured peer yields `refused`.

---

## 10. Out of scope

- Scheduled / continuous probing (Ping-C / P-11 proper).
- Multi-hop probes (`max_hop > 1`) — v1 is single-hop (`max_hop = 1`), matching the federated dispatch default.
- Path tracing (a `traceroute` analog across multiple hubs) — a future OAM extension.
- Probing `public.*` scope peers — v1 is `federated.*` only; public-scope reachability is a separate design tied to the public-square trust ramp.
- The hub-side passive roster — that is P-13 (signal#113), already decided.

---

## 11. The cortex ↔ signal boundary (restated, load-bearing)

- **cortex** owns the **acting stack's own probe action + the one-shot verdict** — "*I* fire a probe; can *I* reach that peer right now?" Surface: `cortex network ping` (peer-side, on-demand). The active counterpart to `cortex network status` (own-stack control-plane).
- **signal** owns the **network-wide probe observability** — fleet-wide end-to-end RTT + loss aggregated across everyone's probes (P-11 OAM). The active counterpart to the P-13 `transport-collector` (hub-side passive roster).

Clean and complementary: cortex acts + reports its own result; signal observes + aggregates the fleet. Neither subsumes the other. They reconcile in `CONTEXT-MAP.md`.

---

## 12. Alternatives considered

- **Chat-dispatch ping (§2.2).** Rejected — expensive, latency-conflating, side-effecting, DoS-multiplying.
- **`system.probe.*` federated domain (§2.4).** Rejected — `system.*` is local-scope/principal-only by definition; a federated probe cannot live there. The `tasks` domain (out) + `probe.reply.*` (back) is the FG-conformant home.
- **`--network` on the wire.** Rejected — ADR-0002 §4: network is a connection concern, never a subject segment. `--network` is a leaf selector only.
- **A new top-level `probe.*` scope/domain.** Rejected — a probe is a dispatch (work routed to an assistant, answered by the runtime); reusing the `tasks`/reply grammar means zero new wire-domain, zero new gate, and the FG checklist holds unchanged. A new domain would re-open all five FG questions for no benefit.
- **Probe via the P-13 passive roster only (no active probe at all).** Rejected — the passive roster cannot distinguish "leaf up, stack wedged/old/gating" from "healthy." The active probe is the only thing that exercises the full path. P-13 and ping are complements, not substitutes (§1).

---

## 13. Decisions needed (the calls for the principal)

**Plan means stop.** Nothing is implemented until these are signed off.

- **D-transport (KEY). Probe transport.** Built-in **echo responder** (recommended — cheap, side-effect-free, accurate, no LLM, the ICMP-analog) vs **capability-dispatch** (a `chat`/CC-session "ping" — expensive, latency-conflating, side-effecting, DoS-multiplying)? → *Recommend the built-in echo responder.*

- **D-subject. Reserved subject / namespace.** Use the **`tasks` domain Direct/Offer grammar** — request on `federated.{target}.{stack}.tasks.@{assistant}.probe.echo` (Direct) / `…tasks.probe.echo` (Offer), reply on `federated.{requester}.{stack}.probe.reply.echo` — with `probe.echo` as the reserved capability and `probe.reply.*` as the reply subtree (mirrors `review.verdict.*`)? Or a different reserved namespace? → *Recommend the `tasks` + `probe.reply.*` shape; explicitly NOT `system.probe.*` on the wire (system.* is local/principal-only). Confirm the `probe.echo` / `probe.reply.echo` names.*

- **D-responder. Always-on or opt-in.** Is the echo responder **always-on** for any stack on the federated path (ICMP-like — every host answers ping by default), or **opt-in** per stack (a `policy.federated.probe_responder: true` knob)? → *Recommend always-on between configured `peers[]` (the responder only ever answers a mutually-configured, gated peer, reveals only liveness + timestamp, and is rate-limited — so always-on carries negligible risk and maximises diagnostic value). Offer an opt-out for stacks that want zero probe surface.*

- **D-verdict. Verdict taxonomy sign-off.** `reachable` (+RTT) / `no-responder` / `timeout` / `refused` / `not-configured`, with the exit-code mapping in §3.3? → *Recommend as specified.*

- **D4. `no-responder` vs `timeout` distinction.** v1 **timeout-only** (everything-unreachable is `timeout`, refine later via P-13 roster correlation), vs add a cheap **`probe.ack`** pre-reply so the requester can tell "routed but old/slow responder" from "no route"? → *Recommend timeout-only for v1; refine via P-13 correlation in Ping-B; `probe.ack` deferred (doubles wire traffic for a corner case).*

- **D-mode. Direct vs Offer default.** Default the CLI to a **Direct** probe (confirm a specific stack, requires an `@{assistant}` segment — see the §8 default-assistant follow-up) or an **Offer** probe (any responder on the stack)? → *Recommend Direct default (a probe targets a specific stack's reachability), with `--assistant` overriding and an Offer mode available.*

- **D-p11. The cortex↔signal (P-11) split.** cortex **fires + one-shot verdict**; signal **passively observes the `*.probe.*` class + aggregates fleet-wide RTT/loss**; scheduled/continuous probing **deferred to P-11 proper** (cortex#117 Phase E). Federated namespace for the aggregation **deferred to cortex#21 / signal#26** (don't re-decide). → *Recommend as specified — mirrors the P-13 boundary exactly.*

- **D-security. No-amplification gate.** Confirm the non-negotiables: exactly-one bounded reply per request; reply only to the `originator`-attributed requester scope; per-source rate-limit; no `$SYS`; fail-closed on absent/forged `originator` or non-`peers[]` requester. → *Recommend as specified; a failing amplification/reflection test is a SEV-1.*

---

*End of design. §13 decisions are the principal's to make. Once signed off, Ping-A (responder + `cortex network ping`) is a small, self-contained cortex slice that answers the JC reachability question; Ping-B is the signal P-11 observability follow-on.*
