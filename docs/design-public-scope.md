# Design Spec — The `public` scope (the open square / IoAW)

**Status:** Draft (for sign-off — design-first; do not implement before the §decisions-needed block is signed off)
**Stage:** Design Spec (per `compass/sops/design-process.md`)
**Authoritative detail:** `CONTEXT.md` §Scope/§Network/§Dispatch/§capability · `docs/adr/0003-network-join-control-plane.md` (DD-2/3/7/9/11/12, OQ1) · `compass/sops/federation-wire-protocol.md` (the 5-check grammar, check #5 scope correctness) · `docs/design-internet-of-agentic-work.md` §3.5 (public mesh) · `docs/design-network-join-control-plane.md` §3 + F5/OQ1
**Builds on (shipped):** S5 / cortex#739 — `cortex network join public` (`src/cli/cortex/commands/network-public-lib.ts`, `network-public-ports.ts`), `PolicyPublicSchema` (`src/common/types/cortex-config.ts`), `evaluatePublicGate` (`src/bus/surface-router.ts`), the registry `/capabilities` index + `/principals` register (`src/services/network-registry/src/routes/`).

---

## §0 — TL;DR

`federated` is **named, closed**: each principal lists the others in `policy.federated.networks[].peers[]` (FG-4 fail-closed; you cannot reach, or be reached by, a principal you have not named). `public` is the **open square** — the tier for principals you have **NOT** peered. The whole point of this spec is: *`public` = federated without the per-peer naming.*

A principal participates in `public` via two asymmetric, decoupled moves instead of a mutual `peers[]`:

1. **Outbound / announce** — declare capabilities to the registry's public index (`announce_capabilities[]` → discoverable via `GET /capabilities`; broadcast presence via `system.capability.announced.*`). This is "come find me." It grants *nothing*.
2. **Inbound / allow** — gate inbound `public.*` work with an **allowlist** (`policy.public.allow_principals[]`). Empty = inbound disabled (the OQ1-safe **default-deny** posture). Non-empty = inbound admitted **only** from those named sender principals. There is deliberately **no fully-open / anonymous-claim path** today.

The shipped #739 work delivered the *opt-in surface and the default-deny gate*. This spec is the **forward design** of everything #739 explicitly deferred: capability **discovery as a dispatch path** (Offer routed by capability on `public.…tasks.{capability}`), **identity verification of an unknown sender** (registry-resolved pubkey on demand, no pre-shared key), **trust-grading** public-below-federated, the **abuse/sovereignty** surface, and the **graduation** path public → federated. **The load-bearing decision is the inbound gate** (§3) — it is where an unknown principal's work first touches your runtime, and it must stay default-deny.

---

## §1 — The trust model: `federated` (named, closed) vs `public` (open square)

### 1.1 The core contrast (one crisp statement)

> **`federated`** is a *mutual, explicit naming*: each principal enumerates the other principals it will talk to in `policy.federated.networks[].peers[]` (principal_id + stack_id + registry-resolved-or-pinned pubkey). Reachability is **symmetric and closed** — if you are not in my `peers[]` and I am not in yours, no `federated.*` envelope crosses between us, and the membership gate (`evaluateFederationGate`, keyed on `stack_id` membership) **fails closed** (FG-4). **`public`** removes the per-peer naming entirely: a principal **announces capabilities** to a shared index and gates **inbound** work with a one-sided **allowlist**. The two sides are *decoupled* — announcing grants nobody access, and allowing a sender does not require them to allow you. An unknown principal reaches you over `public.*` only when you have explicitly opted in **and** named them on the inbound allowlist; you reach an unknown provider by discovering its announced capability and dispatching an Offer on `public.…tasks.{capability}`. No mutual `peers[]` entry is ever created.

### 1.2 Side-by-side

| Axis | `federated` | `public` |
|---|---|---|
| Who can reach whom | Mutual, pre-named (`peers[]` on both sides) | Asymmetric: announce (outbound) + allowlist (inbound), decoupled |
| Subject grammar | `federated.{principal}.{stack}.…` (addresses the **target**) | `public.{domain}.{entity}.{action}` — **no principal/stack segment** |
| Inbound gate | `evaluateFederationGate` — source principal's `stack_id` ∈ a network's `peers[]` | `evaluatePublicGate` — source principal ∈ `policy.public.allow_principals[]` |
| Default posture | Fail-closed on unknown peer (FG-4) | **Default-deny** — inbound OFF unless opted in (OQ1) |
| Identity source | Peer pubkey: registry-resolved (DD-5) or hand-pinned, **per-peer, pre-loaded** | Sender pubkey: registry-resolved **on demand** by source-principal id (no pre-load) |
| Trust grade | Higher — a named, deliberate relationship | Lower — an unnamed counterparty in an open market |
| Discovery | None needed — you already named the peer | Registry public index (`GET /capabilities`) + announce roster |
| Control-plane state on join | `peers[]`, leaf link, network descriptor | `policy.public` block only; no peer/leaf/network state (#739 keeps this disjoint) |

### 1.3 How an unknown principal reaches you (and you reach them) without pre-listing

**They → you (inbound):** an unknown principal `zoe` publishes an Offer on `public.tasks.{capability}.{subcapability}` (no `{principal}.{stack}` segment; per CONTEXT.md §Scope the public grammar omits it). You receive it **only if** you subscribed `public.>` (the #739 `addPublicSubscription`) *and* `policy.public.enabled` *and* `principalFromEnvelope(envelope)` (the source principal off `envelope.source`/`signed_by[0]`) ∈ `allow_principals[]`. Otherwise `evaluatePublicGate` hard-drops it and emits `system.access.denied` (reason `public_not_enabled` or `public_sender_not_allowlisted`). **You never listed `zoe` in advance unless you allowlisted her** — see the discovery→allowlist handshake in §2.4 and the abuse caveat in §3.

**You → them (outbound):** you discover `zoe`'s announced capability via the registry public index (§2), then publish an Offer addressed *by capability, not by target principal* on `public.…tasks.{capability}`. Any `public`-subscribed, capable provider whose own allowlist admits **you** can claim it. You did not list `zoe`; you named a *capability*. (This is the inversion that makes `public` the open square: in `federated` the subject addresses a named target; in `public` the subject addresses a *capability* and the market routes it.)

---

## §2 — Discovery (finding a provider you have not peered)

### 2.1 Two discovery surfaces, already half-built

1. **Registry public index (pull).** `GET /capabilities?query=<substring>` (`src/services/network-registry/src/routes/capabilities.ts`) searches over every registered principal's declared `capabilities` (fed by `POST /principals/:id/register`, which carries `claim.capabilities`). #739's `announceCapabilities` upserts the stack's principal record with its `announce_capabilities[]`, making it appear here. Responses are wrapped in a registry-signed `SignedAssertion` (DD-9) so the caller verifies the registry signature against the pinned registry pubkey before trusting any hit. **This is the public capability roster — shipped.**
2. **Announce broadcast (push).** A `system.capability.announced.*` envelope on the bus advertises a stack's capabilities to live listeners (the federated counterpart already uses `system.capability.announced.<network_id>`; the public counterpart drops the network segment, consistent with the no-`{principal}.{stack}` public grammar). **Recommendation:** the public announce subject is `public.system.capability.announced.{capability}` — capability-keyed, not principal-keyed, so a discoverer subscribes by the capability it wants, not by a principal it would have to already know.

### 2.2 Offer-mode dispatch routed by capability (the public dispatch path — NET-NEW)

`federated` Offer addresses a *named target*: `federated.{target-principal}.{target-stack}.tasks.{capability}` (wire-protocol SOP check #2). `public` Offer **cannot** — there is no target segment. **Recommendation:** public Offer publishes on `public.tasks.{capability}.{subcapability}` and is routed *purely by capability*. Competing-consumers semantics (JetStream queue-group, exactly-one claim) still apply, but the consumer set is "every `public`-subscribed stack that announced this capability and whose inbound gate admits the requester," not "the named peer." This is the marketplace match: *capability tag in, one capable provider out.*

### 2.3 How public Offer differs from federated Offer

| | federated Offer | public Offer |
|---|---|---|
| Subject | `federated.{target}.{stack}.tasks.{cap}` | `public.tasks.{cap}.{subcap}` (no target) |
| Routing key | the **named** target principal | the **capability** |
| Candidate set | the one named peer | any public provider that announced `{cap}` and allowlists the requester |
| Requester identity | `originator.identity` (a known peer) | `originator.identity` (a possibly-unknown principal, resolved on demand — §4) |
| Verdict-back | `federated.{requester}.{stack}.review.verdict.*` | `public.review.verdict.*` keyed on requester (mirrors inbound scope; see §4.3) |

### 2.4 The discovery→allowlist handshake (closing the asymmetry)

Discovery is unauthenticated-read (anyone can `GET /capabilities`); **acceptance is gated.** A provider that announces is discoverable but, by default-deny, accepts nothing. To actually *receive* work from a discovered requester, the provider must add that requester's principal id to `allow_principals[]` (a deliberate `cortex network join public --allow <requester>` step). **Recommendation:** keep discovery and acceptance decoupled (announce is free; accept is a deliberate act) — this is the property that makes default-deny safe even with a fully-open index. The open-market "anyone can claim anything" posture is **explicitly out of scope** until the OQ1 abuse story lands (§3, §decisions-needed).

---

## §3 — The inbound gate (the load-bearing security call) ⚠️

> **This is the decision that matters most in this spec.** On `public` you accept work from principals you have never met. Everything else (discovery, verdict-back, namespace) is plumbing; the inbound gate is the trust boundary. **The recommendation is to keep it default-deny and allowlist-only until a dedicated abuse story (OQ1) is designed and signed off — i.e. do NOT add a fully-open / anonymous-claim mode in this spec.**

### 3.1 What gates inbound public work (defense in depth)

The shipped `evaluatePublicGate` is the first gate. The full inbound chain this spec proposes, in order:

1. **Subscription** — you only see `public.*` if you ran `join public` (added `public.>` to `nats.subjects[]`). Not opting in = invisible to the public tier.
2. **`policy.public.enabled`** — absent or `false` ⇒ every inbound `public.*` is hard-dropped (`public_not_enabled`). Opting in to *announce* does not flip this (announce is control-plane; enabled is data-plane trust).
3. **Allowlist** (`allow_principals[]`) — `enabled: true` + sender ∉ allowlist ⇒ dropped (`public_sender_not_allowlisted`). **Empty allowlist = trust nobody** (deny-by-default), not trust-everybody.
4. **Capability-scoping** (NET-NEW) — even an allowlisted sender may only dispatch capabilities the stack actually **announced** on `public`. A `public.tasks.{cap}` Offer for a capability not in `announce_capabilities[]` is dropped. *Announcing is the contract surface; you accept only what you advertised.*
5. **Identity verification** (§4) — under `signing: enforce`, the sender's `signed_by[0]` is crypto-verified against a registry-resolved pubkey before the allowlist check is honored. An unverifiable signature fails closed.
6. **Rate-limit + content-filter** (NET-NEW, §5) — per-source-principal inbound rate cap and a payload sanity/content filter, so an allowlisted-but-misbehaving sender cannot flood or inject.
7. **Principal-only / authorIsPrincipal** — a public dispatch is accepted only as a principal-level actor; it never inherits an MC authorization role, and it cannot target `@{assistant}` Direct/Delegate on the public tier (Offer-by-capability only — see §3.3).

### 3.2 Trust grading — public sender < federated peer

A public sender is **structurally lower-trust** than a federated peer (they're unnamed, met-in-the-open). The grade governs *what they may dispatch*:

| Capability class | federated peer | public sender (allowlisted) |
|---|---|---|
| Offer by capability (`tasks.{cap}`) | yes | **yes** (only announced capabilities) |
| Direct/Delegate to a named `@{assistant}` | yes | **no** (no `public.tasks.@assistant` path; §3.3) |
| Trigger side-effecting / control-plane capabilities (deploy, release, network-join) | per peer policy | **no** — read/analyse/review-class only by default; side-effecting capabilities are never auto-announced to `public` |
| Be named in verdict-back / lifecycle | yes | yes (mirrors inbound scope) |
| Observe your activity | only your `federated.{me}.…` they're peered for | **nothing beyond what you announced** (§5.3) |

**Recommendation:** a stack's `announce_capabilities[]` for `public` should be a *deliberately narrower* set than its full capability list — read/review/analysis-class by default; side-effecting capabilities (deploy, release) require explicit per-capability opt-in and should warn at join time.

### 3.3 No Direct/Delegate on public (recommendation)

`federated` permits `tasks.@{assistant}.{cap}` (address a named assistant). On `public` there is no stable, pre-known assistant address an unknown principal could target, and Direct/Delegate are higher-trust (single-recipient, orchestrating). **Recommendation:** `public` supports **Offer-by-capability only.** Direct/Delegate to a public counterparty requires graduating to `federated` (§6). This keeps the public surface to "anonymous market for offered work," not "anyone can address my named assistant."

### 3.4 Why this gate is disjoint from the federation gate (wire-protocol SOP check #5)

`public.*` carries **no** `{principal}.{stack}` segment, so it MUST NOT be routed through `evaluateFederationGate` (which resolves a source *network* from `peers[]`, runs the leaf anti-spoof cross-check, and reads a target principal off the subject). `evaluatePublicGate` keys **only** on the source principal vs the public allowlist. Mixing them would mis-apply federated peer checks to the no-principal-segment scope — the exact failure the brief flags. The shipped router already enforces this disjointness (`effectiveSubject.startsWith("public.")` → public gate only). **Keep it.**

---

## §4 — Identity & verification of an unknown sender

### 4.1 The problem `public` introduces

`federated` pre-loads each peer's pubkey (registry-resolved at config-load per DD-5, or hand-pinned). `public` has **no pre-shared `peers[]` pubkey** — by definition you did not list the sender. So: *how do you verify a `signed_by[0]` you've never seen?*

### 4.2 Registry-resolved pubkey, on demand (recommendation — reuses shipped machinery)

The `PrincipalPubkeyResolver` (TC-2a, `src/common/registry/resolve-pubkey.ts`, consumed by `MultiPrincipalIdentityRegistry`) already resolves **any** principal's pubkey on demand: `GET /principals/{id}` → registry-signed assertion → verify against the pinned registry pubkey (DD-9) → cache. This is *exactly* the public-sender case. **Recommendation:** verifying a public sender is the same resolve-on-demand path as a federated peer, with the source principal id taken from `envelope.source`/`signed_by[0]` instead of from a `peers[]` entry. No new identity mechanism. The registry's `POST /principals/.../register` already enforces TOFU + nonce-replay + clock-skew + no-silent-rotation, so the resolved pubkey is the principal's attested key.

### 4.3 Posture interaction (`signing: off` / `permissive` / `enforce`)

Security posture is **orthogonal to scope** (DD-7) but the *risk profile* differs sharply on `public`:

| posture | federated unknown sender | public sender (the new risk) |
|---|---|---|
| `off` | no crypto check; gate is membership-only | **allowlist is the ONLY gate** — a spoofed source principal id would pass. Acceptable only because allowlist is opt-in + narrow; **recommend a join-time warning** that `public` + `signing: off` trusts an unauthenticated source id. |
| `permissive` | verify if resolvable, accept-with-warn if not | resolve sender pubkey on demand; verify if resolvable; **accept-with-warn** if the registry can't resolve them (logged `system.error`) |
| `enforce` | unresolvable/unverifiable ⇒ fail closed | unresolvable or bad-signature public sender ⇒ **fail closed** (drop). This is the recommended posture for any `public` stack accepting side-effecting work. |

**Recommendation:** a stack with a **non-empty public allowlist** SHOULD run at least `signing: permissive`, and MUST run `enforce` if any announced public capability is side-effecting. Surface this as a join-time advisory (not a hard block — DD-7 keeps the axes orthogonal).

### 4.4 The chain stays the audit trail

Public work uses the same `signed_by[]` chain-of-stamps (Q6) as everything else: `signed_by[0]` is the unknown sender's stack NKey; your stack appends `signed_by[1]` when it produces a result. Cross-public provenance is the signed chain — no separate public audit service. Verdict-back mirrors inbound scope: `public.review.verdict.*` keyed on the requester (resolved from `originator.identity`, never from the subject — there is no principal segment to parse).

---

## §5 — Sovereignty & abuse (the larger attack surface)

`public` is a bigger attack surface than `federated` by construction (unnamed counterparties, open discovery). The defenses:

### 5.1 No amplification
A public-received Offer MUST NOT cause your stack to re-emit onto `public.*` on the sender's behalf (no open relay). Lifecycle/verdict envelopes go back to the requester's scope only. A public dispatch never auto-fans-out to your federated peers or local agents beyond the single claimed unit of work.

### 5.2 Rate-limit + content-filter (NET-NEW)
- **Per-source-principal inbound rate cap** at the gate (mirrors the registry's own per-(IP, principal) `checkRateLimit`, #680) — an allowlisted-but-hostile sender can be throttled without removing them. **Recommendation:** a default public inbound rate far below the federated cap.
- **Content-filter** on the payload before it reaches a harness — size cap, schema validation, and a prompt-injection sanity pass (cortex already has `src/runner/security-preamble.ts`); public payloads are untrusted input and SHOULD carry a stricter preamble than federated.

### 5.3 What a public peer can observe
**Nothing beyond what you announced.** A public counterparty sees: your entry in the registry public index (the capabilities you chose to announce) and the lifecycle/verdict envelopes for work *it* dispatched to you. It cannot subscribe your `local.*` (never leaves the principal boundary) or your `federated.{me}.…` (no peer entry). The public index is the *only* thing you expose, and `announce_capabilities[]` is the knob — announce narrowly.

### 5.4 The `public.` namespace re-publish
The mechanics of *re-publishing* internal signals onto the `public.` namespace (the broadcast/visibility side) live with the namespace/visibility work tracked under **cortex#21** — **deferred to that issue.** This spec governs the *trust + dispatch + discovery* model of `public`, not the namespace re-publish plumbing. (Flagged in §decisions-needed.)

---

## §6 — Migration / relationship to `federated`

### 6.1 When to use which
- **`local`** — your own stacks. Zero-config.
- **`federated`** — a *known, ongoing* relationship with a named principal (the review loop, a JV, a partner). You both name each other; higher trust; Direct/Delegate available.
- **`public`** — a principal **not in your roster**: a one-off, a marketplace match, a "come find me" capability you offer to the open square. Lower trust; Offer-by-capability only.

`public` is precisely the tier for *principals NOT in your `peers[]`* — it composes with the auto-resolution work (S2/DD-5, federated peers resolved from the registry roster) by **complementing** it: the roster resolves *named* peers; the public index serves *unnamed* counterparties. A principal can be both (a federated peer you also see in the public index), but the gate that admits their traffic is selected by the **subject scope** (`federated.*` → federation gate; `public.*` → public gate), never merged.

### 6.2 Graduating public → federated (recommendation)
A successful public interaction is the natural on-ramp to a federated peering. **Recommendation:** "graduation" is an explicit, principal-initiated act — `cortex network join <network>` to add the counterparty as a named peer (with registry-resolved pubkey) — **not** an automatic promotion. Auto-promoting a public counterparty to a federated peer would let an open-market interaction silently escalate trust; keep the escalation deliberate. The discovery→allowlist handshake (§2.4) is the lightweight public relationship; the federated peering is the heavyweight, mutual, named one.

### 6.3 Leaving
`leave public` (shipped #739): deregister from the index (register with empty caps), unsubscribe `public.>`, clear `policy.public` (gate reverts to deny-all), restart. No federated state is touched (the tiers are disjoint).

---

## §decisions-needed

> These are the open calls the principal must sign off **before** any implementation. The inbound-gate decision (D3) is the load-bearing one.

1. **D1 — Inbound default-deny (confirm).** `public` inbound is OFF unless explicitly opted in, and even when opted in, an **empty allowlist trusts nobody** (the shipped #739 / OQ1 posture). *Recommendation: confirm — keep default-deny; do not relax it in this spec.* **Decision: ?**

2. **D2 — Allowlist-only vs a fully-open mode.** Today the **only** way to admit a public sender is to name them in `allow_principals[]` (no `open_claim`/anonymous flag). This spec recommends **not** adding a fully-open mode until OQ1's abuse story (rate-limit + content-filter + reputation/economics) is designed. *Recommendation: stay allowlist-only; defer fully-open to a dedicated OQ1 follow-up.* **Decision: allowlist-only confirmed? Or is a flagged, rate-limited fully-open mode in scope now? ?**

3. **D3 — The inbound gate chain (⚠️ load-bearing).** Adopt the defense-in-depth chain in §3.1: subscription → `enabled` → allowlist → **capability-scoping (only announced caps)** → identity-verify (posture-dependent) → **rate-limit + content-filter** → principal-only/Offer-only. *Recommendation: adopt all seven; capability-scoping, rate-limit, and content-filter are NET-NEW over #739.* **Decision: which of the NET-NEW gates land in v1 of public dispatch vs a follow-up? ?**

4. **D4 — Capability-announce discovery mechanism.** Discovery = registry public index (`GET /capabilities`, pull, shipped) + `public.system.capability.announced.{capability}` broadcast (push, capability-keyed, NET-NEW). Public Offer routes on `public.tasks.{capability}.{subcapability}` — **by capability, not by named target**. *Recommendation: adopt; keep discovery decoupled from acceptance (announce is free, accept is deliberate).* **Decision: confirm capability-keyed routing + the announce subject shape? ?**

5. **D5 — Identity verification of unknown senders.** Verify a public sender via the **registry-resolved-pubkey-on-demand** path (TC-2a `PrincipalPubkeyResolver`, the same machinery federated peers use), source principal taken from `signed_by[0]`/`envelope.source`. Posture interaction per §4.3: `enforce` fails closed on unresolvable/bad-sig; non-empty public allowlist SHOULD run ≥ `permissive`, MUST run `enforce` for side-effecting announced capabilities (join-time advisory, not a hard block — DD-7). **Decision: confirm resolve-on-demand reuse + the posture advisories? ?**

6. **D6 — Trust-grading public < federated.** Public senders are lower-trust: Offer-by-capability only (no Direct/Delegate to `@{assistant}`), only announced capabilities, read/review/analysis-class by default, side-effecting capabilities never auto-announced to public. *Recommendation: adopt the §3.2 grade table; Direct/Delegate require graduating to federated.* **Decision: confirm no-Direct/Delegate-on-public and the side-effecting opt-in rule? ?**

7. **D7 — Graduation public → federated is explicit, never automatic.** A public interaction does not auto-promote to a federated peering; graduation is a deliberate `network join <network>` (§6.2). *Recommendation: confirm.* **Decision: ?**

8. **D8 — Namespace re-publish boundary.** The `public.` namespace re-publish mechanics are owned by **cortex#21**, not this spec. *Recommendation: confirm the boundary — this spec governs trust/dispatch/discovery; #21 governs namespace re-publish.* **Decision: ?**

---

## Appendix — shipped (#739) vs net-new (this spec)

| Concern | Shipped (S5 / #739) | Net-new (this spec proposes) |
|---|---|---|
| Opt-in surface | `cortex network join/leave public` + `--allow` + `--capabilities` | — |
| `policy.public` block | `enabled` / `allow_principals[]` / `announce_capabilities[]` | — |
| Inbound gate | `evaluatePublicGate` (default-deny, allowlist) | **Capability-scoping**, **rate-limit**, **content-filter** added to the chain |
| Discovery | Registry public index `GET /capabilities` (pull) | `public.system.capability.announced.{cap}` broadcast (push); discovery→allowlist handshake |
| Public dispatch | — (no public Offer path) | **`public.tasks.{cap}.{subcap}` Offer routed by capability**; no Direct/Delegate; verdict-back `public.review.verdict.*` |
| Identity verify | (gate keys on source principal id) | **Registry-resolved-pubkey-on-demand** verification + posture advisories |
| Trust grading | (public ≠ federated peer — disjoint gate) | Explicit grade table; side-effecting opt-in; observe-nothing-beyond-announced |
| Graduation | — | Explicit public → federated on-ramp |
| Namespace re-publish | — | Deferred to **cortex#21** |
