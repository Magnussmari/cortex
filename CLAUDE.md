<!-- Generated from metafactory ecosystem template. Customize per cortex. -->

# cortex — Layer-7 collaboration surface

cortex is the **M7 application** of the metafactory Myelin stack — the operator's collaboration surface that consumes the bus (M2–M6) and presents activity to humans. It replaces both `the-metafactory/grove` (legacy v0.29.0) and `the-metafactory/grove-v2` (v0.22.1 active dev) as the canonical home for Discord/Mattermost adapters, Mission Control dashboard, workflow runner, and bus-side taps.

**Status:** v0.1.0 — MIG-0 bootstrap. No source code yet. See `docs/architecture.md` for the canonical design and `docs/plan-cortex-migration.md` for the working migration plan that will populate `src/` over MIG-1..MIG-8.

<!-- inject:after:description -->

## Architecture

cortex is the layer-7 application in the OSI-style **M1–M7 Myelin stack**:

```
M7 SURFACES (cortex, pilot, signal-collector, future apps) ← cortex lives HERE
M6 COMPOSITION (myelin)
M5 DISCOVERY   (myelin)
M4 IDENTITY    (myelin — MY-400)
M3 ENVELOPE    (myelin — schema + namespace)
M2 TRANSPORT   (myelin abstraction over NATS)
M1 CONNECTIVITY (NATS leaf nodes / federation)
```

cortex consumes contracts from M2–M6, owns no part of M1–M6 itself, and shares M7 with sibling apps (pilot for review-loop coordination, signal for telemetry, future apps).

Internal componentisation (per `docs/architecture.md` §8):

```
cortex/src/
  bus/         — M2–M6 client code (NATS connection, envelope validator,
                 surface-router; the G-1100 ladder lifted from grove-v2)
  surface/     — operator surfaces (Mission Control v3, future TUIs)
  adapters/    — platform-specific (Discord, Mattermost, Slack, PagerDuty)
  runner/      — workflow runner (CC orchestration, worklog state)
  taps/        — publishers onto the bus (CC hooks, GitHub webhooks)
  cli/         — operator CLIs (discord, cldyo-live)
  common/      — shared types + utilities
```

Read `docs/architecture.md` for the full layered model + agent + presence/renderer model + event architecture + agent task routing pattern (folds in myelin#36's three distribution modes).

## Migration provenance

cortex inherits source from `the-metafactory/grove-v2`. Legacy `the-metafactory/grove` (v0.29.0) is in maintenance-mode for security work and contributes nothing to cortex (per migration plan §2.2 — ~6,500 LOC of legacy-only agent/persona/AAA + parallel NATS work that does not migrate).

The migration is phased MIG-0 (this bootstrap) through MIG-8 (legacy retirement). Per-phase task lists are filed as GitHub issues `cortex#1` umbrella (C-100) + `cortex#2..#9` for each phase.

<!-- inject:after:critical-rules -->

## Critical Rules

- NEVER describe code you haven't read. Use Read/Glob/Grep to verify before making claims.
- NEVER fabricate file names, class names, or architecture. If unsure, read the source.
- Fix ALL errors found during type checks, tests, or linting — even if pre-existing or introduced by another developer. Never dismiss errors as "not from our changes." If you see it, fix it.
- Before fixing a bug or implementing a feature, ALWAYS check open PRs (`gh pr list`) and issues (`gh issue list`) first. Someone may already be working on it, or there may be a PR ready to merge that addresses it. Don't duplicate work — review what exists before racing to write code.
- Before merging a PR, verify the branch is up to date with the base branch. If other PRs have merged since the branch was created, rebase or merge base into the branch first. Squash merges on stale branches silently overwrite changes that landed in the interim — this has caused data loss in adjacent metafactory repos.
- During migration phases (MIG-0..MIG-8), every PR cites a phase + checklist item from `docs/plan-cortex-migration.md`. The plan is the ground truth for what moves where; if the plan and reality disagree, update the plan first, then the code.
- The architecture spec (`docs/architecture.md`) is **static reference** — when the plan and architecture disagree on what cortex IS, the architecture wins. When the plan and reality disagree on migration mechanics, the plan wins (or is updated, never silently).

## GitHub Labels (ecosystem standard)

All metafactory ecosystem repos use a shared label set applied via compass-core's `sync-labels.ts`. Do not create ad-hoc labels.

| Label | Description | Color | Purpose |
|-------|-------------|-------|---------|
| `bug` | Something isn't working | `#d73a4a` | Defect tracking |
| `documentation` | Improvements or additions to documentation | `#0075ca` | Docs work |
| `feature` | Feature specification | `#1D76DB` | Feature work |
| `infrastructure` | Cross-cutting infrastructure work | `#5319E7` | Infra/tooling |
| `now` | Currently being worked | `#0E8A16` | Priority: active |
| `next` | Next up after current work | `#FBCA04` | Priority: queued |
| `future` | Planned but not yet scheduled | `#C5DEF5` | Priority: backlog |
| `handover` | NZ/EU timezone bridge — work session summary | `#F9D0C4` | Async handoffs |
| `migration` | Cortex migration phase work (MIG-0..MIG-8) | `#7057FF` | Per-phase migration |

Every issue must have at least one type label (`bug`, `feature`, `infrastructure`, `documentation`) and one priority label (`now`, `next`, `future`) if open. Migration-phase issues additionally carry the `migration` label.

## GitHub Issue Tracking

When working on a GitHub issue in this repo, keep the issue updated as you work. Default agent behavior, not optional.

**On starting work:** comment with what you're working on, which sub-task / checkbox.

**During work:** when a sub-task checkbox is completed, tick it on the issue. When you create a PR, link it to the issue (`closes #N` or `gh pr create` with issue reference).

**On completing work:** comment with a summary; tick completed checkboxes; close if all done.

GitHub is the shared collaboration surface. Team members and agents all read it. If work happens but the issue isn't updated, it looks like nothing happened.

## Standard Operating Procedures

This repo follows ecosystem SOPs defined in [compass](https://github.com/the-metafactory/compass). **Before starting work, identify which SOPs apply and read them. Output the pre-flight line from each loaded SOP.**

| SOP | Activate when | File |
|-----|--------------|------|
| **dev-pipeline** | Creating branches, making PRs | `compass/sops/dev-pipeline.md` |
| **versioning** | After merging PRs, before deploying | `compass/sops/versioning.md` |
| **worktree-discipline** | Starting feature work (always) | `compass/sops/worktree-discipline.md` |
| **design-process** | Creating specs / design docs | `compass/sops/design-process.md` |
| **pr-review** | Reviewing a PR before approving | `compass/sops/pr-review.md` |
| **retrospective** | Post-iteration retro | `compass/sops/retrospective-and-process-mining.md` |
| **new-repo-pattern** | (drove THIS bootstrap) | `compass/sops/new-repo-pattern.md` |

## Migration Workflow

cortex is in MIG-0..MIG-8 mode until the migration completes. Per-phase work follows:

1. Pick a phase from `docs/plan-cortex-migration.md` §4 (e.g. MIG-1 bus runtime)
2. Open an issue / continue an existing one (cortex#2..#9)
3. Pick a checklist item from the phase plan
4. Create a feature branch: `git worktree add ../cortex-{slug} -b feat/c-{id}-{slug} origin/main`
5. Implement the move/refactor (most files are ports from grove-v2; few new)
6. Push + open PR with title `feat(cortex): C-NNN.X — {scope} (MIG-N.Y)`
7. Drive PR through pilot-loop review (Echo for code review)
8. After merge: tick the checkbox on both `docs/plan-cortex-migration.md` and the GitHub issue
9. Close phase issue when all phase steps tick

Each PR is small (one or a few related checklist items). The migration plan IS the project plan; treat its checklists as the work breakdown structure.

After MIG-8 the migration plan retires. cortex switches to normal feature-work mode (use blueprint.yaml for cross-repo dependency tracking; SOPs as above).

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
