# Iteration Plan: F-3 Multi-link / multi-network runtime

Tracks `docs/design-multi-network.md`. Umbrella: **#631** (TC-F3 / F-3, under `#627`; E.1 / `#348`;
cross-links `#117`). Each sub-slice is a sub-issue closed by its PR.
Status: ☐ planned · ◐ in-progress · ☑ done.

**Invariant across every slice:** *zero per-network `nats:` blocks configured ⇒ zero behaviour change
vs today's single-link runtime.* Every slice is shippable to main behind this no-op guarantee — main
never enters a half-built multi-network state.

**Blocked on:** OD-F3-1 (schema choice) before F-3a; OD-F3-2 (degraded-boot contract) before F-3c.
See `docs/design-multi-network.md` §9.

| Slice | Title | Touches | Status | Issue |
|-------|-------|---------|--------|-------|
| **F-3a** | Schema — optional `nats:` on `PolicyFederatedNetworkSchema` + `leaf_node`-consistency cross-validator | `src/common/types/cortex-config.ts` | ☐ | TBD |
| **F-3b** | LinkPool core — internal pool, selected-link publish core, pure-function link selection, per-link dedupe | `src/bus/myelin/runtime.ts` | ☐ | TBD |
| **F-3c** | Per-link lifecycle + degrade-don't-crash boot + `stop()` drains all links | `src/bus/myelin/runtime.ts` | ☐ | TBD |
| **F-3d** | Inbound `sourceLink` attribution + anti-spoof + surface-router fed-gate wiring | `runtime.ts`, `src/bus/surface-router.ts`, `src/cortex.ts` | ☐ | TBD |

## Slice detail

### F-3a — Schema (additive)
- [ ] Add optional `nats: { url, credsPath?, name? }` to `PolicyFederatedNetworkSchema`
      (`cortex-config.ts:1444`), a subset of `NatsConfigSchema` (`cortex-config.ts:870`).
- [ ] `superRefine` cross-validator: entries sharing a `leaf_node` resolve to identical connection
      params (exactly one declares `nats:`, rest omit, or all byte-identical) — per-offender `ctx.addIssue`
      (mirror `cortex-config.ts:1611`).
- [ ] Unit tests: valid shared-leaf, conflicting-leaf rejected, no-`nats:` (back-compat) parses.
- [ ] **No runtime consumption yet** — schema-only; existing configs unaffected.

### F-3b — LinkPool core
- [ ] Internal `LinkPool` keyed by `linkId` (`'primary'` + each distinct `leaf_node`).
- [ ] Build `network_id → linkId` map once at boot from `policy.federated.networks[]` (never from
      `network-resolver.ts`'s legacy `config.networks[]` — see design §3.2 name-collision).
- [ ] Reparameterise `signAndPublishOnSubject` (`runtime.ts:666`) to take a selected link.
- [ ] Pure-function link selection: `local.*`/`public.*` → primary; `federated.{n}.*` → pool[n];
      unknown network → `system.error` `unknown_network_in_publish_subject` + skip.
- [ ] Per-link `boundByPattern` dedupe (`runtime.ts:560`).
- [ ] Tests: two-link routing matrix, **negative leakage test**, link-selection pure-function,
      back-compat snapshot (zero `nats:` ⇒ identical subjects).

### F-3c — Lifecycle + degraded boot *(needs OD-F3-2)*
- [ ] Per-link connect/drain/reconnect; one link's failure isolated.
- [ ] `stop()` drains all links via `Promise.allSettled` (extend `runtime.ts:908`).
- [ ] Boot: primary link governs `enabled`; dead per-network link ⇒ `system.error` + disabled-link
      skip-and-log + background retry (replaces all-or-nothing `runtime.ts:519-533`).
- [ ] Tests: boot-degradation, stop-drains-all-on-partial-failure.

### F-3d — Inbound attribution + gate wiring
- [ ] `EnvelopeHandler` gains additive `sourceLink?: string` (`runtime.ts:40`); existing handlers ignore.
- [ ] Per-link subscriber tags delivered envelopes with the delivering `linkId`.
- [ ] Anti-spoof: subject `{network_id}` must map to a network with `leaf_node === sourceLink`; mismatch
      dropped + logged.
- [ ] Surface-router fed gate (`surface-router.ts:350-366`) keyed by the delivering network.
- [ ] Tests: attribution, anti-spoof drop, extend `runtime-principal-symmetry.test.ts` per-link.

## Out of scope (deferred — design §3.5)
- Per-network JetStream durables (`subscribePull` stays primary-only).
- Per-network signing keys (one stack identity, all links).
- E.2 capability announce · E.3 delegation/orchestrator · E.7 encryption-at-the-bridge.

## Exit criteria
- A single cortex process opens ≥2 leaves; `federated.{A}.*` routes only through link A,
  `federated.{B}.*` only through link B; chain-of-stamps preserved; **no** B-traffic on link A's wire.
- A network with no `nats:` block routes via the primary link; zero per-network `nats:` ⇒ Phase-D-identical.
- A dead per-network leaf at boot leaves the daemon up with that network dark + a `system.error`.
- Inbound envelopes carry `sourceLink`; a network-segment / delivering-link mismatch is rejected.
