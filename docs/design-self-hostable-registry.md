# Design: self-hostable + peerable registry (signed network manifest)

**Status:** design / spec (implementation deferred — depends on #1321) · **Date:** 2026-06-29
**Issue:** #1322 · **Parent:** #110 · **Depends on:** #1321 (per-network admin in schema)
**Refs:** `docs/research-federation-decentralization.md`, ADR-0003 (network-join control plane), ADR-0013 (sovereign federation), ADR-0005 (session-interior / cortex↔signal boundary), CONTEXT.md §Joining a network / §boundary-with-signal

> Authored during an autonomous run while JC is away. This is the SPECIFY+PLAN
> artifact for #1322 — **no implementation lands until #1321 merges and JC/Luna
> approve this design.** Open questions for JC are collected at the end.

## Problem

Discovery is registry-mediated through a **single hosted service**
(`network.meta-factory.ai`): the principal pubkey directory, the network
descriptor (`hub_url`/`leaf_port`), and the roster. Every principal pins this one
registry (`policy.federated.registry.{url,pubkey}`). The registry's *role* is
correct — it is the **"DNS of the federation"**, the thin trust anchor that
issues no identity and signs no credential (ADR-0013). The problem is only that
it is **the** registry, not **a** registry: there is no way to run your own, and
no peer-to-peer discovery (CONTEXT.md: "No peer-to-peer discovery implemented").

The research is explicit: **keep a thin anchor** (RPKI is rooted in the RIRs, DNS
in the root, CT in root programs) — do **not** chase trustless P2P. So this is
*un-monopolise*, not *abolish*.

## Goal

Anyone can run a registry; others point at it. Registry-as-default-transit, not
registry-as-authority. A principal pins **admin DIDs** (the thin anchor), not a
central URL, and verifies a **portable signed manifest** offline.

## Non-goals

- Abolishing the registry / pure trustless P2P (the research's explicit anti-goal).
- A DHT (at tens of principals it degenerates to a full mesh — pure overhead).
- Network-wide observability / peer-liveness — that is **signal's** domain
  (CONTEXT.md §boundary-with-signal, ADR-0005). This design is cortex
  control-plane only: a stack's own join/anchor config.
- Capability-based admission (Biscuit/VC) — a separate follow-on (see below).

## Design

### 1. Portable signed network manifest

The descriptor is **already** a `SignedAssertion` (registry signs every response;
clients pin + verify, DD-9). Promote it to a self-contained, relocatable
**network manifest** that carries everything a joiner needs and is verifiable
**offline** against pinned admin DIDs:

```
NetworkManifest {
  network_id
  hub_url, leaf_port              // topology (today's descriptor)
  admin_dids[]                    // the network's admins (from #1321 admin_pubkeys, as DIDs)
  roster[] { principal_id, stack_id, principal_pubkey }   // admitted peers (DD-5)
  issued_at, expires_at
  signature                       // by a network admin DID (not a hosted-registry key)
}
```

Key shift from today: the manifest is signed by a **network-admin DID** (the
authority a joiner already trusts via #1321), so it no longer *requires* the
hosted registry's signing key to be trustworthy — it can be served from
**anywhere**: git, an HTTPS file, a NATS object-store bucket, or the existing
hosted registry. Verification is **offline** against the pinned admin DID set.

### 2. Pin admin DIDs, not a URL

Generalise the pin (`policy.federated.registry`):

```
policy.federated:
  trust_anchors:                 # NEW — the thin anchor: who may sign a manifest
    - did: did:mf:andreas-meta-factory
  manifest_sources:              # NEW — one OR MORE places to fetch the manifest
    - https://network.meta-factory.ai/networks/{id}    # the hosted registry stays a default source
    - https://raw.githubusercontent.com/.../networks/{id}.json
    - nats://object-store/networks/{id}
  registry: { url, pubkey }      # KEPT, deprecated-but-supported (back-compat)
```

A manifest is accepted iff its signature verifies against a pinned `trust_anchor`
DID. Sources are tried in order; a stale/unreachable source falls through to the
next (DD-10 cached-fallback behaviour generalises to multi-source). The hosted
registry remains a valid (default) source — nothing breaks for existing pins.

### 3. Per-principal endpoint self-publication

Decouple stable identity from physical endpoint (the Matrix `.well-known`
pattern): a principal publishes its current endpoint under its own control —
`https://{principal-domain}/.well-known/metafactory/stack.json` or DNS
`SRV _mf-leaf._tcp` + `TXT`. The manifest pins the **identity/keys**; the
well-known/DNS record updates the **location** unilaterally. Optional and
additive — hand-pinned peers (today's offline fallback) still work.

### 4. No DHT, no gossip (yet)

At tens of principals, a signed manifest + multi-source fetch is sufficient.
Live membership (SWIM-style gossip) is a later option only if real-time
up/down membership is needed; it would run *under* the manifest's trust model.

## Trust model

- **Anchor:** the pinned network-admin DID set (#1321 makes per-network admins
  real; this design lets a manifest be signed by them). Thin, replaceable,
  explicit — exactly the RIR/DNS-root/CT pattern the research endorsed.
- **Verification:** offline signature check against pinned anchors. No hosted
  service must be online or honest for a cached manifest to be trusted.
- **Revocation/freshness:** `expires_at` + re-fetch; short manifest lifetimes
  over online revocation. (Capability-based admission, below, sharpens this.)

## Control-plane / wire-protocol compliance

Control-plane only. No subject shape, no envelope field, no
`selectLink`/`source`/`originator` change — discovery/anchor config never appears
on the wire; the network stays a topology fact resolved from `peers[]`
(federation-wire-protocol SOP check 1). cortex↔signal split honoured: this is a
stack's own anchor/join config, not network-wide observability.

## Dependencies & staging

1. **#1321** (per-network admin) — prerequisite: the manifest is signed by a
   per-network admin DID, which #1321 introduces.
2. Manifest schema + offline verifier (generalise the existing `SignedAssertion`
   verify to "verify against any pinned anchor DID").
3. `policy.federated.trust_anchors` + `manifest_sources` config (back-compat with
   `registry.{url,pubkey}`).
4. Multi-source fetch with ordered fallback (generalises DD-10 cached-fallback).
5. (Optional, later) per-principal `.well-known`/DNS endpoint publication.

## Follow-on (separate issue, NOT this scope)

**Capability-based admission** — replace the roster-membership lookup with an
attenuable, offline-verifiable **capability** (Biscuit, public-key-verifiable; or
signed JWT-VC) issued by the network-admin DID: "principal X admitted to network
Z" becomes a token X holds and any peer verifies against the admin DID, with
short TTLs + a CT-style append-only admission log. Same Ed25519 primitive the NSC
nkeys already use. File separately when pursued.

## Open questions for JC

1. **DID method** for `admin_dids` / `trust_anchors` — `did:key` (zero infra, no
   rotation) for stacks vs `did:web` (rotatable, domain-anchored) for principals?
   (#1321 currently stores raw base64 pubkeys; a DID wrapper is a small adapter.)
2. **Primary alternate manifest source** to support first — git, plain HTTPS file,
   or NATS object store? (Drives which fetcher to build first.)
3. **Manifest lifetime** (`expires_at`) default — hours? a day? — balancing
   staleness against re-fetch cost and revocation latency.
4. Is per-principal `.well-known`/DNS endpoint publication wanted now, or deferred
   until a principal actually needs to relocate a stack endpoint?
