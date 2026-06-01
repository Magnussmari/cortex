# Glossary — Mission Control Cockpit

> Canonical vocabulary for the Cortex Mission Control cockpit (G-1113). Definitions
> here are the principal-facing source of truth; they track the core concepts in
> [`design-mission-control-cortex-cockpit.md`](./design-mission-control-cortex-cockpit.md)
> §3–§4. When a term in the dashboard, a design doc, or a plan is ambiguous, this
> file decides it.
>
> Tracked under [G-1113 · Mission Control Cockpit](https://github.com/the-metafactory/cortex/issues/354).

---

## Runtime & identity

### Stack

The Cortex runtime boundary. A stack owns its identity, signing key, policy
principals (AAA authorization subjects — distinct from the human
**principal** who owns the stack), agents and presences, its Myelin/NATS
subjects, and its local execution permissions. Written `{principal}/{stack}` — e.g. `andreas/meta-factory`,
`andreas/work`. Mission Control is scoped to **one stack at a time**, with
multi-stack overview a future capability.

### Assistant

A persistent, named being — Luna, PAI, Sage. The assistant is what the principal
thinks of as "who" is doing the work; it persists across sessions, substrates,
and stacks. (Soma's upper identity layer.)

### Cortex Agent

The stack-local daemon/process identity that hosts or represents an
[assistant](#assistant)'s work on Myelin/NATS. Where the assistant is the
durable being, the Cortex agent is the runtime identity with signing provenance
inside one [stack](#stack). One assistant may be represented by different Cortex
agents on different stacks. In `CONTEXT.md`'s house vocabulary this is the bare
term **Agent**.

### Substrate

The runtime where work is actually performed: Codex, Claude Code, Pi.dev, the
Cortex/Myelin daemon, or a future local/remote execution host. The substrate is
the "engine"; the [session](#session) is one run of it.

### Session

One running [substrate](#substrate) interaction. A session carries its
assistant / Cortex agent, [stack](#stack), [task](#task) or [work item](#work-item),
substrate, prompt/input context, event stream, tool calls, status, and attention
state. A task may accrue many sessions over its life.

---

## Work management

### Task

Mission Control's **local** unit of work. A task may originate from many places
— a manual/internal note, a GitHub/GitLab/Jira/Linear issue, an Azure Boards
work item, or a routine- or dispatch-generated request — but it is **not**
identical to its provider object. Provider identity is metadata on the task, not
the task itself — it rides as `provider` / `externalId` / `url` fields on the
work item, not a named type (see the domain model,
[§6](./design-mission-control-cortex-cockpit.md)).

### Plan

The work-management layer **above** tasks. A plan has a source document and a set
of [phases or waves](#phase--wave). Kinds include research, design, migration,
iteration, release, rollout, and incident-response plans. A plan may be backed by
an umbrella issue, a Jira version, an Azure Boards epic, a Linear project, or a
repo-local markdown file.

### Phase / Wave

An ordered slice of a [plan](#plan) that groups [work items](#work-item) under a
high-level concept — e.g. `Phase A — Data foundation`, `Wave 2 — Slack work
stack`, `MIG-7 — top-level Cortex wiring`. "Phase" and "wave" are the **same
structural concept**; the UI uses whichever word the plan itself uses.

### Work Item

The **provider-backed, executable tracking object** under a [phase](#phase--wave)
— a GitHub/GitLab/Jira/Linear issue, an Azure Boards work item, or an internal
Mission Control task. Work items may have child work items; a plan may have an
umbrella work item that rolls up progress from its children.

---

## Software-mode (Git) nouns

> First-class in [Software Mode](#software-mode). The provider is abstracted; the
> Git concept is not. A GitLab merge request maps to the **Pull Request** concept
> while retaining `providerNativeType: "merge_request"` for display and API calls.

### Repository

A source-control repository — the container for branches, commits, and history
under which software-mode work happens.

### Branch

A named line of development within a [repository](#repository). Work items in
software mode typically resolve to a branch.

### Commit

A single recorded change to a [repository](#repository), identified by its SHA.

### Pull Request

A request to merge one [branch](#branch) into another, carrying
[reviews](#review) and [checks](#check). The canonical concept; provider-native
types (GitHub pull request, GitLab merge request) map onto it.

### Review

A human or agent assessment attached to a [pull request](#pull-request) —
approve, request-changes, or comment. In Cortex, agent reviews ride the bus and
surface in the [attention queue](#mission-control-terms).

### Check

A status check or CI signal attached to a [commit](#commit) or
[pull request](#pull-request) — a build, test run, lint, or gate that reports
pass/fail/pending.

### Release

A versioned, published cut of a [repository](#repository) (e.g. a tag promoted to
a published release). The unit deployment targets.

### Deployment

The act (and record) of shipping a [release](#release) or build to an
environment — dev, staging, or production.

### Artifact

A build output produced by a [check](#check)/build or attached to a
[release](#release) — a bundle, image, binary, or report.

---

## Modes

### Generic Mode

The lens that centers tasks, source refs, assignees, status, priority, comments,
[sessions](#session), and attention items. Works for non-software workflows and
for provider backends (Jira, Linear, Azure Boards) when no [Git
objects](#software-mode-git-nouns) are attached.

### Software Mode

The lens that promotes software-development objects — [repositories](#repository),
[branches](#branch), [commits](#commit), [pull requests](#pull-request),
[reviews](#review), [checks](#check), [releases](#release),
[deployments](#deployment), [artifacts](#artifact). The first real Cortex Mission
Control mode, because the immediate principal workflows are software-agent
workflows. (Mirrors how Jira Software turns a generic work-item system into a
software cockpit when connected to source control, CI, and release providers.)

---

## Mission Control terms

A few surface-level terms that recur in the cockpit UI and design docs:

- **Attention queue** — the single "who needs me right now" feed. One entry per
  blocked/waiting [session](#session) or work item needing the principal.
- **Drill-down** — the detail view opened from any card: event log, input
  affordance, and (in software mode) linked Git objects.
- **Working grid** — the live tiles of [Cortex agents](#cortex-agent) with active
  [sessions](#session).
- **Dispatch** — handing a [task](#task)/work item to an agent to start a
  [session](#session).
