# Migration 0003 — split monolithic `cortex.{stack}.yaml` into the multi-file layout

**Status:** ✅ **EXECUTED 2026-06-05** — all three live stacks (`halden` → `work` →
`meta-factory`) cut over to the multi-file layout and verified healthy
(Discord reconnected, per-stack PID files, dispatch/review sinks up). No code
change — the loader already supports both; this was a config-layout reorg of
`~/.config/cortex/`.

## Why

A single fat `cortex.yaml` (the meta-factory one is ~29 KB) couples knobs with
wildly different blast radii on one edit surface. The split isolates them by
lifecycle (per `docs/config-layout/README.md`):

| Layer | Owns | Blast radius |
|---|---|---|
| `system/system.yaml` | transport: `claude`, `execution`, `attachments`, `paths`, **`nats`, `bus`** + the `nats.subjects` landmine (ONE place) | whole stack |
| `network/*.yaml` | `policy.federated.networks[]` | cross-principal |
| `surfaces/surfaces.yaml` | Discord/Slack tokens + the `{surface→stack}` gateway map | cross-stack |
| `stacks/<name>.yaml` | per-deployment `principal` / `policy` / `capabilities` / `agents` | one stack |

## How the loader resolves it (verified — `loader.ts` `composeRawConfigWithSurfaces`)

- `--config <path>` → `configDir = dirname(<path>)`.
- **Marker:** if `configDir/system/system.yaml` exists → **directory layout**: read + deep-merge `system/system.yaml` → `network/*.yaml` (sorted) → `surfaces/surfaces.yaml` → `stacks/*.yaml` (sorted); later layers win on leaf keys; `LoadedConfig` is **byte-identical** to the monolith's.
- **No marker → single-file fallback** (the pre-migration behaviour). So rollback = point `--config` back at the monolith.
- The composer deep-merges **all** `stacks/*.yaml` in a dir into ONE config ⇒ **one config dir = one composed stack.** The root sentinel file's *contents are ignored* — only its `dirname` selects the layout.

## ⚠️ The PID-collision landmine (learned during the live cutover)

The sentinel file you point `--config` at **must be named per-stack** (`<S>.yaml`),
**NOT** a uniform `cortex.yaml`. cortex derives its single-instance PID-file name
(`~/.config/grove/state/cortex-<basename>.pid`) from the `--config` **basename**.
If every stack's sentinel is `cortex.yaml`, all three derive the *same*
`cortex-cortex.pid` → the second daemon to start sees the first's PID and aborts
with `cortex: already running (PID …). Stop it first`. This is invisible to the
byte-identity check (PID naming is a function of the path, not the config
content). **First halden cutover attempt failed exactly this way and had to be
rolled back.**

✅ **Correct:** name each sentinel after its stack — `meta-factory/meta-factory.yaml`,
`work/work.yaml`, `halden/halden.yaml` → unique `cortex-meta-factory.pid`,
`cortex-work.pid`, `cortex-halden.pid`. (`dirname` still resolves the layout, so
the per-stack name has zero effect on the composed `LoadedConfig`.)

## Target structure — one dir per stack (as executed)

Because `halden` is on its own bus (`:4223`) and `meta-factory`/`work` share `:4222`, transport differs per stack, so each stack gets its own directory (each with its own `system.yaml`):

```
~/.config/cortex/
  meta-factory/
    system/system.yaml         # claude, execution, paths, nats(:4222), bus, attachments, nats.subjects:[]
    stacks/meta-factory.yaml   # principal:andreas, stack:andreas/meta-factory, policy, capabilities, agents
    meta-factory.yaml          # sentinel (dirname → this dir; per-stack name → unique PID)
  work/
    system/system.yaml         # nats(:4222) …
    stacks/work.yaml           # stack:andreas/work …
    work.yaml                  # sentinel
  halden/
    system/system.yaml         # nats(:4223) — the isolated bus
    stacks/halden.yaml         # stack:andreas/halden …
    halden.yaml                # sentinel
```

`surfaces.yaml`/`network/` are OPTIONAL — the three live stacks kept Discord bindings
**inline** on `agents[].presence` (lifting them into a `surfaces.yaml` fold is a
separate, deliberate change and would break byte-identity, so it was NOT done here).
`meta-factory` + `work` MAY later share a `surfaces.yaml`/`network/` via symlink;
`halden` stays standalone (isolated).

## Per-stack procedure (idempotent, reversible — as executed)

For each stack `<S>` (config file `cortex[.<S>].yaml`):

1. **Back up:** `cp ~/.config/cortex/cortex[.<S>].yaml ~/.config/cortex/cortex[.<S>].yaml.pre-split-$(date +%Y%m%dT%H%M%S).bak`.
2. **Create dir + split:** `mkdir -p ~/.config/cortex/<S>/{system,stacks}`. Transport blocks (`claude`, `execution`, `attachments`, `paths`, `nats`, `bus`) → `system/system.yaml`; the rest (`principal`, `stack`, `capabilities`, `policy`, `agents`, `renderers`, `github`, `networks`, `networksDir`) → `stacks/<S>.yaml`. **`nats.subjects` lives ONLY in `system/system.yaml`.** Write the per-stack sentinel `<S>.yaml` (see the PID landmine above).
3. **Dry-run VALIDATE before touching the daemon:** compose the staged dir and the monolith via `composeRawConfig` (and `loadConfigWithAgents`) and assert deep-equality — the `LoadedConfig` MUST be byte-identical. (This migration staged all three to `~/cortex-config-split-staging/<S>/` and validated there first.)
4. **Repoint the plist:** `PlistBuddy -c "Set :ProgramArguments:3 ~/.config/cortex/<S>/<S>.yaml" ~/Library/LaunchAgents/ai.meta-factory.cortex.<S>.plist`.
5. **Reload ONLY that stack's daemon:** `launchctl unload … && launchctl load …` (never touch sibling stacks).
6. **Verify:** daemon running (`launchctl list`, exit 0), **unique `cortex-<S>.pid`** written, connects to the right NATS, dispatch/review sinks on `local.andreas.<S>.>`, Discord adapters connect, no new errors, siblings unaffected.
7. **Keep the `.pre-split` backup + the monolith** until all stacks are migrated + stable (rollback anchors).

### `networksDir` note
`networksDir` is relative (`./<S>-networks`) and resolves against the config dir, so
post-cutover it points at `~/.config/cortex/<S>/<S>-networks` instead of
`~/.config/cortex/<S>-networks`. This is **moot today** (all stacks `networks: []`,
dirs empty/absent → still byte-identical). If you ever add network fragments, drop
them under the new per-stack dir or make `networksDir` absolute during cutover.

## Rollout order (lowest-risk first — as executed)

1. **halden** — isolated bus, smallest config → piloted the procedure (caught the PID-collision; fixed; re-cut clean).
2. **work** — secondary, shares 4222 (headless, `adapters=0`).
3. **meta-factory** — the 29 KB prod stack, LAST, after the procedure was proven twice.

## Safety / invariants

- `LoadedConfig` is byte-identical either way → zero consumer/runtime change.
- Rollback at any point: point the plist `--config` back at the `.pre-split` monolith (no marker → single-file fallback) and reload.
- `nats.subjects` duplication across files is the double-message footgun (#491) — keep it in exactly one `system/system.yaml` per stack.
- The single-instance guard is keyed on the `--config` **basename** → per-stack sentinel names are mandatory (see the PID landmine).

## Cutover record

| Stack | New `--config` | PID file | Verified |
|---|---|---|---|
| halden | `~/.config/cortex/halden/halden.yaml` | `cortex-halden.pid` | running; Echo connected; sinks on `local.andreas.halden.>` |
| work | `~/.config/cortex/work/work.yaml` | `cortex-work.pid` | running; sinks on `local.andreas.work.>` (headless) |
| meta-factory | `~/.config/cortex/meta-factory/meta-factory.yaml` | `cortex-meta-factory.pid` | running; Forge connected (3 adapters); sinks on `local.andreas.meta-factory.>` |

Monoliths (`cortex.yaml`, `cortex.work.yaml`, `cortex.halden.yaml`) + `.pre-split-*.bak`
retained in `~/.config/cortex/` as rollback anchors.
