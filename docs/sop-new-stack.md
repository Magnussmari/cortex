# SOP — Setting up a new Cortex stack

**Status:** active
**Audience:** operators bringing up a new Cortex stack on an existing or new NATS bus
**Last validated:** 2026-05-19 (against cortex v2.0.3, arc 0.29.0)
**Related:** [`sop-stack-identity.md`](sop-stack-identity.md) (NKey threat model + rotation), [`sop-migrate-config.md`](sop-migrate-config.md) (legacy grove-v2 import — not this doc), [`architecture.md`](architecture.md) §9.1 (schema reference)

This SOP walks through bootstrapping a brand-new Cortex stack from scratch on macOS. The running example is **`andreas/halden`** — a third stack alongside `andreas/meta-factory` and `andreas/work`. Substitute your own operator id and stack name throughout.

---

## 0. Concepts (skip if you already know)

A **stack** is the Cortex runtime boundary: stack identity, signing key, policy principals, agents, presences, NATS subject scope, local execution permissions. One Cortex process == one stack.

An operator can run multiple stacks side-by-side (e.g. `andreas/meta-factory` for ecosystem work, `andreas/work` for day-job, `andreas/halden` for a third project). Each stack:

- Has its own `cortex.{stack}.yaml` config
- Has its own NKey signing identity (`SU…` seed + `U…` pub key)
- Has its own launchd service (`ai.meta-factory.cortex.{stack}.plist`)
- Subscribes to its own subject namespace `local.{org}.{stack}.>`
- Has its own JetStream durable consumer on the shared `CODE_REVIEW` stream

Stacks may share the same NATS broker (typical — the metafactory bus) or run against an isolated broker (uncommon — for fully-private workloads). This SOP assumes the **shared-broker** path because that's the dogfood case.

---

## 1. Prerequisites

```bash
# arc + cortex installed
arc --version    # ≥ 0.29.0 expected
cortex --version # ≥ 2.0.3 expected

# A NATS broker reachable on this host
nats-server --version || echo "install nats-server first"
nc -z localhost 4222 && echo "broker is up"

# nsc context populated (arc nats setup-operator should have run once)
nsc list keys 2>&1 | grep "Operator" | head -1
```

If `arc`, `cortex`, or `nats-server` are missing, install them first (separate runbooks).

For a **brand-new operator** (never run `arc nats setup-operator` before), do that one-time setup first — it provisions the operator + account JWTs the per-bot users will sign under. For an existing operator just adding a new stack, skip ahead.

---

## 2. Decide scope before you start

Three quick questions:

| Question | Decision for `halden` example | Implication |
|---|---|---|
| Shared broker or isolated? | Shared (metafactory bus) | One `nats-server`, one NSC operator account. Subject prefix isolation gives sovereignty. |
| Discord-enabled or bus-only? | Discord-enabled | Need new Discord server / channels / bot token. Skip the Discord section if bus-only. |
| Which assistants live on this stack? | Just Luna for v1; later add Echo / others | Determines `agents[]` entries + Discord bot tokens |

Answer your own three before continuing. The example below assumes "shared broker, Discord-enabled, Luna only."

---

## 3. Provision the NATS identity for the new stack

One command provisions the NATS user + the myelin signing identity in one shot:

```bash
arc nats add-bot halden --with-identity \
  --pub "local.andreas.halden.>" \
  --pub "federated.andreas.halden.>" \
  --pub "system.access.>" \
  --sub "local.andreas.halden.>" \
  --sub "federated.>.tasks.>" \
  --sub "federated.>.agent.>" \
  --sub "_INBOX.>" \
  --output ~/.config/nats/cortex-halden.creds
```

What this does:

- Creates an NKey-based NATS user named `halden` under the active operator account.
- Writes the user credentials to `~/.config/nats/cortex-halden.creds` (NATS CLI / cortex consume this).
- Generates a `SU…` seed + `U…` public key pair. The seed is written under `~/.config/nats/cortex-halden.nk` (mode 0600).
- Registers the principal in myelin's local principal map so signed envelopes from this stack verify against this key.
- Prints the `U…` public key — **copy this**, you need it in §4 below.

The `--pub` / `--sub` flags constrain what this user can publish and subscribe to on the broker. The defaults above:

- Allow this stack to publish to its own local namespace + federation namespace + `system.access.*` for audit.
- Allow subscribing within its local namespace + federation `tasks.*` (so it can claim work) + federation `agent.*` (for G-1114 once it lands) + `_INBOX.>` (NATS request/reply).

Refine these once you know exactly what subjects your stack will use.

---

## 4. Create the stack config

Copy `cortex.yaml.example` from the cortex install into the config directory:

```bash
mkdir -p ~/.config/cortex
cp ~/.config/metafactory/pkg/repos/cortex/cortex.yaml.example ~/.config/cortex/cortex.halden.yaml
```

Now edit `~/.config/cortex/cortex.halden.yaml`. The minimum-viable edits:

### 4.1 `operator:` block

```yaml
operator:
  id: andreas                       # same as your other stacks
  displayName: Andreas
  discordId: "1134325176796987522"  # your numeric Discord id
  dataResidency: NZ
```

### 4.2 `stack:` block

```yaml
stack:
  id: andreas/halden
  nkey_seed_path: ~/.config/nats/cortex-halden.nk
  nkey_pub: UXXXXX...               # the U… key printed by arc nats add-bot
```

### 4.3 `capabilities:` block

The stack catalog. Add an entry for every capability any agent on this stack will provide. Bus-side capability dispatch resolves against this catalog.

For Halden v1 with Luna only:

```yaml
capabilities:
  - id: code-review.typescript
    description: TypeScript code review (correctness, types, idioms)
  - id: dispatch.luna
    description: Direct dispatch to Luna assistant (Halden stack)
  - id: keyword.async
    description: async: keyword routes fire-and-forget tasks
  - id: keyword.chat
    description: plain chat routing
```

### 4.4 `agents:` block

The agents living on this stack. For Halden + Luna only:

```yaml
agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md     # or a halden-scoped persona
    trust: []
    runtime:
      substrate: claude-code
      mode: in-process
      capabilities:
        - code-review.typescript
        - dispatch.luna
        - keyword.async
        - keyword.chat
    presence:
      discord:
        enabled: true
        token: <DISCORD_BOT_TOKEN>
        guildId: <DISCORD_GUILD_ID>
        agentChannelId: <DISCORD_CHANNEL_ID>
        logChannelId: <DISCORD_CHANNEL_ID>
        contextDepth: 10
        enableAgentLog: false
        trustedBotIds: []
        surfaceSubjects: []
```

Get `token` + `guildId` + `agentChannelId` from §5 below if you haven't set up the Discord server yet.

### 4.5 `policy:` block

The minimum self-trust block so this stack's principal can act:

```yaml
policy:
  principals:
    - id: luna
      home_operator: andreas
      home_stack: andreas/halden
      nkey_pub: UXXXXX...           # same as stack.nkey_pub
      role:
        - operator
      trust: []
      platform_ids: {}
  roles:
    - id: operator
      capabilities:
        - code-review.typescript
        - dispatch.luna
        - keyword.async
        - keyword.chat
```

(Pattern lifted from `cortex.work.yaml` — extend per your trust + role model.)

### 4.6 `bus:` block

Point at the local NATS broker + the creds file you provisioned:

```yaml
bus:
  enabled: true
  url: nats://127.0.0.1:4222
  credsPath: ~/.config/nats/cortex-halden.creds
  network: metafactory             # the federation network you participate in
```

---

## 5. Discord setup (skip if bus-only)

1. Go to https://discord.com/developers/applications → New Application → name it (e.g. `Halden Bot`).
2. Bot tab → reset/copy the **bot token** → paste into `cortex.halden.yaml` `agents[0].presence.discord.token`.
3. OAuth2 → URL Generator → scopes: `bot` + `applications.commands` → permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Create Public Threads`, `Send Messages in Threads`. Use the generated URL to invite the bot to your Halden Discord server.
4. In Discord, enable Developer Mode (User Settings → Advanced).
5. Right-click your Halden server → Copy Server ID → paste into `guildId`.
6. Right-click the channel you want the agent to live in → Copy Channel ID → paste into `agentChannelId` and `logChannelId`.

Discord setup done.

---

## 6. Provision the JetStream consumer for this stack

The shared `CODE_REVIEW` stream needs a per-(network, agent) durable consumer so Luna on the Halden stack can pull review tasks:

```bash
arc nats provision-streams --network metafactory --agent luna-halden
```

`--agent` should match what you'd call this agent in the federation. Since the assistant name (`luna`) is shared across stacks, suffix the stack name to disambiguate: `luna-halden`.

Verify:

```bash
nats stream info CODE_REVIEW --server nats://127.0.0.1:4222 2>&1 | head -10
nats consumer ls CODE_REVIEW
# expect to see cortex-review-consumer-metafactory-luna-halden
```

---

## 7. Create the launchd service

Copy the work plist as a template:

```bash
cp ~/Library/LaunchAgents/ai.meta-factory.cortex.work.plist \
   ~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist
```

Edit `~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist`. Five changes:

1. `<key>Label</key>` → `<string>ai.meta-factory.cortex.halden</string>`
2. `--config` arg → `/Users/andreas/.config/cortex/cortex.halden.yaml`
3. `StandardOutPath` → `/Users/andreas/.config/cortex/halden-logs/cortex-halden-bot.log`
4. `StandardErrorPath` → `/Users/andreas/.config/cortex/halden-logs/cortex-halden-bot.error.log`
5. `EnvironmentVariables`:
   - `CORTEX_CHANNEL` → `halden`
   - `CORTEX_AGENT_NAME` → `luna`
   - `CORTEX_AGENT_ID` → `luna-halden`

Create the log directory:

```bash
mkdir -p ~/.config/cortex/halden-logs
```

---

## 8. Start it

```bash
# Validate the config first (boots, prints any validator errors, exits)
cortex start --config ~/.config/cortex/cortex.halden.yaml --validate-only

# Load the launchd service
launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist

# Check it's running
launchctl list | grep cortex.halden
# expect a non-`-` PID in column 1
```

Tail the logs for 30s to confirm clean boot:

```bash
tail -f ~/.config/cortex/halden-logs/cortex-halden-bot.log
```

Look for:

- `cortex: starting (stack=andreas/halden)`
- `myelin-runtime: subscribed to "local.andreas.halden.>"`
- `bus: review-consumer started (durable=cortex-review-consumer-metafactory-luna-halden)`
- No red WARNINGs about missing `nkey_seed_path` or schema validation errors

---

## 9. Verify

Three checks:

**Discord:** send a message in the Halden agent channel — Luna should respond.

**Mission Control:** open `https://grove.meta-factory.ai/` (or your dashboard) — the `andreas/halden` stack should appear with Luna in the WorkingGrid.

**Bus:** publish a test envelope from another stack or via `nats pub`:

```bash
nats pub local.andreas.halden.system.test.ping '{"hello":"halden"}' --creds ~/.config/nats/cortex-halden.creds
# Halden's cortex log should record the inbound envelope
```

---

## 10. Forward-looking notes

- **G-1113 (Mission Control Cockpit)** — once Phase D lands, the Halden stack will appear as its own Plan source / phase / task lineage rather than being lumped with metafactory.
- **G-1114 (Agent Network Topology)** — once Phase B lands, Luna-on-Halden will auto-publish `local.andreas.halden.agent.online.@nkey-...` on boot and the Network view will render Halden as a distinct stack with its own agents (no config-driven listing needed). This SOP becomes "set up + run; the rest pops up on the network view."
- **Federation across stacks** — currently each stack is isolated by subject prefix. To make Halden and Work mutually discoverable, see G-1114 Phase E (federation re-publish opt-in via `cortex.yaml` federation block) once it lands.

---

## Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `cortex start` exits with schema error | YAML structure drifted from v2.0.3 | Diff against `cortex.yaml.example`; check the validator pointer |
| Boot log shows "stack signing OFF" | `stack.nkey_seed_path` missing | Add the path; cortex#324 makes signing default-ON |
| Discord bot online but doesn't respond | `agentChannelId` mismatch OR token revoked | Re-copy channel id; regenerate bot token |
| Dashboard shows nothing | `bus.enabled: false` or wrong `credsPath` | Set `bus.enabled: true`; verify creds file exists and is readable |
| Review-consumer logs "DORMANT" | No capabilities declared on any agent | Add at least one `capability` to `agents[].runtime.capabilities[]` and confirm the catalog covers it |
| `arc nats add-bot` errors with `nsc not found` | NSC not in PATH | `brew install nats-io/nats-tools/nsc` or add to PATH |

---

## What this SOP does NOT cover

- Setting up `nats-server` itself (separate runbook)
- Running `arc nats setup-operator` for the first time (operator-level, one-time)
- Migrating an existing grove-v2 `bot.yaml` — see [`sop-migrate-config.md`](sop-migrate-config.md)
- Cross-stack federation policy — see G-1114 plan §5.5 (forthcoming)
- Linux / systemd unit equivalents — the plist pattern translates 1:1 to a systemd unit; not yet codified here
