# Runbook — Issue a leaf credential for a community principal — **RETIRED (Model A)**

> **Retired by [ADR-0015](./adr/0015-two-tier-onboarding-and-admission-gate.md) (2026-06-18).**
> This runbook described the **Model-A hub-minted-credential** path — a network hub
> minting a joiner a scoped guest credential under the hub's own NSC operator. That model
> is dropped (ADR-0013 adopted sovereign federation; ADR-0015 retired the Model-A
> machinery from `main`).
>
> **The full original runbook is preserved** on the git tag and branch
> `model-a-hub-minted-creds` (and `archive/model-a-hub-minted-creds`) — recoverable if
> Model B ever proves too cumbersome for community onboarding.

## What replaces it

- **Roster admission** is governed by the **network-admission gate** — `register → PENDING
  → admit` — which mints **nothing** (it gates *who* is on a network roster, not
  credentials). See `cortex network admit` and
  [`sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md).
- **Federation identity** is **sovereign**: every principal runs their **own** NSC
  operator + a dedicated federation account, and the leaf link is a
  **secret-authenticated transport pipe** (no cross-operator JWT trust, no hub-minted
  accounts). See [ADR-0013](./adr/0013-sovereign-federation-model.md) and
  [`sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md).
- The **one irreducible secret handoff** that remains is the admin issuing a leaf `.creds`
  **from their own NSC operator** (via `cortex creds issue` / `arc nats add-bot`, locally,
  in their own account) and sharing it out-of-band. This is not Model A — no hub mints an
  account *for* the joiner.

## Community participation tiers (ADR-0015)

- **Tier 1 — Chat.** Bring your own Discord bot into `#assistant-fleet`. No NATS, no
  credentials.
- **Tier 2 — Sovereign.** Run your own NSC operator + stack + federation account and join
  the bus the Model-B way. The hub issues you no account or credential.

There is **no middle "guest bus" tier** (the Model-A hub-minted-guest-cred path). See
[ADR-0015](./adr/0015-two-tier-onboarding-and-admission-gate.md).
