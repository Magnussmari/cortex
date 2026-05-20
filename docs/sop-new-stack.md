# SOP — Setting up a new Cortex stack

**Status:** active
**Audience:** operators bringing up a new Cortex stack on an existing or new NATS bus
**Last validated:** 2026-05-19 (dogfooded against cortex v2.0.5 + arc 0.29.0 by standing up `andreas/halden`)
**Related:** [`sop-stack-identity.md`](sop-stack-identity.md) (NKey threat model + rotation), [`sop-migrate-config.md`](sop-migrate-config.md) (legacy grove-v2 import — not this doc), [`architecture.md`](architecture.md) §9.1 (schema reference)

This SOP walks through bootstrapping a brand-new Cortex stack from scratch on macOS. The running example is **`andreas/halden`** — a third stack alongside `andreas/meta-factory` and `andreas/work`. Substitute your own operator id and stack name throughout.

The SOP was dogfooded end-to-end on 2026-05-19. The "Friction log" at the bottom lists every gap surfaced during that run and what was fixed.

---

## 0. Concepts (skip if you already know)

A **stack** is the Cortex runtime boundary: stack identity, signing key, policy principals, agents, presences, NATS subject scope, local execution permissions. One Cortex process == one stack.

An operator can run multiple stacks side-by-side (e.g. `andreas/meta-factory` for ecosystem work, `andreas/work` for day-job, `andreas/halden` for a third project). Each stack:

- Has its own `cortex.{stack}.yaml` config
- Has its own NKey signing identity (`SU…` seed + `U…` pub key) — reuses the NATS auth user NKey ("single-NKey deployment" pattern; see [`sop-stack-identity.md`](sop-stack-identity.md))
- Has its own launchd service (`ai.meta-factory.cortex.{stack}.plist`)
- Subscribes to its own subject namespace `local.{org}.{stack}.>`
- Has its own JetStream durable consumer on the shared `CODE_REVIEW` stream

Stacks may share the same NATS broker (typical — the metafactory bus) or run against an isolated broker (uncommon). This SOP assumes the **shared-broker** path.

---

## 1. Prerequisites

```bash
arc --version           # ≥ 0.29.0 expected
cortex --version 2>&1 | tail -1   # ≥ 2.0.5 expected — tail strips the noisy prompt-filter banner
nats-server --version   # any 2.x
nc -z localhost 4222 && echo "broker UP" || echo "broker DOWN"
nsc list keys | head -10   # operator + account + at least one user
```

For a **brand-new operator** (never run `arc nats setup-operator` before), do that one-time setup first. For an existing operator just adding a new stack, skip ahead.

---

## 2. Decide scope

| Question | Decision for `halden` example | Implication |
|---|---|---|
| Shared broker or isolated? | Shared (metafactory bus) | One `nats-server`, one NSC operator account. Subject-prefix isolation. |
| Discord-enabled or bus-only? | **Bus-only** for first boot (Discord layered on later) | Skip §5; agent `presence` carries disabled placeholders |
| Which assistants live on this stack? | Just Luna for v1 | One `agents[]` entry; one principal |

Answer your own three before continuing. The example below assumes **shared broker, bus-only, Luna only**.

---

## 3. Provision the NATS identity

### 3.1 Naming

Match the existing convention: NSC user name = `cortex-{stack}` (e.g. `cortex`, `cortex-work`, `cortex-halden`). The "agent id" for JetStream consumer naming is separate (see §6), e.g. `luna-halden`.

### 3.2 Create the user

`arc nats add-bot` accepts **comma-separated** ACL values inside a single `--pub` / `--sub` flag. Multiple `--pub`/`--sub` flags are silently dropped — only the last one sticks. (Friction #1.)

```bash
arc nats add-bot cortex-halden --with-identity \
  --pub "local.andreas.halden.>,federated.andreas.halden.>" \
  --sub "local.andreas.halden.>,federated.>.tasks.>,federated.>.agent.>,_INBOX.>" \
  --output ~/.config/nats/cortex-halden.creds
```

What this does:

- Creates an NSC user named `cortex-halden` under your active account.
- Writes the NATS user credentials to `~/.config/nats/cortex-halden.creds` (mode 600).
- **`--with-identity`** generates a separate **Myelin signing key** (ED25519, base64) at `~/.config/metafactory/keys/cortex-halden.key` and registers `did:mf:cortex-halden` in `~/.config/metafactory/principals.json`. This is **not** the NATS NKey used for stack signing — see §3.3.
- Prints the Myelin public key (base64). Don't confuse this with the NATS NKey.

### 3.3 Stage the NATS NKey seed for stack signing

Cortex 2.0.5's `stack:` block in `cortex.yaml` expects a NATS NKey (`SU…` seed, `U…` pub) — the same key the NATS user uses to authenticate. The single-NKey-deployment pattern reuses the NSC-generated user NKey for envelope signing.

`arc nats add-bot` does **not** copy the NSC-stored seed into `~/.config/nats/`. You have to do it manually:

```bash
# 1. Get the NATS NKey public key for this user
USER_PUB=$(nsc list users -a ANDREAS_AGENTS 2>&1 | awk -v u="cortex-halden" '$2==u{print $4}')
echo "NKey pub: $USER_PUB"

# 2. Export the seed (writes to a tmp dir, then copy + chmod)
nsc export keys --user cortex-halden -a ANDREAS_AGENTS --dir /tmp/nsc-export-halden
cp /tmp/nsc-export-halden/${USER_PUB}.nk ~/.config/nats/cortex-halden.nk
chmod 600 ~/.config/nats/cortex-halden.nk
rm -rf /tmp/nsc-export-halden

# 3. Confirm
ls -la ~/.config/nats/cortex-halden.nk
```

Substitute the account name (`ANDREAS_AGENTS`) for your own. (Friction #2.)

### 3.4 If you got the ACLs wrong on creation

`arc nats reissue-bot` does NOT accept `--pub` / `--sub` flags — it only re-issues a fresh creds file with the same JWT. To fix ACLs after creation, drop to `nsc` directly:

```bash
nsc edit user cortex-halden -a ANDREAS_AGENTS \
  --allow-pub "local.andreas.halden.>,federated.andreas.halden.>" \
  --allow-sub "local.andreas.halden.>,federated.>.tasks.>,federated.>.agent.>,_INBOX.>"

# Re-export the updated creds file
cp ~/.local/share/nats/nsc/keys/creds/OP_ANDREAS/ANDREAS_AGENTS/cortex-halden.creds \
   ~/.config/nats/cortex-halden.creds
chmod 600 ~/.config/nats/cortex-halden.creds
```

`nsc describe user cortex-halden` shows only the FIRST pub/sub entry in its table view (display quirk). To see the full ACL list, decode the JWT: `nsc describe user cortex-halden --raw | cut -d. -f2 | base64 -d`.

(Friction #3.)

---

## 4. Create the stack config

The shape that actually works (matches `cortex.work.yaml`, NOT the older comments-heavy `cortex.yaml.example` that drifts on a couple of fields). Write `~/.config/cortex/cortex.halden.yaml`:

```yaml
operator:
  id: andreas
  displayName: Andreas
  discordId: "1134325176796987522"      # your numeric Discord id; remove if no Discord
  dataResidency: NZ

stack:
  id: andreas/halden
  nkey_seed_path: ~/.config/nats/cortex-halden.nk
  nkey_pub: UDD6HVIIQT5DXF46KN2DVLOCJNDFZHSZMGRBZGACRIMZJGE7SEXU7JSM   # paste your $USER_PUB

capabilities: []        # populate when you wire code-review.* or other capabilities

policy:
  principals:
    - id: luna
      home_operator: andreas
      home_stack: andreas/halden
      nkey_pub: UDD6HVIIQT5DXF46KN2DVLOCJNDFZHSZMGRBZGACRIMZJGE7SEXU7JSM
      role:
        - operator
      trust: []
      platform_ids: {}
  roles:
    - id: operator
      capabilities:
        - dispatch.luna
        - keyword.async
        - keyword.chat
        - keyword.team

agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    trust: []
    presence:
      # Bus-only — Discord declared but disabled with placeholders.
      # `presence: {}` is rejected by the validator; the schema wants
      # the full Discord block even when enabled=false.
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

renderers: []           # no dashboard for this stack; meta-factory's dashboard renders all

claude:
  timeoutMs: 120000
  asyncTimeoutMs: 900000
  additionalArgs: []
  allowedTools: []
  disallowedTools: []
  allowedDirs: []
  readOnlyDirs: []

attachments:
  enabled: false
  maxFileSizeBytes: 10485760
  maxTotalSizeBytes: 26214400
  maxAttachmentsPerMessage: 10

execution:
  default: local        # STRING, not object — the example file is wrong about this
  backends: []

github:
  webhookSecret: ""
  repos: []
  agentDetection:
    commitTrailers: ["Co-Authored-By: Claude"]
    branchPatterns: ["^feat/(g|f|i)-\\d+"]
    commentPatterns: ["^Starting:", "^Completed:"]
  receiver:
    enabled: false
    port: 8770
    hostname: 127.0.0.1

paths:
  publishedEventsDir: ~/.claude/events/published-halden
  logDir: ~/.config/cortex/halden-logs

networksDir: ./halden-networks
networks: []

nats:
  url: nats://127.0.0.1:4222
  name: cortex-halden
  subjects: []
  identity:
    seedPath: ~/.config/nats/cortex-halden.nk
    publicKey: UDD6HVIIQT5DXF46KN2DVLOCJNDFZHSZMGRBZGACRIMZJGE7SEXU7JSM
  accountSigningKeyPath: ~/.local/share/nats/nsc/keys/keys/A/DV/ADVSS6ZWIBFMW3S5NUB5WORO4WT4BVTUEF2RZV5RPXQYRKASQT4FS64B.nk
```

Key schema points the example file gets wrong (Friction #4):

- **`nats:` is the NATS connection block** (not `bus:`). Includes `url`, `name`, `subjects`, `identity{seedPath, publicKey}`, `accountSigningKeyPath`. The `bus:` block, if present, is *advanced* and only configures stream/consumer details — leave it out unless tuning JetStream limits.
- **`capabilities[].provided_by: [agent-id]`** — required by the cross-validator when you have any catalog entries. Empty list (`capabilities: []`) is fine for a bus-only minimal stack.
- **`policy.principals[].nkey_pub`** is required.
- **`presence:` for bus-only** must include a `discord:` block with `enabled: false` and placeholder values for `token`/`guildId`/`agentChannelId`/`logChannelId`/`contextDepth`/`enableAgentLog`/`trustedBotIds`/`surfaceSubjects`. The validator rejects `presence: {}` despite what the example comments suggest.
- **`execution.default: local`** is a string, not `{ kind: local }`.
- **`paths`** keys: `publishedEventsDir` + `logDir`. Other names (`worklogs`, `personas`, `state`) are rejected.
- **`accountSigningKeyPath`** points to your NSC-stored account signing key. Find it via `nsc list keys` — the `A…` row marked as Signing Key.

---

## 5. Discord setup (skip if bus-only)

Layer Discord on after the bus-only stack is verified booting. Steps when you do:

1. Discord Developer Portal → New Application → Bot tab → copy bot token → paste into `presence.discord.token` and set `enabled: true`.
2. OAuth2 → URL Generator → scopes `bot` + `applications.commands` → permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Create Public Threads`, `Send Messages in Threads`. Invite the bot to your server.
3. In Discord, enable Developer Mode (User Settings → Advanced).
4. Right-click your server → Copy Server ID → paste into `guildId`.
5. Right-click the channel → Copy Channel ID → paste into `agentChannelId` and `logChannelId`.

---

## 6. Provision the JetStream consumer

```bash
arc nats provision-streams --network metafactory --agent luna-halden
```

Works idempotently — provisions the per-(network, agent) durable on the shared `CODE_REVIEW` stream. Provisioning succeeds even when the stack has no code-review capabilities declared (the consumer just sits idle until the stack declares them).

Verify:

```bash
nats consumer ls CODE_REVIEW | grep luna-halden
# expect: cortex-review-consumer-metafactory-luna-halden
```

---

## 7. Create the launchd service

Copy the work plist (the closest peer to a new bus-only stack):

```bash
cp ~/Library/LaunchAgents/ai.meta-factory.cortex.work.plist \
   ~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist

sed -i '' \
  -e 's|ai.meta-factory.cortex.work|ai.meta-factory.cortex.halden|g' \
  -e 's|cortex.work.yaml|cortex.halden.yaml|g' \
  -e 's|work-logs/cortex-work|halden-logs/cortex-halden|g' \
  -e 's|<string>work</string>|<string>halden</string>|' \
  -e 's|<string>luna-work</string>|<string>luna-halden</string>|' \
  ~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist

plutil -lint ~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist
```

Six values change (Label + --config arg + StandardOutPath + StandardErrorPath + CORTEX_CHANNEL env + CORTEX_AGENT_ID env). `CORTEX_AGENT_NAME` stays `luna`.

Create the log directory:

```bash
mkdir -p ~/.config/cortex/halden-logs
```

---

## 8. Start it

There is no `--validate-only` flag; the way to dry-run is to start the binary directly, watch the log for `cortex: starting` and a clean `myelin-runtime: connected`, then SIGINT.

```bash
# Dry-run validation
cortex start --config ~/.config/cortex/cortex.halden.yaml &
sleep 5
kill %1
```

Then load the launchd service:

```bash
launchctl load ~/Library/LaunchAgents/ai.meta-factory.cortex.halden.plist
sleep 3
launchctl list | grep cortex.halden   # PID column non-`-` means running
tail -f ~/.config/cortex/halden-logs/cortex-halden-bot.log
```

Expected log lines (in order):

```
cortex: starting...
  Agent: Luna
  Stack: andreas/halden
cortex: stack signing key staged — principal=did:mf:andreas-halden
myelin-runtime: nats.url configured, nats.subjects empty — entering pull-only mode
myelin-runtime: connected to nats://127.0.0.1:4222 as "cortex-halden"
cortex: agent registry assembled — 1 agent(s)
cortex: bus-dispatch-listener started — receivingAgentId=luna
cortex: discord instance luna-discord disabled — skipping
cortex: policy-engine active — principals=1 roles=1
config-watcher: watching /Users/andreas/.config/cortex/cortex.halden.yaml for changes
```

Two warnings on a bus-only minimal stack (informational, not errors):

```
WARNING: capability-registry skipped — 0 agents declare runtime.capabilities[].
WARNING: review-consumer skipped — 0 agents declare code-review capabilities.
```

These go away once you add a `runtime.capabilities[]` block to Luna with at least one declared capability.

---

## 9. Verify

**Bus pub** (the canonical smoke test for a bus-only stack):

```bash
nats pub local.andreas.halden.system.smoke '{"hello":"halden"}' \
  --creds ~/.config/nats/cortex-halden.creds -s nats://localhost:4222
# expect: Published N bytes to "local.andreas.halden.system.smoke"
```

**JetStream consumer**:

```bash
nats consumer info CODE_REVIEW cortex-review-consumer-metafactory-luna-halden
# expect a populated info block, "Pull-based", 0 pending unless you've fed it
```

**Process health**:

```bash
launchctl list | grep cortex.halden
# expect: <PID> 0 ai.meta-factory.cortex.halden
```

**Discord** (if configured): send a test message to the agent's channel.

**Dashboard** (if configured): open `https://grove.meta-factory.ai/` and confirm the stack appears. Halden in this SOP runs with `renderers: []` so the stack doesn't host its own dashboard — it surfaces via the meta-factory dashboard if cross-stack rollup is configured.

---

## 10. Forward-looking notes

- **G-1113 (Mission Control Cockpit)** — once Phase D lands, Halden will appear as its own Plan source / phase / task lineage in the cockpit.
- **G-1114 (Agent Network Topology)** — once Phase B lands, Luna-on-Halden will auto-publish `local.andreas.halden.agent.online.@nkey-...` on boot and the Network view will render Halden as a distinct stack. This SOP becomes "set up + run; the rest pops up on the network view."
- **Federation across stacks** — currently each stack is isolated by subject prefix. To make Halden and Work mutually discoverable, see G-1114 Phase E (federation re-publish opt-in) once it lands.

---

## 11. Friction log (from the 2026-05-19 dogfood run)

Surfaced and fixed during the live walkthrough that produced this SOP. Tracked so the next operator doesn't re-trip them.

| # | Issue | Fix landed |
|---|---|---|
| 1 | `arc nats add-bot` `--pub`/`--sub` accept **comma-separated values in ONE flag** only. Multiple `--pub` / `--sub` flags silently drop everything but the last. | §3.2 — single flag, commas. |
| 2 | `--with-identity` generates a Myelin signing key (ED25519, `~/.config/metafactory/keys/`), **not** the NATS NKey seed that `cortex.yaml` `stack:` block expects. The seed lives in the nsc keystore and must be hand-copied. | §3.3 — explicit extract + copy + chmod. |
| 3 | `arc nats reissue-bot` doesn't accept ACL flags. Use `nsc edit user --allow-pub/--allow-sub` and re-export creds. `nsc describe user` shows only the first pub/sub in its table — decode the JWT to see all. | §3.4 documented. |
| 4 | `cortex.yaml.example` and the actual schema diverge on several fields: NATS connection lives in `nats:` not `bus:`, `presence:` for bus-only needs a full `discord` block with `enabled: false`, `execution.default` is a string not an object, `paths` keys are `publishedEventsDir` + `logDir`, `capabilities[].provided_by` is required, `policy.principals[].nkey_pub` is required. | §4 documents the working shape (matches `cortex.work.yaml`). |
| 5 | No `cortex start --validate-only` flag. Dry-run is `start + sleep + kill`. | §8 documented. |
| 6 | `cortex --version` prints a `prompt-filter:` banner before the version. Operators piping to grep get noisy output. | §1 uses `tail -1`. |
| 7 | Stale PID file under `~/.config/grove/state/cortex-cortex.{stack}.pid` (legacy grove path; double-`cortex-` from stack-id-as-filename). Cleaned up at next boot — not blocking. | Noted; deeper fix lives in cortex. |

---

## Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `cortex start` exits with `ZodError` | YAML structure drifted from schema | Diff against §4's worked example, not against `cortex.yaml.example` |
| Boot log shows "stack signing OFF" | `stack.nkey_seed_path` missing or file unreadable | Verify seed exists at the path AND is mode 600 |
| Boot log shows `capability-registry skipped — 0 agents declare runtime.capabilities[]` | Intentional for bus-only minimal stack | Add `runtime.capabilities[]` to an agent once you're ready to wire dispatch |
| Discord bot online but doesn't respond | `agentChannelId` mismatch OR token revoked | Re-copy channel id; regenerate bot token |
| Two stacks fighting over the same port | Both have `renderers:` declaring the same dashboard port | One stack hosts the dashboard (`port: 8766` typical); peers set `renderers: []` |
| `nats pub` from a stack's creds gets "permissions violation" | ACLs too narrow (the `arc nats add-bot --pub/--sub` flag-dropping bug — see Friction #1) | Use `nsc edit user --allow-pub/--allow-sub` to widen, re-export creds |
| `arc nats add-bot` errors with `nsc not found` | NSC not in PATH | `brew install nats-io/nats-tools/nsc` or add to PATH |

---

## What this SOP does NOT cover

- Setting up `nats-server` itself (separate runbook)
- Running `arc nats setup-operator` for the first time (operator-level, one-time)
- Migrating an existing grove-v2 `bot.yaml` — see [`sop-migrate-config.md`](sop-migrate-config.md)
- Cross-stack federation policy — see G-1114 plan §5.5 (forthcoming)
- Linux / systemd unit equivalents — the plist pattern translates 1:1 to a systemd unit; not yet codified here
