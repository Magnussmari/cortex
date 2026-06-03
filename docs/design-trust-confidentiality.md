# Design: Trust & Confidentiality — Signed · Encrypted · Federated

**Status:** Draft (consolidation design) · **Owner:** Andreas · **Stakeholder:** JC (E2E NATS / identity)
**Provenance:** Consolidates and sequences ratified work — does **not** re-decide it.
Child of #110 (META: Internet of Agentic Work); cross-links #117 (Phase E) and #524 (Gateway).

> This design ties three already-specified strands together and adds two new defense-in-depth
> layers. It is grounded in a source map of the live code (signing, identity/registry, transport,
> at-rest stores) — file:line references throughout trace to `main` as of v4.1.0.

---

## 1. Goal

Remove the **unsigned-intra-principal trust crutch** and the **single-principal boundary**, and add
confidentiality at every layer. Concretely, move from today's posture —

- gateway→stack envelopes published **unsigned** (D1 "Shape A"), trusted only because they share one
  host/NATS account (single principal);
- **single-principal** `IdentityRegistry` (cross-principal verification not wired);
- **no payload confidentiality** on the bus, **no at-rest encryption**, **no mTLS** —

to a posture where every bus envelope is **attributable (signed)** and optionally **confidential
(encrypted)**, cross-principal flows are **cryptographically verifiable**, and data at rest and in
transit is **encrypted**.

## 2. Non-goals & invariants (inherited — must not be contradicted)

1. **Never extend the frozen envelope schema.** Confidentiality rides on `extensions.enc`; all
   routing/trust metadata (`signed_by[]`, `sovereignty`, `target_*`, `originator`, `economics`)
   stays cleartext. (architecture §4.3; `design-envelope-encryption.md` §1.3)
2. **Encrypt-then-sign.** Seal `payload` first, then the `signed_by[]` chain signs over the sealed
   form. Decrypt only after `verifySignedByChain` accepts. (`runtime.ts:602` signs JCS-canonical bytes
   incl. `payload`; verify never reads `payload` → structurally clean.)
3. **The stack is the sole cryptographic signer.** Gateways/dispatch-sources never touch identity.
   (CONTEXT.md §Dispatch-source, D1 / cortex#524 OQ2, 2026-06-02)
4. **Reuse the identity mesh — no new long-term keys, no certs for envelope crypto.** X25519
   encryption keys are derived deterministically from the existing per-stack Ed25519 seed
   (`stack.nkey_seed_path`, chmod-600). One root of secret material. (key-model decision, this design)
5. **Signing-only is the out-of-box default; encryption is opt-in per network**, with a
   both-accepted transition window. Cortex stays deployable with zero crypto ceremony. (#369 ratified)
6. **TLS is an operational mandate, not in-scope for M1** — but the gap that no mTLS *client* path
   exists (`connection.ts` has no TLS surface) is addressed here as a transport-hardening layer.
7. **Every layer is independently toggleable; the dev default is OFF/permissive.** Signing, payload
   encryption, at-rest encryption, and mTLS each read a mode from a unified `security:` config block
   (Phase 0). You can run the whole stack unencrypted/unsigned, then ramp each layer
   `off → permissive → enforce` independently and reversibly. No layer is wired in a way that can't be
   turned off for local development/testing. (Posture decision, this design — see Phase 0.)

## 3. Current state (source-mapped)

| Area | Today | Evidence |
|------|-------|----------|
| Envelope | `payload` is a discrete opaque field; signatures live in `signed_by[]` (Ed25519 chain) | `envelope-validator.ts:119,137,254` |
| Signing | `MyelinRuntime` signs via `signAndPublishOnSubject` when a `signer` is set; gateway runtime has none → unsigned | `runtime.ts:559,602`; `bus-inbound-sink.ts:26-32` |
| Verify | `verifySignedByChain` = structural trust + opt-in `cryptoVerify`; stack short-circuit via `stackIdentity` (#480) | `verify-signed-by-chain.ts:221,328,412` |
| **#535 blocker** | review-consumer verifier built **without** `stackIdentity`/`stackNKeyPub` → stack-signed requests hit `principal_has_no_nkey_pub` | `cortex.ts:1008-1019` (cf. listener `1223-1225`) |
| Identity | 3-tier principal→stack→agent; `did:mf:<principal>-<stack>`; Ed25519 NKeys only | `cortex.ts:474-476`; `stack.ts:86-133` |
| Registry | `network-registry` Worker stores `operator_pubkey` + stacks; signed assertions; **not wired into cortex runtime yet** | `services/network-registry/src/routes/principals.ts:33,141` |
| Federation | `policy.federated.networks[]` + accept/deny + hop-budget gating exist; **cross-principal pubkey verify NOT wired**; peer pubkeys static in yaml | `cortex-config.ts:1359,1429`; `engine.ts:176-184,253-285` |
| Single-principal | one boot `principalId` stamps every agent's `Identity.network`; no cross-principal verify path | `cortex.ts:395,853`; `verify-signed-by-chain.ts:438-443` |
| Encryption keys | **none** — only Ed25519 signing. No x25519/NaCl in `src/`. myelin has unused AES-256-GCM at-rest primitive | `package.json`; `myelin/src/agent-identity/encryption.ts` |
| At-rest | local SQLite (`dashboard.db`, `mission-control.db`, learning), event JSONL — **no encryption**; D1 CF-managed only | `mc/db/init.ts:20`; `cc-events` JSONL |
| **cortex.yaml** | **bot tokens** loaded with **no chmod-600 gate** (unlike nkey/creds loaders) | `loader.ts:255` |
| Transport | NATS client: NKey/JWT or token auth; **no TLS/client-cert surface** at all | `connection.ts:27-47,103-138` |

## 4. Design

### Phase 0 — Security posture & toggles (lands FIRST) · "get it working off, ramp later"

A unified `security:` block in `cortex.yaml`, read by every other phase. Every layer defaults **OFF**
so the stack runs unencrypted/unsigned out of the box for development; each layer ramps independently
through three modes and is reversible at any time.

```yaml
security:
  signing:   off | permissive | enforce   # off: no signer. permissive: sign + cryptoVerify but
                                           #   rejectEmpty:false + signFailureMode:fallback (LOG, don't
                                           #   reject — observe). enforce: signFailureMode:drop +
                                           #   rejectEmpty:true (reject unsigned/invalid).
  encryption:
    payload: off | opt-in | require        # off: cleartext payload. opt-in: seal when the recipient
                                           #   advertises an enc_pub (both-cleartext-and-sealed accepted
                                           #   in the transition window). require: reject cleartext.
    at_rest: off | on                      # off: plaintext columns. on: field-encrypt the
                                           #   high-sensitivity columns.
  transport:
    mtls:    off | on | require            # off: today's NKey/JWT auth only. on: offer client cert.
                                           #   require: refuse non-mTLS connections.
```

**Why three modes, not a boolean:** the middle `permissive`/`on` rung is the dev affordance — sign and
verify (or offer mTLS / encrypt-when-possible) but **never reject**, so a layer can be proven in shadow
against live traffic before it gates anything. This mirrors the gateway's SHADOW→LIVE double-opt-in and
reuses the existing `cryptoVerify`/`rejectEmpty`/`signFailureMode` knobs rather than inventing new ones.

**Mapping to existing knobs** (Phase 0 is mostly *wiring*, not new mechanism):
- `signing: permissive` ⇒ `cryptoVerify:true` + `rejectEmpty:false` + `signFailureMode:"fallback"`.
- `signing: enforce` ⇒ `rejectEmpty:true` + `signFailureMode:"drop"` (this is the #210 / TC-1d cutover).
- `encryption.payload` ⇒ the #369 opt-in/both-accepted negotiation, surfaced as one mode.
- `transport.mtls` ⇒ the TC-4d `tls` block presence + a `require` refuse-plaintext guard.

**Acceptance:** with `security:` absent or all-`off`, the stack behaves exactly as today (unsigned,
cleartext, NKey-auth). Flipping any single layer's mode changes only that layer. A dev can run the full
gateway round-trip with zero crypto, then enable signing-permissive without touching any other config.

### Phase 1 — Make signing real (single-principal) · removes the unsigned-trust crutch

- **1a. Fix #535 (quick, unblocks the review loop).** Thread `stackIdentity: signer.principal` +
  `stackNKeyPub` into the review-consumer's `signatureVerifier` closure (`cortex.ts:1008-1019`),
  matching the dispatch-listener (`1223-1225`). ~3 lines + a regression test. **Acceptance:** pilot
  review-requests verify; no `principal_has_no_nkey_pub`.
- **1b. Stack-identity provisioning everywhere.** Ensure every deployed stack has
  `stack.nkey_seed_path` + registered `nkey_pub`; resolve the v4 provisioning gaps (stack.id in
  signed blocks). **Acceptance:** `verifier-self-check` passes on every stack at boot.
- **1c. Shape B — re-sign on ingest (#552).** At the bound stack's ingest point (just after
  `verifySignedByChain` accepts the unsigned gateway envelope, `dispatch-listener.ts:~1190`),
  re-emit through the stack's **signer-bearing** runtime so `signAndPublishOnSubject` (`runtime.ts:559`)
  stamps it with the stack NKey before the harness runs. **Acceptance:** gateway-injected dispatches
  carry a stack `signed_by[]` stamp downstream.
- **1d. Enforce.** Flip `signFailureMode` `fallback`→`drop` (#210) and tighten the `tasks.chat`
  inbound path toward `rejectEmpty: true` once subscribe-side verification is enforcing. **Gate:** one
  of the #552 revisit triggers (below) must hold.

### Phase 2 — Federation trust · removes the single-principal boundary

- **2a. Registry client (Phase D.4).** Wire a cortex-side `RegistryClient` that resolves peer
  `operator_pubkey` from `GET /principals/{id}` (registry-signed assertion, pinned registry pubkey)
  instead of static yaml. (`network-registry` already serves this.)
- **2b. Multi-principal `IdentityRegistry`.** Change `buildIdentityRegistry` (`verify-signed-by-chain.ts:438-443`)
  to stamp peer agents with the **peer's** principal/network rather than the single boot `principalId`;
  construct a multi-principal registry for inbound `federated.*`.
- **2c. Relax the single-principal guard** (the boot guard added in GW.a.3d) once 2a/2b make
  cross-principal envelopes verifiable; multi-principal subject derivation in the gateway sink.
- **2d. `federated.*` verify wiring** in the surface-router/policy path (the gate exists; add the
  crypto verify against registry-resolved peer pubkeys). **Acceptance:** principal A's node verifies a
  principal-B-signed envelope end-to-end; forged peer signature rejected.

### Phase 3 — Payload encryption (E2E on bus) · implements ratified #369

Implement `docs/design-envelope-encryption.md` (E.7) as-specified:
- **Sealed `extensions.enc`** — replace cleartext `payload` with `{ ciphertext, alg, recipients[] }`;
  metadata stays cleartext. No schema change.
- **X25519 derived from the Ed25519 stack identity** (ed25519→x25519 conversion); recipient pubs
  distributed via the same mesh (config / agent-registry / registry assertion — one `enc_pub` field).
- **Encrypt-then-sign** at `signAndPublishOnSubject`; **decrypt-after-verify** at the post-verify
  seam in the dispatch path. Opt-in per network; both-accepted transition window.
- **Depends on Phase 2** (peer X25519 pubs need the registry/multi-principal path).
  **Acceptance:** a federated peer without the recipient key cannot read `payload`; the intended
  stack decrypts; sovereignty/routing unaffected.

### Phase 4 — At-rest + mTLS (NEW) · defense-in-depth, **parallel from the start**

- **4a. `cortex.yaml` chmod-600 gate (immediate quick win).** Add `enforceChmod600` to the config
  load path (`loader.ts:255`) — bot tokens are currently unprotected, unlike nkey/creds. Standalone fix.
- **4b. File-mode hardening.** Tighten the event `published/` dir `0755`→`0700`
  (`EventLogger.hook.ts:107`); audit dir/file modes across stores.
- **4c. At-rest field encryption.** App-level field encryption of high-sensitivity columns —
  local SQLite `events.payload`, `tasks.description`, `iterations.body`; D1 `github_events.payload`,
  `audit_log.detail/ip`, `users.email`. Indexed/ID/principal columns stay cleartext for dashboard
  slicing. Reuse myelin's AES-256-GCM primitive; key derived from the stack identity. OS-FDE as the
  baseline. (D1 cannot run SQLCipher — field-level is the only app-controlled option.)
- **4d. NATS mTLS.** Extend `NatsLinkOptions` (`connection.ts:27`) with a `tls?: { ca, cert, key,
  keyPath }` block; load cert/key with the chmod-600 pattern; set `ConnectionOptions.tls`. Plumb
  `nats.tls.*` into cortex.yaml + the relay CLI (relay's `NatsLink` is token-only today).
- **4e. Cloud-publisher mTLS + non-TLS warning.** Optional mTLS on the cloud-publisher→Worker leg;
  a loud non-fatal `system.error` warning when a `federated` leaf-node runs without TLS (enc-design §2).

## 5. Dependency graph

```
Phase 0 (security: toggles, all default OFF) ── lands FIRST, gates every layer's mode
        │
        ├─► Phase 1 (signing) ──► Phase 2 (federation verify) ──► Phase 3 (payload encryption)
        │      1a #535 (now)         2a registry client            (needs peer X25519 from 2a/2b)
        │      1b provisioning       2b multi-principal registry
        │      1c #552 re-sign       2c relax single-principal
        │      1d #210 enforce       2d federated verify
        │
        └─► Phase 4 (at-rest + mTLS) ── independent ── parallel from the start
               4a chmod-600 (immediate)  4c field encryption  4d NATS mTLS  4e cloud-publisher mTLS
```

Phase 0 is foundational but small (mostly wiring existing knobs to one config block). Each capability
phase implements its layer **behind its toggle**, so partial progress never forces crypto on a dev stack.

### Drive priority (revised): federation-FIRST, unsigned

The principal goal is **cross-principal, multi-deployment collaboration ASAP** — not waiting on the full
crypto stack. The toggles make this safe to sequence out of strict dependency order: with
`security.signing: off`, the federation **routing/topology** can be built and proven UNSIGNED, then
signing + encryption layered on via their toggles. Splitting Phase 2 by what actually needs crypto:

- **Phase F — Federation routing (no crypto required; PRIORITISED):**
  - **F-1** Relax the single-principal guard + multi-principal subject derivation (was TC-2c) — today one
    boot `principalId` stamps everything (`cortex.ts:395,853`); this is the real near-term blocker.
  - **F-2** Cross-principal routing on a shared bus — two principals, one NATS, `federated.{principal}.{stack}`
    subjects (grammar + accept/deny + hop-budget gating already exist, `surface-router.ts:651-730`).
    Acceptance: two principals exchange envelopes cross-principal with `signing:off`.
  - **F-3** Multi-link / multi-network runtime — one NATS leaf per network/deployment (E.1 / #348) for
    true multi-deployment bridging.
- **Phase 2-verify — Federation crypto (deferred behind the signing toggle):** registry-resolved peer
  pubkeys (TC-2a) + multi-principal `IdentityRegistry` (TC-2b) + `federated.*` crypto-verify (TC-2d).
  Only engaged when `signing: enforce`.

> ⚠️ **Security caveat (load-bearing):** unsigned cross-principal federation is **unauthenticated** — a
> peer can claim any principal identity. Acceptable for dev / trusted-party testing only. `signing:enforce`
> + `encryption.payload` MUST be on before federation faces an untrusted or cross-org peer. The toggle
> ramp makes this a deliberate, reviewable flip.

**Revised drive order:** Phase 0 (toggles off) → **Phase F (F-1→F-2→F-3, unsigned)** → harden:
signing (1) → federation-verify (2-verify) → encryption (3). Phase 4 (at-rest/mTLS) parallel throughout.

Encryption (3) **cannot precede** federation verify (2); both build on signing (1). Phase 4 is
orthogonal — no dependency on 1–3.

## 6. Threat model (what each layer defends)

| Layer | Defends against | Residual |
|-------|-----------------|----------|
| Signing (1) | Forged/replayed envelopes; unattributable gateway injection | Confidentiality (bus is readable) |
| Federation verify (2) | A malicious peer impersonating principal B | Trust in the registry's pinned pubkey |
| Payload encryption (3) | A curious/compromised bus or peer reading `payload` | Metadata is cleartext (by design) |
| At-rest (4a–c) | Disk/DB theft, leaked config tokens | OS-level / key-custody |
| mTLS (4d–e) | On-wire sniffing, server impersonation | App-layer identity still required |

## 7. Open decisions (to resolve during the drive)

- **OD-1:** X25519 derivation — RFC-8032 ed25519→x25519, or independent X25519 keypair co-stored?
  (#369 leans derive; confirm with JC.)
- **OD-2:** At-rest key custody — derive a DB-encryption key from the stack seed, or a separate
  principal-held key? (Disk theft + seed theft are correlated if same root.)
- **OD-3:** mTLS vs NKey/JWT — complement or replace? (NATS supports both; pick posture.)
- **OD-4:** Enforcement cutover timing for 1d/#210 — which #552 trigger fires first.
