# Design — Slack-backed work stack

**Status:** draft for review  
**Branch:** `feat/g-1112-slack-stack`  
**Owners:** Andreas + Soma  
**Target:** add Slack presence to the existing Cortex `work` stack without disturbing the live `meta-factory` stack.

---

## 1. Purpose

We want the existing Cortex `work` stack to connect to Slack through the v2.0.5 Slack adapter. The stack should be safe to pilot alongside the existing local Cortex deployment.

This is not a Slack adapter implementation project. The adapter already exists. This design is about operationalizing it for the `work` stack: config, identity, service behavior, launch procedure, and verification.

## 2. Current state

Cortex `v2.0.5` is live locally. The installed deployment already runs:

- `ai.meta-factory.cortex.relay`
- `ai.meta-factory.cortex.meta-factory`
- `ai.meta-factory.cortex.work`

The work stack already has:

- config: `~/.config/cortex/cortex.work.yaml`
- stack id: `andreas/work`
- signing seed: `~/.config/nats/cortex-work.nk`
- nats identity name: `cortex-work`
- launchd label: `ai.meta-factory.cortex.work`
- agent id: `luna`

The main `meta-factory` stack also declares agent id `luna`. This is
intentional: Cortex supports the same logical agent id appearing in multiple
stacks. The stack identity disambiguates authority and provenance:

- `luna` in `andreas/meta-factory`
- `luna` in `andreas/work`

The principal key is effectively `(principal.id, home_stack)`, not just
`principal.id`.

Slack support already exists in code:

- `src/adapters/slack/index.ts`
- `src/adapters/slack/client.ts`
- `SlackPresenceSchema` in `src/common/types/cortex-config.ts`
- `flattenSlackPresences()` in `src/common/config/loader.ts`
- Slack boot wiring in `src/cortex.ts`

The Slack adapter is Socket Mode based and uses:

- bot token: `xoxb-...`
- app token: `xapp-...`
- workspace id: `T...`
- channel ids: `C...` or `G...`
- operator/principal ids: Slack user ids, `U...`

## 3. Non-goals

- Do not rewrite the Slack adapter.
- Do not replace or reconfigure the existing `meta-factory` stack.
- Do not add Slack thread/channel history fetch in this slice.
- Do not add Slack file upload support in this slice.
- Do not publish real Slack credentials into the repo.
- Do not make `arc upgrade Cortex` manage arbitrary N concurrent stacks in this first pass.

## 4. Constraints

### 4.1 Main worktree remains untouched

Per Compass worktree SOP, all work happens in:

`/Users/andreas/Developer/cortex-slack-stack`

on:

`feat/g-1112-slack-stack`

The primary worktree stays on `main`.

### 4.2 Existing work-stack identity

The Slack surface uses the existing work-stack identity. It should not create a new `andreas/slack` stack or a new signing key.

Current work-stack identity:

```yaml
operator:
  id: andreas

stack:
  id: andreas/work
  nkey_seed_path: ~/.config/nats/cortex-work.nk
```

The Slack adapter is another presence for the work-stack agent, not a new stack.

### 4.2.1 Same agent across stacks

Cortex's current model is one running Cortex process hosts one stack. A
logical agent can still serve multiple stacks by being declared in each stack's
config with the same `agents[].id`, display name, and persona.

For Luna, that means:

- the `meta-factory` daemon hosts `luna` in `andreas/meta-factory`
- the `work` daemon hosts `luna` in `andreas/work`

Those are two stack-local incarnations of the same logical agent. They do not
share one in-memory adapter instance, and they do not share one Slack Socket
Mode connection. Stack identity, NKey signing, policy principals, and subject
prefixes remain stack-scoped.

The Slack pilot should attach Slack to the `work` incarnation of Luna only.
Do not also configure the same Slack app token on `meta-factory`; doing so
would open two Socket Mode consumers for the same app and risks duplicate
inbound delivery.

### 4.3 Runtime files

The pilot should reuse the existing work-stack paths:

- config: `~/.config/cortex/cortex.work.yaml`
- logs: `~/.config/cortex/work-logs/`
- signing seed: `~/.config/nats/cortex-work.nk`
- NATS identity: `cortex-work`

Do not introduce `cortex.slack.yaml` unless review decides Slack must run as a separate process. The current design is one work-stack process with Slack presence configured under `agents[].presence.slack`.

### 4.4 Service identity

The existing work daemon should remain the service boundary:

- `ai.meta-factory.cortex.work`

The first implementation should update and validate the work-stack config, then restart only the work daemon. No new launchd labels are required for the first pilot.

## 5. Proposed stack shape

### 5.1 Work-stack access profile

Before enabling Slack, the work stack must get an explicit least-privilege
Claude/session profile. Otherwise Luna in `andreas/work` and Luna in
`andreas/meta-factory` can both execute local Claude sessions on this machine,
but with whatever broad/default permissions their stack config grants.

Current observed state:

- `andreas/meta-factory` has a broad but explicit repo allowlist in
  `claude.allowedDirs`, `github.repos`, and `claude.bashAllowlist.repos`.
- `andreas/work` currently has empty `claude.allowedDirs`,
  `claude.readOnlyDirs`, and `claude.disallowedTools`.

The Slack pilot must not proceed until `andreas/work` has an explicit access
profile. The profile should define:

- writable repos: the small set of repos Luna may modify from the work stack
- read-only repos: repos Luna may inspect but not modify
- tool policy: whether `Write`, `Edit`, and `NotebookEdit` are allowed
- bash policy: allowed command patterns and repo-scoped bash allowlist
- git provider allowlist: work repos aligned across Cortex config and
  governance docs. Cortex's stack, agent, presence, bus, and local execution
  model are provider-neutral. The existing issue/PR ingestion surface is
  GitHub-specific and is configured under `github.repos`; for Azure
  DevOps-backed repos this may remain empty until an ADO tap exists, while
  `claude.allowedDirs` and `bashAllowlist` carry the local enforcement
  boundary.

Recommended first-pass profile:

```yaml
claude:
  disallowedTools:
    - NotebookEdit
  allowedDirs:
    - ~/Developer/REPLACE_WORK_REPO
  readOnlyDirs:
    - ~/Developer/cortex
  bashAllowlist:
    rules:
      - pattern: ^bun\s+
      - pattern: ^gh\s+
      - pattern: ^git\s+(log|diff|show|status|branch|fetch|remote|rev-parse)\b
      - pattern: ^ls\b
      - pattern: ^pwd$
      - pattern: ^cat\b
      - pattern: ^head\b
      - pattern: ^tail\b
      - pattern: ^wc\b
      - pattern: ^rg\b
      - pattern: ^which\b
    repos:
      - the-metafactory/REPLACE_WORK_REPO
      - the-metafactory/cortex

# Leave github.repos empty for Azure DevOps-backed work unless the repo also
# exists on GitHub and should participate in Cortex's GitHub-specific features.
github:
  repos: []
```

If the work stack should be read-only at first, add `Write` and `Edit` to
`disallowedTools` and keep all repos in `readOnlyDirs`.

The repo list is a product/security decision. Do not copy the full
`meta-factory` repo allowlist into `work` unless the intent is to grant the
same blast radius.

### 5.2 Azure DevOps and governance bootstrap

The work stack is expected to use Azure DevOps as its git backend. Cortex has
provider-neutral primitives for stacks, agents, surfaces, bus subjects,
dispatch, policy, and local execution. It also has GitHub-specific adapters for
webhooks, issue/PR import, repo allowlists, and `gh`-based Mission Control
metadata fetches.

Cortex does not currently have a first-class Azure DevOps tap equivalent to the
GitHub webhook/import path. For the first pilot, treat Azure DevOps as:

- the git remote provider for the allowed local repos
- the work-item/PR system humans use outside Cortex
- a future integration target for a dedicated `azure-devops.*` tap

Do not model Azure DevOps repos in `github.repos` unless the same repo is also
mirrored on GitHub and should use GitHub-specific Cortex features.

The work repos need a Compass-like governance bootstrap before Luna gets write
access from Slack. The goal is the same as metafactory: every repo Luna can
touch tells agents which SOPs, rules, repo boundaries, and review gates apply.

Recommended governance files per Azure DevOps repo:

- `AGENTS.md` or `CLAUDE.md` at repo root
- `.codex/` or `.agents/` rules if that repo uses substrate-specific agent
  instructions
- a repo-local SOP index pointing at the governing process docs
- branch/PR/review rules matching the Azure DevOps project
- allowed command/tool notes for local work in that repo

Minimum content for the governance file:

```markdown
# Agent Rules

## Scope

This repo is part of the `andreas/work` Cortex stack.

## SOPs

- Follow the work-stack SOP index.
- Use a feature branch for changes.
- Open an Azure DevOps PR before merge.
- Do not bypass required reviewers or pipeline checks.

## Local Boundaries

- Work only inside this repo unless the task explicitly names another allowed
  work repo.
- Do not read or write metafactory repos from this stack.
- Treat secrets and customer data as protected.

## Verification

- Run the repo's documented test/lint commands before proposing a PR.
- Include command output in the handoff/update.
```

Implementation should not enable Slack write access until at least one target
Azure DevOps repo has this governance file in place and the repo path is added
to the work-stack access profile.

### 5.3 Minimal Slack config delta

Edit the existing work config:

`~/.config/cortex/cortex.work.yaml`

Draft delta:

```yaml
operator:
  id: andreas
  displayName: Andreas
  slackId: U_REPLACE_ME
  dataResidency: NZ

stack:
  id: andreas/work
  nkey_seed_path: ~/.config/nats/cortex-work.nk

capabilities: []

policy:
  principals:
    - id: luna
      home_operator: andreas
      home_stack: andreas/work
      role: [operator]
      trust: []
      platform_ids:
        slack: [U_REPLACE_ME]
  roles:
    - id: operator
      capabilities:
        - operator
        - keyword.chat
        - keyword.async
        - keyword.team
        - dispatch.luna

agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    trust: []
    presence:
      slack:
        enabled: true
        botToken: xoxb-REPLACE_ME
        appToken: xapp-REPLACE_ME
        workspaceId: T_REPLACE_ME
        channels:
          - id: C_REPLACE_ME
            name: cortex
        allowedUserIds:
          - U_REPLACE_ME
        trustedBotIds: []
        surfaceSubjects:
          - local.andreas.work.system.>
        surfaceFallbackChannelId: C_REPLACE_ME

renderers: []

claude:
  timeoutMs: 300000
```

The snippet is illustrative. The actual change should be made as a narrow patch against the existing `cortex.work.yaml` shape rather than replacing the whole file.

The current work config already grants the `operator` role `keyword.chat`, `keyword.async`, `keyword.team`, and `dispatch.luna`. The expected functional delta is therefore small:

- add `operator.slackId`
- add `platform_ids.slack` to the existing work principal
- add `agents[id=luna].presence.slack`

### 5.4 Credential handling

Real Slack credentials must be inserted only into local operator config. The repo should contain placeholders only.

Required Slack values:

- `xoxb-...` bot token
- `xapp-...` app token with Socket Mode enabled
- `T...` workspace id
- `C...` or `G...` channel id
- `U...` operator Slack user id

Recommended Slack app scopes need confirmation against the Slack app, but the adapter requires at least enough permission for:

- Socket Mode event intake
- `auth.test`
- `chat.postMessage`
- receiving `message` and `app_mention` events

### 5.5 Boot mode

Phase 1 should validate with a foreground work-stack boot:

```bash
bun src/cortex.ts start --config ~/.config/cortex/cortex.work.yaml
```

This keeps the pilot reversible and avoids launchd restart loops while the config is under review.

Phase 2 restarts the existing work daemon:

```text
Label: ai.meta-factory.cortex.work
Config: ~/.config/cortex/cortex.work.yaml
Stdout: ~/.config/cortex/work-logs/cortex-work-bot.log
Stderr: ~/.config/cortex/work-logs/cortex-work-bot.error.log
```

### 5.6 Stack identity provisioning

No new stack identity provisioning is required. The work stack already uses `~/.config/nats/cortex-work.nk`.

Implementation must verify that:

- `stack.id` remains `andreas/work`
- `stack.nkey_seed_path` remains `~/.config/nats/cortex-work.nk`
- `stack.nkey_pub` still matches the work seed

## 6. Rollout plan

### Step 1 — Draft review artifact

Create this design doc and review it before config or service edits.

Exit criteria:

- Confirm Slack attaches to the existing `work` stack.
- Confirm Slack uses existing agent `luna`.
- Confirm work-stack repo/tool access profile.
- Confirm Azure DevOps governance bootstrap shape.
- Boot mode agreed.
- Credential inputs identified.

### Step 2 — Add work-stack access profile

Patch `~/.config/cortex/cortex.work.yaml` with the agreed repo/tool boundary
before adding Slack credentials.

Exit criteria:

- `claude.allowedDirs` and/or `claude.readOnlyDirs` are non-empty.
- `github.repos` is intentionally empty for ADO-only repos or matches the
  intended mirrored GitHub repo set.
- `claude.bashAllowlist.repos` matches the intended work repo set.
- Dangerous edit tools are either intentionally allowed for the writable set
  or explicitly blocked.

### Step 3 — Bootstrap governance in target Azure DevOps repos

For every repo Luna may write from Slack, add a repo-local governance file
before enabling write access.

Exit criteria:

- target repo has `AGENTS.md` or `CLAUDE.md`
- file names the work-stack scope (`andreas/work`)
- file names the Azure DevOps PR/review process
- file names repo-local verification commands
- work-stack allowed dirs and bash allowlist include only reviewed repos

### Step 4 — Add local-only Slack config patch/SOP

Create a local patch plan or SOP for updating:

`~/.config/cortex/cortex.work.yaml`

This should not commit real credentials. A committed example is acceptable if it contains only placeholders.

Exit criteria:

- Updated work config parses with real local Slack values.
- `bun test` covers schema shape if needed.

### Step 5 — Verify existing stack identity

Verify existing work-stack signing:

`~/.config/nats/cortex-work.nk`

Exit criteria:

- Seed file exists with `0600` permissions.
- `stack.nkey_pub` in `cortex.work.yaml` matches the seed.

### Step 6 — Foreground boot

Run the work stack manually with:

```bash
bun src/cortex.ts start --config ~/.config/cortex/cortex.work.yaml
```

Exit criteria:

- Slack adapter logs `started`.
- No policy preflight errors.
- No NKey/signing errors.
- Stack publishes signed envelopes under the expected `local.andreas.work...` subject shape.

### Step 7 — Slack smoke test

From Slack:

1. Mention the bot in the configured channel.
2. Confirm the message reaches Cortex.
3. Confirm a reply posts back to Slack.
4. Confirm untrusted bot/self-loop paths are ignored.

Exit criteria:

- Human operator message dispatches.
- Bot response appears in the correct channel/thread.
- Denied users do not dispatch.

### Step 8 — Restart work daemon

Only after foreground boot succeeds, restart the existing work daemon.

Exit criteria:

- `ai.meta-factory.cortex.work` starts cleanly.
- Existing `meta-factory` service remains running.
- Slack messages still dispatch after launchd restart.

## 7. Verification plan

Before implementation:

```bash
bun test src/adapters/slack/__tests__/schema.test.ts src/adapters/slack/__tests__/slack-adapter.test.ts
```

For config work:

```bash
bun src/cli/cortex/commands/migrate-config.ts ~/.config/cortex/cortex.work.yaml --check
```

If the CLI does not support this final config shape cleanly, add a dedicated config-load smoke instead of forcing the migration CLI.

For launchd work:

```bash
launchctl print gui/$(id -u)/ai.meta-factory.cortex.work
```

For bus identity:

- inspect boot logs for stack signing principal
- confirm `stack.nkey_pub` matches the seed
- confirm subject prefixes remain `local.andreas.work...`

## 8. Risks

| Risk | Mitigation |
|---|---|
| Work daemon restart loop | Validate foreground before touching launchd |
| Credentials leak | Commit placeholders only; real tokens stay in `~/.config/cortex/cortex.work.yaml` |
| Wrong Slack bot id in `trustedBotIds` | Use Slack `B...` bot id for trusted peer bots, not `U...` user id |
| Missing thread context | Accept for pilot; Slack adapter currently returns no context history |
| File uploads silently unsupported | Known v1 limitation; adapter warns and drops files |
| Work-stack identity accidentally changed | Treat `stack.id`, `nkey_seed_path`, and `nkey_pub` as invariant |
| Policy denies all messages | Ensure `policy.principals[].platform_ids.slack` includes the operator `U...` id and role includes `keyword.chat` / `dispatch.luna` |
| Work stack has broad local access | Require explicit `claude.allowedDirs` / `readOnlyDirs`, `github.repos`, and `bashAllowlist.repos` before Slack boot |
| Azure DevOps has no Cortex tap yet | Treat ADO as git/PR backend for the pilot; keep GitHub-specific Cortex features disabled; design an `azure-devops.*` tap separately |
| Work repo lacks governance rules | Require repo-local `AGENTS.md`/`CLAUDE.md` before granting write access |

## 9. Review questions

1. Confirm Slack should attach to `andreas/work`.
2. Confirm the Slack-facing agent remains `luna`.
3. Should the first PR include only docs/SOP, or also a config helper?
4. Should we commit a template file, an SOP, or both?
5. Should the work stack keep `renderers: []`, or should Slack pilot include a dashboard renderer later?
6. Should the work stack trust any peer agents from day one?
7. Which exact repos are writable vs read-only for `andreas/work`?
8. What is the Azure DevOps project/org/repo naming scheme we should encode in examples?
9. Should ADO webhook/work-item ingestion be a follow-up Cortex feature?

## 10. Recommended first PR scope

Keep the first PR narrow:

- Add this design doc.
- Add `docs/sop-slack-work-stack.md` with copy/paste operator steps.
- Add a placeholder patch/example for `cortex.work.yaml`.
- Add a governance bootstrap template for Azure DevOps repos.
- Add a config-load test if the example is meant to stay parseable.

Defer launchd changes until after a human-reviewed foreground boot.
