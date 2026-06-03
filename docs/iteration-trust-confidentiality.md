# Iteration Plan: Trust & Confidentiality

Tracks `docs/design-trust-confidentiality.md`. Umbrella: **#TBD** (child of #110; cross-links #117, #524).
Each slice is a sub-issue. `folds #N` = an existing issue this slice subsumes/reuses (don't recreate).
Status: ☐ planned · ◐ in-progress · ☑ done.

| Slice | Title | Phase | Folds / New | Status | Issue |
|-------|-------|-------|-------------|--------|-------|
| **TC-0** | Security posture config — unified `security:` toggles (signing/encryption/at-rest/mTLS), all default OFF; ramp `off→permissive→enforce` | 0 Posture | new | ☐ | — |
| **TC-1a** | Fix #535 — thread `stackIdentity`/`stackNKeyPub` into review-consumer verifier | 1 Signing | folds #535 | ☐ | — |
| **TC-1b** | Stack-identity provisioning + boot `verifier-self-check` on every stack | 1 Signing | new | ☐ | — |
| **TC-1c** | Shape B — bound stack re-signs gateway-injected envelopes on ingest | 1 Signing | folds #552 | ☐ | — |
| **TC-1d** | Enforce — `signFailureMode` → `drop`; tighten `rejectEmpty` on `tasks.chat` | 1 Signing | folds #210 | ☐ | — |
| **TC-2c** | **F-1:** Relax single-principal guard + multi-principal subject derivation | **F Routing** (priority) | new | ☐ | — |
| **TC-F2** | **F-2:** Cross-principal routing on a shared bus (two principals, one NATS, `federated.*`, unsigned) | **F Routing** (priority) | new | ☐ | — |
| **TC-F3** | **F-3:** Multi-link / multi-network runtime — one NATS leaf per network/deployment | **F Routing** | new (E.1 / #348) | ☐ | — |
| **TC-2a** | Registry client — resolve peer pubkeys via `GET /principals/{id}` (Phase D.4) | 2-verify (harden) | new | ☐ | — |
| **TC-2b** | Multi-principal `IdentityRegistry` (peer-stamped, not single boot principal) | 2-verify (harden) | new | ☐ | — |
| **TC-2d** | `federated.*` crypto-verify wiring against registry-resolved peer pubkeys | 2-verify (harden) | new | ☐ | — |
| **TC-3** | Payload encryption — sealed `extensions.enc`, X25519-from-ed25519, encrypt-then-sign | 3 Encryption | folds #369 | ☐ | — |
| **TC-4a** | `cortex.yaml` chmod-600 gate (bot tokens) — **immediate quick win** | 4 At-rest/mTLS | new | ☐ | — |
| **TC-4b** | File-mode hardening (event `published/` 0755→0700; mode audit) | 4 At-rest/mTLS | new | ☐ | — |
| **TC-4c** | At-rest field encryption (high-sensitivity columns; local SQLite + D1) | 4 At-rest/mTLS | new | ☐ | — |
| **TC-4d** | NATS mTLS — `tls` surface on `NatsLink` + cortex.yaml/relay plumbing | 4 At-rest/mTLS | new | ☐ | — |
| **TC-4e** | Cloud-publisher mTLS + non-TLS `federated` leaf-node warning | 4 At-rest/mTLS | new | ☐ | — |

## Drive order — federation-FIRST (unsigned), crypto layered on after

Principal goal: **cross-principal, multi-deployment collaboration ASAP**. The Phase-0 toggles let us run
federation routing UNSIGNED, then ramp crypto. (⚠️ see caveat below.)

1. **Now, in parallel (small, independent, high-value):** **TC-0** (posture toggles, all default OFF) · **TC-1a** (#535, ~3 lines, unblocks review loop) · **TC-4a** (chmod-600 quick win).
2. **PRIORITY — federation routing, unsigned (`security.signing: off`):** TC-2c/**F-1** (relax single-principal guard + multi-principal subjects) → **TC-F2** (cross-principal on a shared bus — two principals collaborating, unsigned) → **TC-F3** (multi-link / multi-network bridging). *This is the goal; reachable without any crypto.*
3. **Harden — signing:** TC-1b → TC-1c (#552) → TC-1d (#210, flip `signing: enforce`).
4. **Harden — federation crypto-verify:** TC-2a → TC-2b → TC-2d (engaged when `signing: enforce`).
5. **Harden — encryption:** TC-3 (#369) — payload encryption (needs TC-2a/2b).
6. **Parallel throughout:** TC-4b–4e (at-rest + mTLS) — no dependency on the above.

> ⚠️ **Caveat:** unsigned cross-principal federation is **unauthenticated** (a peer can claim any
> principal). Fine for dev / trusted-party testing. `signing: enforce` + `encryption.payload` MUST be on
> before federation faces an untrusted or cross-org peer — a deliberate, reviewable toggle flip.

## Exit criteria

- Every bus envelope on a configured stack carries a verifiable stack `signed_by[]` stamp; unsigned dispatches dropped (not fallback).
- A principal-B-signed `federated.*` envelope verifies on principal A's node; forged peer signature rejected.
- On an encryption-enabled network, a peer without the recipient key cannot read `payload`; intended stack decrypts; routing/sovereignty unaffected.
- No plaintext bot tokens or high-sensitivity columns at rest without app-level encryption or enforced 0600; NATS connections support mTLS.
