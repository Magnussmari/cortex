# Design — Distributed cortex stacks + managed execution (Spawn, reconsidered)

**Status:** direction / pre-ADR · **Date:** 2026-06-19 · **Supersedes premise of:** `docs/design-spawn-integration.md` (on ice, grove-era) · **Refs:** ADR-0013 (sovereign federation), ADR-0017 (surface bundles), the-metafactory/spawn (dormant since 2026-04)

## 0. Why now

Two external products shipped since Spawn was designed, and they *are* what Spawn set out to build:

- **Anthropic Managed Agents** — a hosted service decomposing an agent into **Brain** (Claude + harness), **Hands** (sandboxes), **Session** (durable append-only log); Anthropic manages orchestration + session persistence + sandbox provisioning.
- **Cloudflare** provides the *hands*: code execution in lightweight V8 isolates **or** full microVMs (Cloudflare Containers — Linux, SSH), with credential-injecting egress proxies, Workers VPC / per-agent egress policies; deploy via fork-template → wrangler.

Spawn's own model was head/hands/session with "Claude Managed Agents as a fourth backend" (S-026). **So Spawn is superseded: integrate the shipped product, do not rebuild the engine.**

## 1. The frame: two orthogonal axes

A cortex *stack* today fuses three concerns onto one box (the principal's Mac):
- **head** — the daemon: bus presence, stack identity, surface adapters, orchestration.
- **hands** — the runner's CC sessions (local `Bun.spawn` today).
- **session** — Mission Control's event log.

The two needs sit on two independent axes:

| Axis | Question | Need |
|---|---|---|
| **Execution** (hands) | where does agent work run? | *"scale horizontally for a stack"* |
| **Hosting** (head) | where does the daemon live? | *"a completely isolated stack on its own infrastructure"* |

They compose; they are built differently.

## 2. Mode A — Elastic execution (scale the hands)

The stack stays where it is; the runner dispatches CC sessions to **Managed Agents / CF sandboxes** instead of local `Bun.spawn`. This is Spawn's `ManagedBackend`, now against a real API.

- **Buys:** elastic, isolated, off-machine *capacity* per task; ephemeral sandboxes; no Mac saturation under concurrency.
- **Build:** a runner execution backend that submits a task (brain=Claude, hands=CF sandbox) and bridges results back onto the bus. The runner's backend seam (`execution-backend`-style) is the integration point.
- **Sovereignty:** the existing per-task sovereignty/policy checks still gate WHAT runs; this only changes WHERE.

### 2.1 What "scale horizontally" actually looks like (head + hands)

The **head** is the persistent, identity-bearing orchestrator — the cortex daemon. It holds the stack's identity, bus presence, surface adapters (Discord), dispatch + conversation state, and the durable session log. It is long-lived, stateful, connection-holding, and it *decides* what work happens.

The **hands** are ephemeral, stateless execution units — one sandboxed Claude session per unit of work (review a PR, implement a slice, answer a newcomer). They carry no identity of their own; the head lends each one scoped tools + credentials for its single task, then it's torn down.

Scaling horizontally means the head stops running CC sessions as local `Bun.spawn` — bounded by one machine's CPU/RAM, and a blast-radius risk (a runaway task shares the host) — and instead **spawns each task as a fresh sandboxed hand on separate infrastructure** (Managed Agents / CF). Concretely:

- N concurrent tasks → N sandboxes, not N processes contending for one box. Burst wide for a big review sweep; scale to zero when idle.
- The head stays light — orchestration + connections only; the heavy inference/execution is elastic and off-machine.
- Each hand is isolated: a compromised or runaway task can't reach the head, the stack identity, the secrets, or sibling tasks — egress proxies + per-agent policy enforce the boundary.

This very project is the pattern in miniature: a head spawns parallel adversarial-review hands (correctness / security / behavior lenses), collects their verdicts, and drives the merge — today locally. Moving those hands onto elastic sandboxes is the same shape at scale, off the machine.

The vocabulary is deliberate and now industry-aligned: cortex's "persistent heads vs anonymous hands" = Anthropic's Brain / Hands / Session. The head is **sovereign and persistent** (Mode B — its own infra); the hands are **fungible and ephemeral** (Mode A — elastic sandboxes); the session is the **durable spine** that outlives any hand dying or the brain (model) being upgraded. The three can fail and be replaced independently — which is exactly why a head on a VM can keep spawning hands on CF while the model underneath improves.

## 3. Mode B — Isolated self-hosted stack (relocate the head)

The **entire daemon** runs on separate infrastructure — its own identity, bus participation, lifecycle, and management, independent of the Mac (Mac can be off).

- **Buys:** a genuinely sovereign peer stack; realistic federation testing without depending on a real external peer (e.g. JC); 24/7 stacks decoupled from the laptop; true multi-stack topologies with no single point.
- **Key insight:** Mode B does **not** require Managed Agents. It requires cortex to be a **portable, self-hosting, sovereign deployable unit** — which `arc install Cortex` + config-split layout + ADR-0013 sovereign federation already mostly deliver. Substrate is a choice:
  - **CF Container (microVM)** — elegant (egress/credential proxies, managed provisioning), but CF-coupled.
  - **VPS / fly.io / dedicated box** — full control, no coupling. Likely the better first target for a stack you "manage on its own infrastructure."
- **Does CF host the *head* too?** CF's "full VM" is **Cloudflare Containers** (Linux microVMs). They *can* run a stack daemon, but their model is on-demand / Worker-fronted / scale-to-zero — which suits ephemeral *hands* far better than an always-on, identity-bearing *head* holding persistent NATS-leaf + Discord-gateway connections (those connections never go idle, fighting scale-to-zero + the per-instance duration model). So CF answers Mode A cleanly; for an always-on isolated head, a classic VM/VPS is the natural host. **The elegant shape is the hybrid: head on a VM (Mode B) + hands on CF Managed Agents (Mode A)** — CF does elastic sandboxed execution; the sovereign daemon lives where always-on is cheap and simple. (Verify CF Containers' current always-on / duration limits before betting the head on them.)
- **What a Mode-B stack needs on its box:** Bun + (its own NATS or a leaf to a hub) + config-split dir + its own NKey seed / NSC operator + its bot tokens + its own `arc upgrade` / restart lifecycle.

## 4. The load-bearing decision: the hub must leave the Mac

Today the Mac almost certainly hosts the NATS hub. The instant a stack lives off-Mac **and must run when the Mac is off**, the hub has to leave the Mac too. Two shapes (ADR-0013 already frames this):

1. **Stable off-machine hub** — a small always-on box runs the hub; stacks (Mac + remote) leaf-connect to it. Simplest for a test zone.
2. **Fully sovereign per-stack operators** — each stack roots its own NSC operator and leaf-links peer-to-peer / to a network. The real sovereign model; more setup per stack.

This — not the compute substrate — is the architectural fork. Pick (1) for the first test zone; (2) is the production-sovereign end state.

## 5. Spawn disposition

`the-metafactory/spawn` stays on ice. Its valuable thinking (head/hands/session, capacity gauge, dispatch UX) is now embodied by Managed Agents + this design. The forward work is **integration** (Mode A backend) + **portability/hosting** (Mode B), not reviving the engine. Close/relabel the grove-era Spawn issues accordingly.

## 6. Spikes (prove the direction before committing)

**Spike B1 (priority — the stated need): one isolated stack off the Mac.**
Stand up a single cortex stack on a remote box (start with a VPS/CF Container — whichever is faster), with its own identity, and **federate it with a local Mac stack**. Decide the hub shape (§4) as part of it. Outcome: the first off-machine federation test + proof cortex's daemon + leaf networking run cleanly off-Mac. This is also the foundation of the multi-stack federation **test zone** (N such stacks).

**Spike A1 (follow-on): ManagedBackend prototype.**
Wire the runner to dispatch one CC session to Managed Agents (brain=Claude, hands=CF sandbox) and bridge the result back onto the bus. Outcome: proof of elastic off-machine execution for a stack.

## 7. Open questions

- Secrets on remote infra (NKey seed, NSC operator, bot tokens) — provisioning + rotation off-Mac (CF vault/egress vs VPS secret store).
- How cortex's own Mission Control session/event log relates to Managed Agents' durable Session (dedupe, or MC consumes it?).
- CF Container vs VPS as the default Mode-B substrate (control vs convenience).
- Whether Mode-B stacks should default to sovereign-per-operator (§4.2) or shared-hub (§4.1) for the test zone vs production.
