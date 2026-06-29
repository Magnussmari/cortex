# Onboarding cortex on Debian 13 (Linux worked example)

> **Status: living guide — walked live.** This is the concrete Debian-13 / Linux
> walk, validated step-by-step by a real from-scratch onboarding. The OS-agnostic
> *conceptual* guide is [`../README-AGENTS.md`](../README-AGENTS.md); this fills in
> the exact Linux commands (`apt`, the NATS binary, `systemd --user`).
>
> Seeded from [@vpzed](https://github.com/vpzed)'s Debian-13 writeup
> ([gist](https://gist.github.com/vpzed/fc3b8da5ee9ecaea4a0d17e567ffbb17)). Sections
> marked **(walking)** are being filled in + verified as the onboarding progresses;
> sections marked ✅ are confirmed working on Debian 13 x64.

## 1. Prerequisites ✅ verified on Debian 13

### Bun

```bash
curl -fsSL https://bun.sh/install | bash
bun --version
```

**Optional hardening (recommended) — Bun supply-chain scanner:**

```bash
bun add -g @socketsecurity/bun-security-scanner
```

```toml
# ~/.bunfig.toml
[install.security]
scanner = "@socketsecurity/bun-security-scanner"
```

### Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
claude    # complete the login wizard once
```

### arc (metafactory package manager)

```bash
sudo apt install git          # gh optional: sudo apt install gh && gh auth login
git clone git@github.com:the-metafactory/arc.git ~/arc
cd ~/arc && bun install && bun link
arc --version
```

`bun link` is the **install** step — it puts the `arc` command on your `PATH` from
this source checkout (not a dev-only step). If you use a GitHub token for `gh`, a
read-scoped token is enough for cloning + release notes.

### NATS server (with JetStream)

Download the Linux binary and **verify its checksum before running it**:

```bash
VER=v2.12.11
wget https://github.com/nats-io/nats-server/releases/download/$VER/nats-server-$VER-linux-amd64.tar.gz
sha256sum nats-server-$VER-linux-amd64.tar.gz     # compare against the release's published SHA256
tar xfz nats-server-$VER-linux-amd64.tar.gz
./nats-server-$VER-linux-amd64/nats-server --version
```

Put `nats-server` on your `PATH` (e.g. copy it into `~/.local/bin`). JetStream is
built into the server; it's enabled per-config (§2), not by a separate build.

## 2. Stand up your stack — **(walking)**

_To be filled + verified as the walk reaches it. The conceptual steps are
README-AGENTS §3–§5; the Linux specifics land here:_

- `cortex stack create <slug> --principal <you> --apply` — scaffold the config-split stack
- Fill the `<REPLACE_ME>` secrets; `arc upgrade Cortex` (or run from source) provisions the signing seed
- **Stand up the bus** — one isolated `nats-server` per stack (port is per-stack; see README-AGENTS §4). On Linux: a **`systemd --user`** unit (`~/.config/systemd/user/…`, `systemctl --user enable --now`) or run directly while testing (`nats-server -c ~/.config/nats/<slug>.conf`)
- Start + verify the daemon (`bun src/cortex.ts start --config <pointer>`, or a systemd user unit)

## 3. Federate (optional) — **(walking)**

_To be filled when the walk reaches it. Conceptual: README-AGENTS §6 +
[`sop-onboard-peer-principal.md`](sop-onboard-peer-principal.md):_

- `cortex network provision` → `cortex network make-live` (operator-mode bus, zero raw `nsc`)
- `cortex network join` + register → raise a PENDING admission request
- a network admin approves it (Tier-2) → your stack joins the network

---

*This guide is co-developed with the person walking it; each stage is verified on a
real Debian-13 install before it loses its **(walking)** marker.*
