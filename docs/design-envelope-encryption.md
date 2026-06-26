# Design — Envelope Encryption Strategy (M3 Federation Payload Confidentiality)

**Status:** **Accepted** (ratified with Andreas 2026-06-27 — M3 ships in **this** release). **Amended 2026-06-27 — reversed option-3 (sealed-to-recipient) → option-1 (per-network key, network-readable).** Needs explicit testing; the mechanism is **open to feedback during testing**.
**Feature:** M3 federated payload confidentiality · IAW E.7 · TC-3 (folds cortex#369)
**Refs:** cortex#1241 (model reversal), cortex#627 (Trust & Confidentiality umbrella), cortex#369 (TC-3 work item), cortex#1142 (admission gate / leaf-secret — the shared-primitive *and* shared-delivery-channel co-consumer), [ADR-0019](adr/0019-federated-payload-encryption.md) (this decision), [ADR-0018](adr/0018-admission-gate-and-leaf-secret-distribution.md) (leaf-secret distribution — same seal primitive, same channel), [ADR-0013](adr/0013-sovereign-federation-model.md) (sovereign federation), `docs/design-trust-confidentiality.md` (Phase 3), `docs/design-internet-of-agentic-work.md` (federation model §3.x)
**Author:** Architect · ratified with Andreas (2026-06-27)
**Type:** Design — decision document. No feature code in this PR.

> **Amendment note (2026-06-27 — reversed option-3 → option-1 per-network key).** This design originally firmed **option 3 — sealed-to-recipient** (Direct/Delegate sealed to the recipient stack pubkey; Offer left cleartext-but-signed). Andreas **reversed the decision to option 1 — one per-network key**: the confidentiality boundary is the **network** (a trust group), not the recipient. **All** federated payloads (Direct, Delegate, **and Offer**) are sealed with a single per-network AEAD key readable by every admitted member; the key is delivered sealed-to-each-member over the **admission/seal channel** (the same pipe that delivers the leaf secret). The old per-recipient mechanism is **moved to rejected-alternatives with its reason** (§3.2), not silently rewritten. Sections amended in lockstep: TL;DR locks table, §3.2/§3.3 (mechanism + Offer), §5 (key delivery), §5.2 (rotation = revoke), §7 (build slices), §9 (decision table). The driver: per-network key = **zero per-principal config, plug-and-play**, and Offer fan-out for free, at the deliberately-accepted cost of network-wide readability + rekey-on-revoke.

---

## §0 — TL;DR

Cortex signs every envelope (stack NKey / ed25519 over the JCS-canonical `SIGNABLE_FIELDS`). That gives **integrity + authenticity**, not **confidentiality** — payloads are plaintext on the NATS bus and at rest in JetStream. That was fine while the bus *was* the principal's own private mesh. It stops being fine the moment the **community federation tier goes live**: admitting members onto a shared `federated.>` federation would let any **outsider** who obtains the link (another network, the public, a non-member relay/hub) passively read every `federated.>` payload (the residual flagged in `design-admission-gate-leaf-secret.md` §7 Q7). M3 payload confidentiality is the resolution of that residual, and is therefore being **pulled into this release** rather than deferred (CONTEXT.md §222 deferral is hereby reversed).

**The confidentiality boundary is the network, not the recipient.** A network is a deliberately-formed **trust group**: every admitted principal + assistant on it is entitled to read its federated payloads. The threat being closed is the **outsider** (other networks, the public internet, a relay/hub on the transport that is not an admitted member), not the fellow member. Encryption draws the line at the network's edge.

### Ratified locks (2026-06-27, amended same day — option-1 per-network key)

| Lock | Decision |
|---|---|
| **L1 — v1 mechanism = option 1 (§3.2): one per-network key, network-readable** | **All** federated payloads — **Direct, Delegate, AND Offer** — are sealed with one per-network symmetric AEAD key `K`. Every admitted member (principal + assistant) holds `K` and can read every federated payload on the network; encryption protects against **outsiders**, not fellow members. **No per-recipient sealing, no Offer carve-out.** (Reversal of the prior option-3 floor; sealed-to-recipient moved to rejected-alternatives, §3.2.) |
| **L2 — encrypt-then-sign (§4)** | `signed_by` covers the **ciphertext**; the recipient verifies the signature on the sealed form, *then* decrypts. Verify-before-decrypt. **Signing stays per-author** (the `signed_by` chain is per-stack — authenticity; the network key is confidentiality only). |
| **L3 — key delivered over the admission/seal channel** | `K` is delivered **sealed-to-each-member's-registered-pubkey** (ed25519→X25519 + `crypto_box_seal`) over the **same admission/seal channel that delivers the leaf secret**. **No new ceremony, no out-of-band shared-secret handoff, no new distribution channel.** Per-author signing keys are untouched. |
| **L4 — shared seal primitive** | The key-delivery seal (ed25519→X25519 + `crypto_box_seal`) is the **same** primitive the leaf-secret distribution (ADR-0018, option b′) uses, on the **same channel**. Both MUST consume **one shared `seal-to-principal` module** (§3.4). |
| **L5 — opt-in per network, transition window; easy automated rekey-on-revoke** | A per-network `encryption` flag in `policy.federated.networks[]`; during transition a member **accepts both** cleartext-but-signed and sealed payloads; federating without it emits a **loud-but-not-fatal** warning. Transport revoke is per-member + immediate (drop leaf PSK); **read-revocation = a one-command, automated network-key rotation** (mint `K'`, re-seal to remaining members, auto-refresh). |

This doc records:

1. **Two layers, two jobs.** Wire-layer confidentiality (`tls://` leaf-nodes) protects bytes in transit; **payload-layer confidentiality** (the per-network key) protects content *from outsiders who obtain the link but are not admitted members* — including a relay/hub that is on the transport without being a member. TLS does not solve the federation threat alone; both layers are needed; they are independent.
2. **Per-network-key sealed-payload pattern.** Encrypt `payload` (and only `payload`) with the network's symmetric AEAD key `K` (XChaCha20-Poly1305). `K` is **delivered to each admitted member sealed to that member's registered pubkey** (ed25519→X25519 + libsodium `crypto_box_seal`) over the admission/seal channel — **no new long-term key material per dispatch, no certs, no per-recipient resolution on the publish path**. All envelope metadata (`sovereignty`, `source`, `type`, `correlation_id`, `target_assistant`, `signed_by[]`, `originator`, `distribution_mode`, `requirements`) stays cleartext so the bus routes and verifies exactly as today.
3. **Encrypt-then-sign: the existing `signed_by` chain signs the envelope *as it goes on the wire* — i.e. over the ciphertext.** Signing stays **per-author** (per-stack). The recipient verifies the signature on the sealed form, then decrypts with `K`. Recommendation + justification in §4.
4. **Scope-gated.** `local.` (intra-principal) needs **no** payload encryption — the bus is the principal's own trust domain. `federated.` / `public.` are the encryption surface. Encryption is a function of `sovereignty.classification`.
5. **Opt-in, never default.** Signing-only stays the out-of-box posture (ratified in cortex#369). Cortex must stay trivially deployable with zero cert/key ceremony. Encryption is enabled per network, with a transition window that accepts both cleartext and sealed payloads, and a loud-but-not-fatal warning when a stack federates without it.

The single most consequential decision in this doc is **#2 — a single per-network key, delivered over the admission/seal channel, as the v1 mechanism.** The network is the confidentiality boundary because it is a trust group; per-recipient sealing (the rejected option 3, §3.2) is not the v1 default because it gives per-addressee privacy the trust-group model does not need, cannot cover Offer fan-out without a cleartext carve-out, and forces per-principal key resolution that does not scale. The per-network key buys **zero-per-principal-config, plug-and-play** federation and trivial Offer coverage, at the deliberately-accepted cost of network-wide readability + rekey-on-revoke.

---

## §1 — Threat model: what changes at the principal boundary

### §1.1 What ships today

- Every envelope is signed: the **stack** signs via `runtime.publish` using the stack NKey (ed25519 seed) over the JCS-canonical `SIGNABLE_FIELDS` (`signEnvelope` in `@the-metafactory/myelin/identity`; chain normalised by `getSignedByChain` in `src/bus/myelin/envelope-validator.ts`).
- `signed_by[]` is a **chain of stamps** — each stamp covers the prior chain, so tampering with an earlier stamp invalidates every later one.
- `originator` (myelin#161) is *inside* the signature — policy attribution is attestable.
- `sovereignty.classification ∈ {local, federated, public}` gates **routing** (which subjects an envelope may travel on, M1 leaf-node enforced) — it does **not** gate readability. A `federated` envelope is fully readable to any peer on that network.

The security property today is: **anyone with subscribe access to a subject reads the full payload.** Within one principal's private mesh that set is exactly "the principal's own stacks" — acceptable. The signature stops forgery, not reading.

### §1.2 What changes when a payload crosses the public internet (NZ ↔ Switzerland)

In Phase E, principal `andreas` (NZ) and principal `jcfischer` (Switzerland) peer their NATS servers via leaf-nodes (`docs/design-internet-of-agentic-work.md` §3.3). A dispatch from `andreas` to `jcfischer`'s `code-review.typescript` capability travels `federated.{principal}.{stack}.tasks.…` across that leaf-node link. The new adversaries are:

| Adversary | Position | Can they read the payload today? | What stops them |
|---|---|---|---|
| **Network path** (transit ISPs, internet between NZ and CH) | On the wire between leaf-nodes | Yes, if the link is plain `nats://` | **Wire layer:** `tls://` leaf-node — §2 |
| **Non-member relay / hub host** | Runs a shared hub all members connect through but is **not itself an admitted member** of the network | Yes — TLS terminates at the hub; the hub sees plaintext | **Payload layer:** the per-network key — TLS does NOT help; the hub is an authorized TLS peer but not a network member, so it lacks `K` |
| **Outsider on the transport** (another network, the public, a captured/leaked leaf PSK held by a non-member) | Can reach `federated.>` bytes without being an admitted member | Yes — sovereignty gates routing, not reading; bytes are cleartext | **Payload layer:** the per-network key `K` — only admitted members hold it — §3 |
| **Fellow admitted member** (another principal/assistant on the **same** network) | Authorized member of the network's trust group | Yes — and **by design** still can: the network is the readership boundary | **Not a threat the model closes.** Members are mutually admitted; per-recipient privacy *within* a network is explicitly out of scope (the deliberate tradeoff, §0 / §3.2) |
| **At-rest reader** (JetStream files on disk) | Filesystem on the retaining node | Yes — JetStream persists payloads on disk | Out of scope for the *bus*: filesystem encryption (LUKS/FileVault) is principal infra. The per-network key *also* protects at-rest against a **non-member** that captures the files but lacks `K` — §6 |

The load-bearing insight: **the threat is the outsider, not the fellow member.** A network is a deliberately-formed trust group; its admitted members are entitled to read its payloads. TLS authenticates and encrypts the *link*; it cannot keep content from a hub that is on the link but is not a member. Only payload-layer encryption with a key **held by exactly the network's members** removes a non-member hub's, and any outsider's, ability to read federated content — while keeping it readable to every member with zero per-recipient ceremony.

### §1.3 What MUST stay cleartext (routing + trust invariants)

The bus routes and verifies on envelope metadata *before any application code runs*. These fields are encryption-exempt by construction:

| Field | Why it must stay cleartext |
|---|---|
| **subject** (`{scope}.{principal}.{stack}.{domain}.…`) | NATS routes on the subject string; leaf-nodes filter on it. Not part of the envelope body — it is the transport addressing. |
| `sovereignty` (`classification`, `data_residency`, `max_hop`, `frontier_ok`, `model_class`) | `validateSubjectEnvelopeAlignment` checks `classification` vs subject prefix at parse time; leaf-node hop budgets read `max_hop`; data-residency policy reads `data_residency`. All pre-decryption. |
| `signed_by[]` | Chain-of-stamps verification (`verifySignedByChain`, Phase B) runs on inbound *before* the recipient is even known to want the payload. Hop counting (`signed_by[].length` vs `max_hop`, Plan D.2.3) reads it. |
| `originator` | PolicyEngine resolves the policy actor (`getActorPrincipal`) pre-dispatch. Must be readable + signed. |
| `target_assistant` / `target_principal` | Direct/Delegate routing reads it to pick the recipient (and, for sealed payload, to pick the *encryption recipient* — §3). |
| `correlation_id`, `id`, `source`, `type`, `timestamp` | Correlation, dedup, audit, dispatch-sink reply routing all read these without the payload. |
| `distribution_mode`, `requirements`, `deadline`, `sovereignty_required` | Offer/Direct/Delegate selection + capability filtering happen at the JetStream consumer, pre-decryption. |
| `economics` | Already explicitly a *mutable, non-security* annotation (myelin architecture.md §5.2) — hubs aggregate cost; cannot be sealed. |

**What gets encrypted is exactly one field: `payload`** — the task content, the chat text, the dispatch body. Everything the bus needs to route, verify, gate, and account stays in the clear and stays signed.

---

## §2 — Wire layer: when to mandate `tls://`

Wire-layer TLS is **principal infrastructure**, not cortex code (M1 in the stack — `docs/design-internet-of-agentic-work.md` §1: "assume authenticated, encrypted, ordered byte streams"). The design position:

- **Single-stack / private mesh (`policy.federated.networks: []`):** `tls://` optional. The bus never leaves the host (or a firewalled LAN). Mandating TLS here is exactly the cert ceremony cortex#369 forbids out of the box.
- **Any federated leaf-node link:** `tls://` **strongly recommended and warned-on if absent.** A plain `nats://` leaf-node carrying `federated.>` across the public internet exposes payload *and* metadata to the network path. Cortex should emit a startup `system.error`-class warning (loud, non-fatal) when a `policy.federated.networks[].leaf_node` resolves to a non-TLS connection. This mirrors the §6 "federating without encryption" warning and uses the same warning channel.
- **Composition with leaf-node federation:** TLS is per-link, terminated at each leaf-node (and at any intermediary hub). It protects the hop, not the multi-hop path through a hub. This is *precisely* why §3 payload encryption is independent of and additive to TLS: TLS protects against the network path; the per-network key protects against a **non-member hub** and any **outsider** on the transport (a fellow member is, by design, a permitted reader — §1.2).

**Decision:** TLS is an operational mandate documented in the federation setup SOP and warned-on at runtime; it is not enforced in code (cortex does not own M1). It is **necessary but not sufficient** for the federation threat — §3 is the part cortex owns.

---

## §3 — Payload layer: the per-network-key sealed-payload pattern

### §3.1 Mechanism

Encrypt the `payload` field with the **network's symmetric AEAD key `K`**, leave all metadata cleartext, sign **per-author** as today.

**Key model — one key per network, held by every member.** Each network has a single symmetric AEAD key `K` (256-bit, used with XChaCha20-Poly1305). Every admitted member (each principal + assistant on the network) holds `K`. A publisher seals `payload` with `K`; any member decrypts with `K`. There is no per-recipient key resolution on the publish path — the publisher already holds `K`.

**Key delivery — sealed to each member over the admission/seal channel (no new ceremony).** `K` is *not* placed on the bus in clear and *not* handed off out of band. When a member is admitted, the network coordinator seals `K` **to that member's already-registered ed25519 pubkey** (ed25519→X25519 + libsodium `crypto_box_seal`) and delivers it over the **same admission/seal channel that delivers the per-member leaf secret** (ADR-0018 option b′). This reuses the `seal-to-principal` primitive and the existing pipe:

- **No certs, no new long-term per-dispatch key material.** Per-author signing keys are untouched; the only added key is the per-network `K`, and `K` is delivered using identities already in the registry.
- **No new distribution channel.** `K` rides the admission/seal channel — the same one that already delivers the leaf secret.
- **No out-of-band handoff.** Admission delivers `K`; rotation re-delivers `K'` the same way; members auto-refresh.

**Sealed envelope shape.** The encrypted form replaces the cleartext `payload` body with a sealed container and marks it via an `extensions` flag (the schema already carries `extensions?: Record<string, unknown>` for exactly this kind of forward-compatible metadata):

```jsonc
{
  // ... all cleartext metadata unchanged: id, source, type, sovereignty,
  //     correlation_id, target_assistant, distribution_mode, originator, ...
  "extensions": {
    "enc": {
      "alg": "xchacha20poly1305",          // AEAD scheme id (versioned)
      "net": "research-collab",            // network id — selects which K
      "kid": "research-collab/k-2026-06-27" // network-key id (epoch) — survives rotation
    }
  },
  "payload": {
    "ciphertext": "<base64 AEAD ciphertext>",
    "nonce": "<base64 nonce>"
  }
}
```

- `payload` stays a JSON object (schema-valid: `payload: Record<string, unknown>`), now carrying ciphertext instead of cleartext domain data — no schema change required to ship the *transitional* form.
- `extensions.enc` declares the scheme + the **network key id** (`kid`, carrying the rotation epoch) so a member selects the right `K` to decrypt with (current or, within the grace window, previous), and a non-member knows it lacks the key. `alg` and `kid` are versioned so the scheme and key can evolve.
- The AEAD's associated-data binds the ciphertext to the cleartext metadata (at minimum `id` + `type` + `sovereignty.classification`) so a hub cannot lift one ciphertext onto a different envelope header.

### §3.2 Why one per-network key (network-readable) over sealed-to-recipient as the v1 mechanism

> **Amended 2026-06-27 — reversed.** This section originally argued sealed-to-recipient as the v1 default. The decision was reversed to the per-network key; the prior mechanism is recorded as the rejected alternative below, with its reason.

The confidentiality boundary is the **network** (a trust group), not the recipient. The comparison:

| | **Per-network key `K`** ← chosen v1 | Sealed-to-recipient (X25519 to stack pubkey) — *rejected* |
|---|---|---|
| Confidentiality boundary | The **network** (trust group): readable by every admitted member, opaque to outsiders | The single addressed recipient stack |
| Per-publish key resolution | **None** — publisher already holds `K` | Per-recipient pubkey lookup on every federated publish |
| Per-principal config | **Zero** — admitted once, receive `K` over the admission/seal channel; plug-and-play | Per-recipient resolution; scales poorly to large networks |
| Fits Direct/Delegate | Yes (seal with `K`) | Yes (single named recipient) |
| Fits Offer (no named recipient) | **Yes, trivially** — any capable member holds `K` and decrypts a claimed Offer; **no cleartext carve-out** | **No** — cannot seal to an unknown claimant; forces an Offer-cleartext carve-out |
| Key delivery | Sealed to each member over the admission/seal channel (reuses the leaf-secret pipe) | Registry pubkey per recipient |
| Read-revocation | **Network-key rotation** (mint `K'`, re-seal to remaining members) — automated one-command rekey (§5.2) | Stop sealing to that recipient |
| Within-network privacy | **None** (deliberate — members are mutually admitted) | Per-addressee |

The per-network key wins on the properties the community tier needs on day one: **zero per-principal configuration** (a member is admitted once and receives `K` over the channel that already delivers their leaf secret), **plug-and-play** federation (no per-recipient resolution on the publish hot path), and **trivial Offer fan-out** (the network key covers a capability claim by any member, so the option-3 Offer-cleartext carve-out is removed). Its costs — network-wide readability and rekey-on-revoke — are accepted deliberately (§0, §5.2): a network is a trust group, so per-addressee privacy between members protects against a threat the admission gate already excludes.

**Rejected alternative — sealed-to-recipient (the previously-ratified option 3).** Each Direct/Delegate `payload` sealed to the recipient stack's registered pubkey (X25519 derived from `principal_pubkey`), Offer left cleartext-but-signed. **Reversed because:** (a) it gives per-addressee confidentiality the trust-group model does not require; (b) it cannot cover **Offer** fan-out (no named claimant at publish) without leaving Offer cleartext — a real confidentiality gap the per-network key closes for free; (c) it forces per-recipient key resolution on every federated publish, i.e. **per-principal configuration that does not scale**. Recorded here for the reversal trail, not deleted.

### §3.3 Offer mode (capability fan-out) under the per-network key — no carve-out

> **Amended 2026-06-27.** Under option 3 this section was the hard case (Offer had no named recipient to seal to, so it was left cleartext). The per-network key **dissolves the problem**: there is no carve-out.

In **Offer** mode the envelope is published to a *capability* (`tasks.{capability}.{subcapability}`), and **any** capable assistant on the network may claim it via the JetStream queue group (competing consumers, exactly-once delivery). At publish time the publisher does **not** know which stack will claim — but it does not need to: the publisher seals with the **network key `K`**, and **whichever member claims the Offer already holds `K`** and decrypts. No candidate enumeration, no registry lookup on the hot path, no envelope growth with N wrapped keys, no late-joiner replay problem. **Offer payloads are sealed exactly like Direct/Delegate** — all three federated dispatch modes use `K`.

**LOCKED (L1, ratified 2026-06-27; amended same day):** ship the **per-network key** as the v1 mechanism for **all** federated dispatch modes — Direct, Delegate, **and Offer**. The prior option-3 floor (Offer cleartext-but-signed; confidential work requires a named recipient) is **superseded** — there is no longer an Offer-cleartext carve-out, because the network key seals fan-out trivially. Seal-to-all-candidates (the old option 2) is **moot**: the per-network key achieves "any capable member can read" without enumerating candidates. This closes the §7-Q7 cleartext residual for **every** federated mode.

### §3.4 — The shared `seal-to-principal` primitive (design constraint L4)

The seal used to **deliver the network key `K`** is **not** unique to payload confidentiality. The leaf-secret distribution design ([ADR-0018](adr/0018-admission-gate-and-leaf-secret-distribution.md), option **b′**) seals the per-member NATS leaf PSK to the admitted joiner's *already-registered* ed25519 pubkey using the identical construction: **ed25519→X25519 conversion + libsodium `crypto_box_seal` (sealed box / anonymous-sender)** — over the **same admission/seal channel**. Two payloads, one cryptographic operation, one channel:

| Consumer | Seals what | To whom | Over which channel |
|---|---|---|---|
| **M3 network-key delivery** (this doc) | the per-network payload key `K` | each admitted **member's** registered pubkey | the admission/seal channel |
| **Leaf-secret distribution** (ADR-0018 b′) | the per-member leaf PSK | the admitted **joiner's** registered pubkey | the admission/seal channel |

> Note the shift from the original design: under option 3 the M3 consumer sealed the *envelope `payload`* to the *recipient* on the hot path. Under the per-network key, the `seal-to-principal` primitive is used only to **deliver `K` at admission/rotation time** — not per-envelope. The per-envelope seal of `payload` is a **symmetric AEAD with `K`** (no `crypto_box_seal` on the publish path), which is cheaper and removes per-recipient resolution from every federated publish.

**Constraint:** both MUST consume **one shared `seal-to-principal` module** — a single implementation of `sealTo(recipientEd25519Pub, plaintext) → sealedBlob` and `openSealed(ownSeed, sealedBlob) → plaintext`, with the ed25519→X25519 derivation in exactly one place. Two independent implementations of "seal to a registered pubkey" is a security-review and key-derivation-divergence hazard (a subtle difference in the conversion or the AEAD construction between the two call sites is the kind of bug that ships silently and breaks interop or confidentiality). This is the myelin primitive filed in §7(2); ADR-0018's build slice and this doc's TC-3 slice both depend on it landing **once**.

> Difference in *shape*, not *primitive*: M3 uses the shared seal to wrap `K` for delivery (an opaque sealed blob over the admission/seal channel, like the leaf secret) and then seals each `payload` symmetrically with `K` (carried in `extensions.enc` + ciphertext-in-`payload`, §3.1, with AEAD associated-data binding to the envelope header). The seal/open core is shared for key *delivery*; the per-envelope symmetric AEAD is M3-specific and layered on top.

---

## §4 — Interaction with signing: sign-then-encrypt vs encrypt-then-sign

The existing `signed_by` chain signs the **envelope as it goes on the wire**. The question is *what bytes the wire-going signature covers* once `payload` is sealed: the plaintext payload, or the ciphertext?

**LOCKED (L2, ratified 2026-06-27): encrypt-then-sign — the stack seals `payload` with `K`, then `signEnvelope` signs the SIGNABLE_FIELDS over the *sealed* envelope (ciphertext in `payload`, `extensions.enc` present).** I.e. the wire signature covers the ciphertext, not the plaintext. **Signing stays per-author** — the `signed_by` chain is per-stack (each handler signs with its own NKey); the network key only confines *readership*, never authorship.

Justification:

1. **Verify-before-decrypt is the safe order.** The recipient (and every hub / forwarding stack in the chain) must verify the chain-of-stamps and the sovereignty alignment *before* doing any work — including before decrypting. If the signature covered plaintext, a non-member forwarder could not verify what it forwards (it lacks `K`, so can't decrypt), and a member recipient would have to decrypt untrusted bytes before checking the signature. Signing the ciphertext lets every party verify integrity + authenticity + hop budget on exactly the bytes they hold, with no decryption capability required. This matches the cryptographic-doom-principle guidance: authenticate the ciphertext, then decrypt.
2. **The chain stays meaningful across hops; authorship is per-author.** Forwarding stacks append stamps (`signed_by[N]`) without ever needing to decrypt (and a non-member forwarder *cannot* decrypt — it lacks `K`). **Authenticity is the per-author signature chain**, not the AEAD: the `signed_by[]` chain proves *who authored and who handled* the envelope. The AEAD tag (with associated-data binding ciphertext to the envelope header) proves the ciphertext was sealed **by a holder of `K`** — i.e. by *a member of the network* — and is bound to *this* header; it does **not** by itself single out the author (any member holds `K`). The two properties are complementary and independent: the per-author chain attests authorship; the network-key AEAD attests "sealed by a member, for this network, bound to this header." This is the deliberate consequence of the trust-group model.
3. **`signed_by` semantics don't change.** SIGNABLE_FIELDS already includes `payload` — by sealing `payload` *before* signing, the existing canonicalize + `signEnvelope` path needs **no change to what it signs**; it just happens to be signing ciphertext. `extensions` is the one field to confirm is inside SIGNABLE_FIELDS (so `extensions.enc` is tamper-evident); if it is not today, adding it is the single myelin-side change this composition needs (filed as a myelin primitive — §7).
4. **`originator` stays signed + cleartext.** Policy attribution is unaffected: `originator` is metadata, encrypted-exempt (§1.3), and already in SIGNABLE_FIELDS.

The rejected alternative, sign-then-encrypt (sign plaintext, then encrypt the signed blob), breaks hop-verification and the chain-of-stamps model: intermediaries could not verify, and the cleartext routing fields would either be encrypted (breaking routing) or live *outside* the signature (breaking tamper-evidence). Encrypt-then-sign is the only option compatible with cortex's existing cleartext-metadata + chain-of-stamps architecture.

**Net:** the stack's publish path becomes `sealWithK(payload) → signEnvelope(sealed) → publish`. The recipient (member) path becomes `verifyChain(sealed) → checkSovereignty(sealed) → decryptWithK(payload) → dispatch`. Verification is unchanged in *mechanism* and stays per-author; it simply runs against ciphertext.

---

## §5 — Key delivery: the network key rides the admission/seal channel

> **Amended 2026-06-27.** Under option 3 there was no shared secret to deliver — recipients derived each other's enc-pubkey from the registry. Under the per-network key, there **is** one secret per network (`K`), and it is delivered to each member by **sealing it to the member's registered pubkey over the admission/seal channel** — the same primitive + pipe that delivers the leaf secret. The registry still serves *public* keys (used to seal `K`); `K` itself never transits the registry or the bus in clear.

The Phase D network registry (`src/services/network-registry/`, D.4) supplies the **public** keys the seal targets:

- Principals **register** a signed claim carrying `principal_pubkey` (ed25519), their `stacks`, and `capabilities` (IAW D.4.2, `principals.ts`). The registry verifies the principal's self-signature, enforces clock-skew + nonce replay protection, and stores the record.
- Peers **GET `/principals/{id}`** and receive a `SignedAssertion` — the registry signs the response so a caller verifies provenance before caching (`signAssertion`).
- Cortex consumes the registry at startup + on a refresh schedule (D.4.3 `RegistryClient`, the consumer follow-up).

**For the per-network key this means:**

- The network coordinator seals `K` **to each member's `principal_pubkey`** (ed25519→X25519 + `crypto_box_seal`, the shared §3.4 primitive) and delivers the sealed blob over the **admission/seal channel** — the same channel ADR-0018 uses to deliver the leaf secret. A member opens it with its own seed. **No out-of-band shared-secret handoff, no new channel.**
- **`K` is never a registry artifact and never transits the bus in clear.** The registry holds only *public* keys (used as seal targets). `K` exists only inside the sealed blobs delivered to members and in member memory.
- An admitted member receives `K` **at admission time**; on rotation the new `K'` is re-sealed to every remaining member and re-delivered the same way; members **auto-refresh**.

### §5.1 Per-network, and the member is the unit

The encryption unit is the **network** (one `K` per network) and the *holder* is the **stack** (`did:mf:{principal}-{stack}`) on behalf of its assistants. Rationale: the stack is the cryptographic signer (CONTEXT.md "Adapter signs as agent → stack signs"); it already holds the seed `K` is sealed to; it is the unit the registry tracks (`claim.stacks`). A member stack holds `K`, decrypts inbound federated payloads once, then routes plaintext to the right local assistant (intra-principal = `local.`, no further encryption — §6). Per-assistant keys are not used — within a principal everything is already trusted, and `K` is a *network*-scoped key, not a per-addressee one. **Decision: one `K` per network, held by each member stack; assistants do not hold separate encryption keys.**

### §5.2 Rotation = the revoke mechanism (easy, automated)

> **Amended 2026-06-27.** Under option 3, rotation rode the signing-key transition claim (the enc-key derived from it). Under the per-network key, **rotation is its own operation and is the read-revocation mechanism** — and it MUST be a one-command, automated network rekey, not a per-member chore.

Two distinct revoke actions, do not conflate them:

| Action | Scope | Speed | How |
|---|---|---|---|
| **Transport revoke** | One member's *link* | **Immediate** | Drop that member's leaf PSK (ADR-0018) — their leaf link is gone; they receive nothing new. Per-member, no network impact. |
| **Read-revoke** | One member's *ability to decrypt new payloads* | Effective on next publish after rekey | **Rotate the network key** — mint `K'`, re-seal to every *remaining* member over the seal channel, members auto-refresh. The revoked member, holding only `K`, cannot read payloads sealed with `K'`. |

| Step | Action |
|---|---|
| **Who rotates** | The **network coordinator** (the admin role that runs admission). Rotation is a network-level operation, not a per-stack one. |
| **How** | One command mints a fresh `K'` (new `kid`/epoch), **re-seals `K'` to every remaining member's registered pubkey** (shared §3.4 primitive), and delivers it over the admission/seal channel. This is the **automated, one-command rekey** — not a per-member chore. Members receive `K'` and auto-refresh; new publishes seal with `K'` (the `kid` in `extensions.enc` selects it). |
| **How members re-key** | A member receives the sealed `K'` over the channel it already listens on for admission/seal traffic, opens it with its own seed, and adds `K'` to its keyring (retaining `K` for the grace window). No registry round-trip required. |
| **In-flight envelopes** | An envelope sealed with the *old* `K` remains decryptable only with `K`. Members **retain the previous `K` for a grace window** (≥ JetStream `max_age`, default 7d) to decrypt in-flight + replayed envelopes, keyed by the `kid` in `extensions.enc`, then drop it. |
| **Compromise** | A compromised member (its seed) can read everything sealed with the current `K`, retroactively for retained streams. Response: **transport-revoke immediately** (drop its leaf PSK) **and rotate** `K`→`K'` (re-seal to the rest). Rekey-on-compromise is the deliberate cost of the per-network model (§0 tradeoff); it is mitigated by making rotation trivially automated. |

The rotation/revoke SOP is documented in the federation setup SOP (companion to the §2 TLS guidance). The network coordinator's rekey command and the member auto-refresh are the load-bearing build items for read-revocation (TC-3.4).

---

## §6 — Scope-gating: encryption as a function of `sovereignty.classification`

Encryption is driven by the field that already exists for exactly this kind of scope decision:

| `sovereignty.classification` | Subject prefix | Encrypt payload? | Rationale |
|---|---|---|---|
| `local` | `local.{principal}.{stack}.…` | **No** | Never leaves the principal boundary (M1 leaf-node enforced). The bus is the principal's own trust domain; sealing intra-principal traffic adds cost + key ops for zero threat reduction. This is also what keeps the out-of-box single-stack deployment encryption-free. |
| `federated` | `federated.{principal}.{stack}.…` | **Yes, when the network has encryption enabled** — all modes (Direct/Delegate/Offer), sealed with `K` | Crosses to other principals; an outsider / non-member hub is the threat (§1.2). |
| `public` | `public.…` | **N/A in v1 / case-by-case** | Public is unrestricted by definition. Public-mesh is out of scope across IAW phases (`plan` §Phase E E.4.3 is a reserved stub); the default public posture is cleartext. |

The decision predicate is mechanical and lives next to the existing alignment check: `validateSubjectEnvelopeAlignment` already proves `classification` matches the subject prefix; the encryption gate is "if `classification === 'federated'` **and** the resolved network has `encryption: required|enabled`, then seal the `payload` with that network's `K`." No per-recipient condition — Direct, Delegate, and Offer are all sealed with the network key. Everything keys off fields already on the envelope and the network's `K` already in the member's keyring.

**Interaction with heartbeat (cortex#361) + originator (myelin#161):** both are **metadata, not payload**. Heartbeat / liveness envelopes and the `originator` field stay **cleartext and signed** — they must remain readable to the bus, hubs, and the dashboard for liveness + attribution + audit. They are encryption-exempt by the §1.3 rule. Nothing in this design touches them beyond confirming they stay in the clear.

---

## §7 — Phased rollout

Encryption is an **additive Phase E slice (E.7)** layered on top of Phase D federation. It does not block any earlier phase and does not change the wire for non-encrypting deployments.

### Decision (ratified posture, 2026-06-27; amended same day — option-1 per-network key — cortex#1241 / #627 / #369)

- **Signing-only stays the out-of-box default.** A stack with `policy.federated.networks: []` or no `encryption:` key never touches encryption code. M3 is **opt-in per network**, not an unconditional new requirement.
- **M3 ships in THIS release** (reversing the CONTEXT.md §222 deferral) because the **community federation tier goes live now** — admitting members onto a cleartext `federated.>` mesh that an outsider can read is the threat M3 closes.
- **One per-network key (network-readable) is the v1 mechanism** (L1) — **all** federated modes (Direct/Delegate/Offer) sealed with `K`. The previously-ratified per-recipient option-3 floor is **reversed** (recorded as rejected, §3.2); there is **no Offer cleartext carve-out**.
- **Encrypt-then-sign, signing stays per-author** (L2); **key delivered over the admission/seal channel** (L3); **one shared `seal-to-principal` primitive with ADR-0018 b′ on the same channel** (L4); **opt-in per network with a both-accepted transition window + loud warning, and easy automated rekey-on-revoke** (L5).
- **Read-revocation = network-key rotation** (§5.2); transport revoke stays per-member/immediate.

### What this release ships vs. defers

**Ships (this release — the community-tier mechanism):**

- Per-network-key `K` sealing of `payload` for **all** `federated.*` dispatch modes — **Direct, Delegate, AND Offer** (L1).
- The shared `seal-to-principal` module (ed25519→X25519 + `crypto_box_seal`), consumed by **both** M3 (to deliver `K`) and ADR-0018 leaf-secret sealing (L4), over the same admission/seal channel.
- Network-key delivery: seal `K` to each member's registered pubkey at admission; auto-refresh on rotation (§5).
- AEAD associated-data binding ciphertext → cleartext header (`id` + `type` + `sovereignty.classification`, §3.1); `extensions.enc` carries `net` + `kid` (rotation epoch).
- The per-network `encryption: off|enabled|required` flag + the **both-accepted transition window** + the **loud-but-not-fatal** "federating in the clear" warning (L5).
- Decrypt-on-receive after verify; the multi-hop verify-before-decrypt property (§4).
- **One-command automated network-key rotation** = the read-revocation mechanism; grace window for in-flight (§5.2).

**Defers (post-this-release):**

- **Per-recipient confidentiality *within* a network** — explicitly out of scope by the trust-group model (not a gap; a deliberate non-goal, §0 / §3.2).
- **Public-mesh encryption** (out of scope across IAW phases).
- **At-rest field encryption** — principal infra (OS-FDE); the network key gives incidental at-rest protection against a **non-member** that captures the stream (§6).

### Build slices (TC-3 breakdown)

| Slice | Scope | Depends on |
|---|---|---|
| **TC-3.0** | Shared `seal-to-principal` myelin primitive: `deriveCurve25519From{Seed,Pubkey}`, `sealTo`, `openSealed`. One module, two consumers (M3 network-key delivery + ADR-0018 b′ leaf-secret). | myelin (§7 items 1–2) |
| **TC-3.1** | `sealPayload(envelope, networkKey) → sealedEnvelope` + `openPayload(sealedEnvelope, networkKey) → envelope` — symmetric AEAD with `K`, the §3.1 `extensions.enc` (`net`+`kid`) shape + AEAD associated-data binding. | TC-3.0; confirm `extensions` ∈ SIGNABLE_FIELDS (§7 item 3) |
| **TC-3.2** | Network-key lifecycle: mint `K`, **deliver `K` sealed-to-each-member over the admission/seal channel** (reusing TC-3.0), member keyring (current + grace-window previous), keyed by `kid`. | TC-3.0; admission channel (ADR-0018) |
| **TC-3.3** | Publish + receive paths: publish `sealWithK → signEnvelope(sealed) → publish` for **all** federated modes when the network has `encryption: enabled|required`; receive `verifyChain → checkSovereignty → openPayload(K) → dispatch`; accept both cleartext + sealed in `enabled`, reject cleartext `federated` in `required` (Q6 → §8). | TC-3.1, TC-3.2; TC-2a/2b (registry client + multi-principal registry) |
| **TC-3.4** | Config + posture + revoke: `encryption` flag in `policy.federated.networks[]`; loud-but-not-fatal warning when federating with `encryption: off` or non-TLS; transition-window flip runbook; **one-command automated network-key rotation** (= read-revoke) with member auto-refresh. | TC-3.3 |

### Config surface (one additive field)

```yaml
policy:
  federated:
    networks:
      - id: research-collab
        leaf_node: nats-leaf-research
        encryption: required        # off (default) | enabled | required
        # off      — never seal (today's behavior; warn when federating)
        # enabled  — seal all federated.* (Direct/Delegate/Offer) with the network key K;
        #            cleartext fallback accepted on read (transition window)
        # required — seal all federated.* with K; reject inbound cleartext federated payloads
        # The network key K itself is NOT config — it is delivered to each member sealed
        # to their registered pubkey over the admission/seal channel (§5), never in YAML.
        peers: [ ... ]              # existing D.1.1 schema
```

### Transition window (accept both)

During rollout a network member must **accept both** cleartext-but-signed and sealed payloads on inbound (`encryption: enabled` mode), keyed off the presence of `extensions.enc`. Once all members confirm, the coordinator flips the network to `encryption: required` (reject inbound cleartext `federated` payloads). Mirrors the dual-read transition windows already pervasive in the envelope (R2/R11/R13 vocab migrations, `target_assistant`/`target_principal`, `offer`/`broadcast`).

### Loud-but-not-fatal warning

When a stack opens a `federated` leaf-node link with `encryption: off` (or a non-TLS link, §2), cortex emits a startup warning via the **system event channel** (`system.error`-class, non-fatal — same channel as the §2 TLS warning). It does not refuse to start (that would break the out-of-box ergonomic) but it is visible in the dashboard + logs. "You are federating in the clear" is a posture the principal should *choose*, not stumble into.

### v1 vs later

| | v1 (this slice, E.7) | Later |
|---|---|---|
| Wire TLS | Documented mandate + runtime warning (§2) | — |
| Sealed payload, **all federated modes (Direct/Delegate/Offer), per-network key `K`** | ✅ | — |
| Network-key delivery over admission/seal channel | ✅ (reuses leaf-secret pipe) | — |
| Scope-gating (`federated` only) | ✅ | — |
| Read-revocation = automated one-command network-key rotation; grace window | ✅ | — |
| Offer-mode confidentiality | ✅ (covered by `K`, no carve-out) | — |
| Per-recipient confidentiality *within* a network | Out of scope (trust-group model — deliberate non-goal) | Not planned |
| Public-mesh encryption | Out of scope | Post-IAW |

### myelin primitives to file upstream (§7 → myelin#NN)

Encryption touches the identity/crypto layer that myelin owns. File as a separate myelin issue once this design lands (per cortex#369 process):

1. **Shared `seal-to-principal` module** in `@the-metafactory/myelin/identity` — the ed25519 → X25519 derivation helper (`deriveCurve25519From{Seed,Pubkey}`) **plus** the core `sealTo(recipientEd25519Pub, plaintext) → sealedBlob` / `openSealed(ownSeed, sealedBlob) → plaintext` (`crypto_box_seal`). This is the **one** module both M3 (to deliver the network key `K` to members, §5) and ADR-0018's leaf-secret sealing (option b′) consume (L4, §3.4), over the **same admission/seal channel**. Derivation lives in exactly one place so cortex, members, and the leaf-secret path derive identically.
2. **`sealPayload(envelope, networkKey) → sealedEnvelope`** and **`openPayload(sealedEnvelope, networkKey) → envelope`** — the M3-specific **symmetric AEAD** wrapper (XChaCha20-Poly1305 with the per-network `K`) that produces the §3.1 `extensions.enc` shape (`net` + `kid`), with AEAD associated-data binding to envelope header fields. (This is *not* `crypto_box_seal` — that primitive (1) is used only to **deliver `K`**, not per-envelope.)
3. **Confirm `extensions` is inside SIGNABLE_FIELDS** (so `extensions.enc` is tamper-evident under the existing signature). If not, add it — this is the one change the encrypt-then-sign composition (§4) depends on.
4. **Network-key lifecycle helpers** — mint `K`, seal-to-each-member (via (1)), member keyring keyed by `kid` (current + grace-window previous), and the **one-command network rekey** that re-seals `K'` to remaining members (the read-revoke path, §5.2).

---

## §8 — Open questions for the principal (+ JC)

> **Ratification status (2026-06-27, amended same day):** the model reversed to **option 1 — per-network key** (cortex#1241). **Q1 CLOSED** → per-network key seals **all** federated modes; no Offer carve-out. **Q2/Q3 are now moot** (no per-recipient X25519 resolution on the publish path; `K` is delivered, not derived per recipient). **Q4 CLOSED** → per-network key is the **default** mechanism (not an opt-in for Offer only). **Q5/Q6/Q7** remain implementation-time tuning, recorded below; **Q8** is satisfied by this design serving as the JC anchor. **The mechanism still needs explicit testing and is open to feedback during testing.** None block the build.

1. **Q1 — Confidentiality mechanism.** **[CLOSED — per-network key, L1.]** All federated modes (Direct/Delegate/Offer) sealed with one per-network key `K`; the network is the confidentiality boundary; no Offer cleartext carve-out. (Reversal of the prior option-3 floor.)
2. **Q2 — Stack-key reuse for per-recipient encryption.** **[MOOT — no per-recipient sealing.]** Superseded by the per-network key: the `seal-to-principal` primitive is used only to *deliver* `K` (sealed to each member's pubkey), not to seal each envelope per recipient.
3. **Q3 — Registry enc-key field.** **[MOOT for the hot path.]** No per-envelope recipient-pubkey resolution exists under the per-network key. The registry's `principal_pubkey` is still used as the *seal target* when delivering `K`; a pre-converted `principal_encpubkey` remains an optional convenience there, not a requirement.
4. **Q4 — Per-network key as the default.** **[CLOSED — yes, default.]** Approve the per-network key as the v1 *default* mechanism (not an Offer-only opt-in), accepting network-wide readability + rekey-on-revoke for zero-per-principal-config plug-and-play federation.
5. **Q5 — Rotation grace window.** Is "previous `K` retained for ≥ JetStream `max_age` (7d default)" the right grace window for decrypting in-flight + replayed sealed envelopes? Does it need to be configurable per network?
6. **Q6 — `required` strictness.** When a network is `encryption: required`, should an inbound *cleartext* `federated` payload be **rejected** (emit `system.access.denied`, reason `payload_not_sealed`) or **quarantined + warned**? Rejection is the secure default; quarantine eases debugging during cutover.
7. **Q7 — At-rest scope.** Confirm at-rest JetStream confidentiality stays **principal infrastructure** (filesystem encryption), out of bus scope — with the per-network key providing incidental at-rest protection against a **non-member** that captures the stream, as a bonus, not a guarantee.
8. **Q8 — Session prerequisite.** cortex#369 calls for a 30-min design session with JC (encryption touches myelin primitives §7). Schedule before filing the myelin issue, or file the myelin issue as a strawman to anchor the session? **The reversal to the per-network key is a fresh anchor for that session, and is explicitly open to feedback during testing.**

---

## §9 — Summary of decisions

> **Amended 2026-06-27 — reversed option-3 → option-1 per-network key.** D2/D5/D7/D8 are restated below; the old per-recipient wording is preserved in §3.2 (rejected alternative) and the amendment trail.

| # | Decision | Status |
|---|---|---|
| D1 | Signing-only is the out-of-box default; encryption opt-in per network; **M3 ships THIS release** for the community tier | **Accepted** (2026-06-27, cortex#627) |
| D2 | **One per-network key `K` (network-readable) is the v1 mechanism** — all federated modes sealed with `K`; the network is the confidentiality boundary (L1). *Reversed from per-recipient sealing (option 3); see §3.2.* | **Accepted (amended)** (cortex#1241) |
| D3 | Encrypt `payload` only; all routing/trust/sovereignty metadata stays cleartext + signed | **Accepted** (required by routing) |
| D4 | Encrypt-then-sign — wire signature covers ciphertext; verify-before-decrypt; **signing stays per-author** (L2) | **Accepted** |
| D5 | One `K` per network, held by each member **stack** (not per-assistant); `K` delivered sealed-to-member over the admission/seal channel | **Accepted (amended)** |
| D6 | Encryption gated on `sovereignty.classification === 'federated'` + network `encryption` flag; `local` never encrypts | **Accepted** |
| D7 | **No Offer cleartext carve-out** — Offer is sealed with `K` like Direct/Delegate (the network key covers fan-out trivially) | **Accepted (amended)** (Q1/Q4 closed) |
| D8 | **Read-revocation = automated one-command network-key rotation** (mint `K'`, re-seal to remaining members, auto-refresh); transport revoke stays per-member/immediate; grace window for in-flight | **Accepted (amended)** (Q5 tuning) |
| D9 | TLS leaf-nodes are a documented mandate + runtime warning, not code-enforced (M1 = principal infra) | **Accepted** |
| D10 | One shared `seal-to-principal` primitive serves both M3 network-key delivery and ADR-0018 leaf-secret sealing, on the same channel (L4) | **Accepted** (§3.4) |
| D11 | myelin primitives (derivation, seal/open for key delivery, symmetric `sealPayload`/`openPayload`, SIGNABLE_FIELDS `extensions`, network-key lifecycle) filed upstream as a separate myelin issue | Action (§7) |
| D12 | **Tradeoff accepted deliberately:** network-wide readability + rekey-on-revoke, in exchange for zero-per-principal-config plug-and-play federation + trivial Offer coverage. Per-recipient sealing recorded as rejected-for-this-reason (§3.2). **Needs explicit testing; open to feedback during testing.** | **Accepted (amended)** |
