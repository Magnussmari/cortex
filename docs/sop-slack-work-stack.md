# SOP — Add Slack presence to the work stack

> Operator-facing setup procedure for adding Slack Socket Mode presence to
> the existing Cortex `work` stack (`andreas/work`). This SOP does not create
> a new stack, a new signing key, or a new launchd label.
>
> **Related:** [design-slack-stack.md](./design-slack-stack.md)

## Agent and stack model

This SOP attaches Slack to Luna's existing `work` stack incarnation.

Cortex supports the same logical agent id in multiple stacks. On this machine,
`luna` already appears in both:

- `andreas/meta-factory`
- `andreas/work`

The stack boundary still matters. Each running Cortex daemon hosts one stack
with its own `stack.id`, signing key, policy principals, and NATS identity.
The same logical agent can be declared in both configs, but the Slack Socket
Mode app should have only one owning stack for inbound events.

For this pilot, the owner is:

```yaml
stack:
  id: andreas/work

agents:
  - id: luna
    presence:
      slack: ...
```

Do not add the same Slack `xapp-...` / `xoxb-...` pair to the
`meta-factory` stack.

## Preconditions

- Cortex is installed at `v2.0.5` or newer.
- The work stack exists at `~/.config/cortex/cortex.work.yaml`.
- The work stack signing key exists at `~/.config/nats/cortex-work.nk`.
- The work stack has an agreed repo/tool access profile.
- Target Azure DevOps repos have repo-local governance files.
- The Slack app is installed in the target workspace.
- Slack Socket Mode is enabled for the app.
- You have the Slack identifiers listed below.

## Slack values needed

Collect these before editing config:

| Value | Shape | Where used |
|---|---|---|
| Bot token | `xoxb-...` | `agents[].presence.slack.botToken` |
| App token | `xapp-...` | `agents[].presence.slack.appToken` |
| Workspace/team id | `T...` | `agents[].presence.slack.workspaceId` |
| Channel id | `C...` or `G...` | `channels[].id`, `surfaceFallbackChannelId` |
| Operator user id | `U...` | `operator.slackId`, `policy.principals[].platform_ids.slack`, `allowedUserIds` |
| Peer bot ids, optional | `B...` | `trustedBotIds` |

Use Slack bot ids (`B...`) for trusted peer bots. Do not use Slack bot user
ids (`U...`) in `trustedBotIds`.

## Slack app capability checklist

The Cortex adapter uses Slack Socket Mode plus Web API posting. The app must
be able to:

- open a Socket Mode connection with the `xapp-...` token
- call `auth.test` with the `xoxb-...` token
- receive `message` and `app_mention` events
- post messages with `chat.postMessage`

Keep the Slack app minimal for the pilot. Add file-upload/history scopes only
after Cortex implements those adapter paths.

## Step 1 — Stop only the work daemon

Do not stop the `meta-factory` stack. Stop the work daemon before foreground
testing so two work-stack processes do not share the same NATS identity and
Slack Socket Mode connection.

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.meta-factory.cortex.work.plist
```

If launchd says the service is not loaded, continue.

## Step 2 — Back up the work config

```bash
cp ~/.config/cortex/cortex.work.yaml \
  ~/.config/cortex/cortex.work.yaml.pre-slack-$(date +%Y%m%dT%H%M%S)
```

## Step 3 — Set the work-stack access profile

Before adding Slack, make the `work` stack's local access boundary explicit.
Do not rely on empty defaults.

Edit:

`~/.config/cortex/cortex.work.yaml`

Set the repo/tool boundary under `claude:` and, only when relevant,
`github:`. For Azure DevOps-only repos, `github.repos` can stay empty because
Cortex's GitHub issue/PR ingestion features are provider-specific. The stack,
agent, Slack presence, bus, and local execution boundaries are provider-neutral.

Example shape:

```yaml
claude:
  timeoutMs: 120000
  asyncTimeoutMs: 900000
  additionalArgs: []
  allowedTools: []
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

github:
  repos: []
```

If the pilot should be read-only, use:

```yaml
  disallowedTools:
    - Write
    - Edit
    - NotebookEdit
```

and put every repo under `readOnlyDirs`.

The repo list must be explicit. Do not copy the full `meta-factory` allowlist
unless the work stack should have the same blast radius.

## Step 4 — Bootstrap governance in Azure DevOps repos

Before enabling Slack write access, every writable Azure DevOps repo should
carry the work-stack equivalent of metafactory's Compass/agent rules.

Add one of these at the repo root:

- `AGENTS.md`
- `CLAUDE.md`

Minimum content:

```markdown
# Agent Rules

## Scope

This repo is part of the `andreas/work` Cortex stack.

## SOPs

- Use a feature branch for changes.
- Open an Azure DevOps PR before merge.
- Keep PRs focused.
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

The governance file should name the repo's actual test commands, branch naming
rules, required PR reviewers/checks, and any customer-data handling rules.

## Step 5 — Add Slack to `cortex.work.yaml`

Edit:

`~/.config/cortex/cortex.work.yaml`

### 5.1 Add operator Slack id

Under `operator:`, add:

```yaml
  slackId: U_REPLACE_ME
```

Keep existing `operator.id`, `displayName`, `discordId`, and
`dataResidency` unchanged.

### 5.2 Add Slack platform id to the work principal

In the existing principal for `luna`, change:

```yaml
      platform_ids: {}
```

to:

```yaml
      platform_ids:
        slack:
          - U_REPLACE_ME
```

If `platform_ids` already contains other platforms, preserve them and add the
`slack:` entry alongside them.

### 5.3 Add Slack presence to agent `luna`

Under:

```yaml
agents:
  - id: luna
```

keep the existing disabled Discord presence, then add Slack as a sibling under
`presence:`:

```yaml
    presence:
      discord:
        enabled: false
        token: placeholder-disabled
        guildId: "0"
        agentChannelId: "0"
        logChannelId: "0"
        contextDepth: 10
        enableAgentLog: false
        trustedBotIds: []
        surfaceSubjects: []
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
```

### 5.4 Preserve work-stack invariants

Do not change:

```yaml
stack:
  id: andreas/work
  nkey_seed_path: ~/.config/nats/cortex-work.nk
```

Do not change:

```yaml
nats:
  name: cortex-work
  identity:
    seedPath: ~/.config/nats/cortex-work.nk
```

The Slack presence belongs to the work stack. It is not a new stack.

## Step 6 — Validate the config

Run a preflight check:

```bash
bun src/cli/cortex/commands/migrate-config.ts ~/.config/cortex/cortex.work.yaml --check
```

If this check is too migration-specific for the already-current config, run a
direct foreground boot in the next step and treat schema errors there as the
config gate.

Also keep the Slack adapter tests green before changing launchd state:

```bash
bun test src/adapters/slack/__tests__/schema.test.ts src/adapters/slack/__tests__/slack-adapter.test.ts
```

## Step 7 — Foreground boot

From the Cortex repo or feature worktree:

```bash
bun src/cortex.ts start --config ~/.config/cortex/cortex.work.yaml
```

Expected boot evidence:

- no config schema error
- no policy preflight error
- no NKey/signing error
- log line showing the Slack adapter started
- stack identity remains `andreas/work`

Leave this running for the Slack smoke test.

## Step 8 — Slack smoke test

In the configured Slack channel:

1. Mention the Slack bot.
2. Confirm Cortex receives the message.
3. Confirm Luna replies in Slack.
4. Confirm the reply goes to the expected channel/thread.
5. Confirm an unlisted user cannot trigger the bot if `allowedUserIds` is set.

Known v1 limitations:

- Slack thread/channel history is not fetched into context yet.
- Slack file uploads are not supported yet; file attachments are warned/dropped.

## Step 9 — Restart launchd work daemon

Stop the foreground process with `Ctrl-C`, then restart the normal work
service:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.meta-factory.cortex.work.plist
```

Verify:

```bash
launchctl print gui/$(id -u)/ai.meta-factory.cortex.work | rg "state|last exit|program|arguments"
```

Run one more Slack mention smoke test after launchd restart.

## Rollback

1. Stop the work daemon:

   ```bash
   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.meta-factory.cortex.work.plist
   ```

2. Restore the pre-Slack backup:

   ```bash
   cp ~/.config/cortex/cortex.work.yaml.pre-slack-YYYYMMDDTHHMMSS \
     ~/.config/cortex/cortex.work.yaml
   ```

3. Restart the work daemon:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.meta-factory.cortex.work.plist
   ```

4. Verify:

   ```bash
   launchctl print gui/$(id -u)/ai.meta-factory.cortex.work | rg "state|last exit"
   ```

## Completion criteria

- Work stack boots with Slack presence enabled.
- Slack operator message dispatches to Luna.
- Luna response appears in the configured Slack channel.
- Writable Azure DevOps repos have repo-local governance files.
- Work stack repo/tool allowlist includes only approved work repos.
- `meta-factory` daemon remains running.
- `work` daemon runs under the existing launchd label.
- No real Slack credentials are committed to git.
