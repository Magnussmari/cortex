# ADR-0019 — M3 federated payload encryption: sealed-to-recipient, encrypt-then-sign, ships this release

**Status:** accepted (ratified with Andreas 2026-06-27) · **Refs:** cortex#627 (Trust & Confidentiality umbrella), cortex#369 (TC-3), cortex#1142 (admission gate / leaf-secret), [ADR-0013](0013-sovereign-federation-model.md) (sovereign federation), [ADR-0018](0018-admission-gate-and-leaf-secret-distribution.md) (leaf-secret distribution — same seal primitive), `docs/design-envelope-encryption.md` (the firmed design), `docs/design-trust-confidentiality.md` (Phase 3)

## Context

Every cortex envelope is **signed** (stack ed25519 NKey over the JCS-canonical `SIGNABLE_FIELDS`) — integrity + authenticity, but **not confidentiality**. Payloads cross `federated.>` cleartext-over-TLS and persist cleartext in JetStream. While the bus was a single principal's private mesh, that was acceptable: the only subscribers were the principal's own stacks.

The **community federation tier goes live in this release**. A network is a roster of admitted-but-not-pre-trusted principals (ADR-0015 admission gate; ADR-0018 leaf-secret pipe). On a cleartext federation, **any admitted peer can passively read every `federated.>` payload**, and so can the hub host (TLS terminates at the hub — the hub is an authorized link peer, not an outside attacker). This is the residual flagged in `design-admission-gate-leaf-secret.md` §7 Q7: a leaked-but-revoked leaf PSK, or simply a curious admitted member, can read federated content while their link is live. The §2-style "leaf secret is only a transport PSK" argument bounds *injection/forgery* (you still can't forge a `signed_by[]` chain) but does **not** bound *reading* — confidentiality needs a payload-layer mechanism.

CONTEXT.md §222 previously recorded M3 as **deferred** ("you + JC + a trusted hub"). That premise no longer holds once the hub admits parties who are not pre-trusted. M3 must ship with the tier it protects.

`docs/design-envelope-encryption.md` is the firmed design (Status: Accepted). This ADR records the load-bearing decisions so they are not silently re-litigated.

## Decision

**Pull M3 payload confidentiality into this release, as the option-3 floor of the firmed design, with these locks:**

1. **Sealed-to-recipient is the v1 mechanism; option-3 is the floor.** **Direct/Delegate** dispatch seals the `payload` to the recipient **stack's** registered pubkey (X25519 derived from the ed25519 `principal_pubkey` in the registry). **Offer-mode payloads stay cleartext-but-signed** — confidential cross-principal work is done as **Direct dispatch** (which has a named recipient to seal to). A per-network Offer key (design option 1) is a documented **opt-in upgrade**, not v1; seal-to-all-candidates (option 2) is **future**.

2. **Encrypt-then-sign.** The stack seals `payload` first, then `signEnvelope` signs the `SIGNABLE_FIELDS` over the **sealed** form. The `signed_by[]` chain therefore covers the **ciphertext**. Every forwarder and the recipient verify the chain + sovereignty alignment **before** decrypting (verify-before-decrypt; the cryptographic-doom-principle order). Intermediaries that cannot decrypt (they are not the recipient) can still verify and append stamps. Authorship is attested at two layers: the chain (who handled it) and the AEAD tag (who sealed *this* content for *this* recipient).

3. **No new key material.** The X25519 sealing keypair is derived deterministically from the existing per-stack ed25519 seed (`crypto_sign_ed25519_*_to_curve25519`). **No certs, no new long-term keys, no new registry surface, no new distribution channel** — the recipient's encryption key is a function of the `principal_pubkey` the registry already serves. This is what keeps "no crypto ceremony out of the box" true.

4. **One shared `seal-to-principal` primitive.** The seal construction (ed25519→X25519 + libsodium `crypto_box_seal`) is the **same** one ADR-0018 option b′ uses to seal the leaf PSK to a joiner's registered pubkey. Both consumers MUST use **one shared module** (single derivation, single AEAD construction); two independent implementations is a key-derivation-divergence and security-review hazard. M3 layers an envelope-binding wrapper (AEAD associated-data over `id` + `type` + `sovereignty.classification`) on top of the shared core; ADR-0018 uses the core directly.

5. **Opt-in per network, with a both-accepted transition window.** Encryption is enabled by a per-network `encryption: off|enabled|required` flag in `policy.federated.networks[]`. Signing-only stays the out-of-box default; a stack with no federated networks never touches encryption code. During transition a member **accepts both** cleartext-but-signed and sealed payloads (keyed on the presence of `extensions.enc`); the coordinator flips to `required` once all members confirm. Federating a `federated` link with `encryption: off` (or non-TLS) emits a **loud-but-not-fatal** `system.error`-class warning — "federating in the clear" must be a choice, not a stumble.

6. **Encrypt exactly one field.** Only `payload` is sealed. All routing/trust/sovereignty metadata (`subject`, `sovereignty`, `signed_by[]`, `originator`, `target_*`, `correlation_id`, `distribution_mode`, `economics`, …) stays cleartext and signed — the bus routes, verifies, gates, and accounts on it before any application code runs. No envelope-schema change: the sealed form rides `extensions.enc` + ciphertext-in-`payload`.

7. **`local.*` never encrypts.** Encryption is a function of `sovereignty.classification === 'federated'`. Intra-principal traffic is the principal's own trust domain.

## Consequences

- **Reverses the CONTEXT.md §222 deferral.** §222 is updated to "M3 sealed-payload **ships** for Direct/Delegate on encryption-enabled networks; Offer-mode confidentiality deferred." The deferral premise (trusted hub, pre-trusted peers) no longer holds for the community tier.
- **TC-3 (folds #369) becomes a this-release slice** of the cortex#627 umbrella, sequenced after the Phase-2 registry client / multi-principal registry (peer X25519 pubkeys need the registry path). Build slices TC-3.0…TC-3.4 in `design-envelope-encryption.md` §7.
- **The shared `seal-to-principal` module lands once** and is a dependency of *both* TC-3 and ADR-0018's leaf-secret build slice. Whichever ships first lands the module; the other consumes it.
- **myelin primitives are filed upstream** (the derivation helper, `sealTo`/`openSealed`, `sealPayload`/`openPayload`, and confirming `extensions` ∈ `SIGNABLE_FIELDS` so `extensions.enc` is tamper-evident). Encryption touches the identity/crypto layer myelin owns.
- **Offer-mode confidential fan-out is explicitly NOT available at launch.** Principals with a confidential fan-out need use Direct dispatch until the per-network Offer key opt-in ships. Documented, not a silent gap.
- **Rotation** rides the registry's transition-claim mechanism; because the X25519 key derives from the ed25519 signing key, rotating the signing key rotates the encryption key in lockstep (one ceremony). A grace window retains the previous seed for in-flight/replayed sealed envelopes.
- **At-rest is incidental, not a guarantee.** Sealed payload protects content at rest on non-recipient stacks as a side effect; true at-rest confidentiality stays principal infra (OS-FDE).

## Alternatives considered

- **Defer M3 (keep §222 status quo).** Rejected: the community tier admits non-pre-trusted peers; cleartext federation lets any admitted peer read all payloads. The threat the deferral assumed away is exactly the one this release introduces.
- **Per-network shared key as the v1 default.** Rejected: reintroduces key-distribution ceremony and rotation, weakens confidentiality from per-addressee to per-network, and widens the blast radius of a leaked key to the whole network's traffic. Retained only as an opt-in for the Offer fan-out case that genuinely lacks a named recipient.
- **Seal Offer payloads to all capable candidates (option 2).** Rejected for v1: requires enumerating candidates at publish time (registry lookup on the hot path), grows the envelope with N wrapped keys, and a stack that joins the capability after publish cannot read a replay. Recorded as a future enhancement.
- **Sign-then-encrypt (sign plaintext, encrypt the signed blob).** Rejected: breaks hop-verification (intermediaries can't decrypt, so can't verify what they forward) and forces routing fields either inside the ciphertext (breaking routing) or outside the signature (breaking tamper-evidence). Encrypt-then-sign is the only order compatible with cleartext-metadata + chain-of-stamps.
- **A separate dedicated encryption keypair (not derived from the signing seed).** Rejected for v1: cleaner key-hygiene separation, but a second registry field + a second rotation + new ceremony — it would defeat "no certs out of the box." Reuse is the decision; a separate key can be added later if a non-cortex peer cannot do the ed25519→X25519 conversion.
