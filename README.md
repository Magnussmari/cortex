# cortex

The metafactory ecosystem's **layer-7 collaboration surface** — the M7 application that consumes the Myelin stack (M2–M6) and presents collaboration, dispatch, and observability to operators.

## Status

**v0.1.0 — MIG-0 bootstrap.** This repo currently contains design + migration plan only. Source code lands MIG-1 onward, ported from `the-metafactory/grove-v2`.

- **Architecture (canonical):** [`docs/architecture.md`](docs/architecture.md) — what cortex IS. M1–M7 stack, agent + presence/renderer model, M7 application architecture, agent task routing, three-tier visibility, internal componentisation.
- **Migration plan (working):** [`docs/plan-cortex-migration.md`](docs/plan-cortex-migration.md) — how grove-v2 → cortex. Per-file inventory + phase plan MIG-0..MIG-8 + acceptance criteria. Retires when MIG-8 closes.

## What cortex replaces

- **`the-metafactory/grove`** (legacy v0.29.0) — in maintenance mode, will be archived at MIG-8.
- **`the-metafactory/grove-v2`** (active dev v0.22.1) — source of truth for the migration; archived at MIG-8.

cortex inherits source from grove-v2. The deployed bot rebrands `grove-bot` → `cortex` once MIG-7 lands.

## Stack reference

cortex is one M7 application among siblings:

```
M7  cortex (this repo) · pilot · signal · future apps
M6  Composition (myelin)
M5  Discovery (myelin)
M4  Identity (myelin — MY-400)
M3  Envelope (myelin — schema + namespace)
M2  Transport (myelin — NATS abstraction)
M1  Connectivity (NATS)
```

See `docs/architecture.md` §2 for the full layered model and §5 for sibling-app and adjacent-knowledge-artefact context.

## Authors

- Andreas Astrom
- Jens-Christian Fischer

## License

TBD (mirroring metafactory ecosystem default).
