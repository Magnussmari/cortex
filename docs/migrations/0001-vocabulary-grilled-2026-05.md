# Cortex — Vocabulary Migration Manifest (2026-05)

**Status:** draft for review · deterministic ground truth · **iteration 2** (5 criticals + 4 importants closed; counts re-verified)
**Source:** `CONTEXT.md` (cortex) + `CONTEXT.md` (myelin) + `CONTEXT-MAP.md` (compass/ecosystem) — grill-with-docs sessions, May 2026
**Method:** every entry below was produced by `git grep` against `main` (commit `c61a607`, re-verified 2026-05-21). Each cited line is a real occurrence in the codebase at that commit; nothing is inferred. Iteration 2 re-ran *every* count and re-pinned *every* exact `file:Lnn` against the current `main` HEAD — `c61a607` is still the tip of `origin/main` (confirmed by `git fetch origin main && git rev-parse origin/main` on 2026-05-21), but the iteration-1 counts were measured loosely and several were materially wrong (see "count corrections" below); they are now corrected. Counts are **line counts** (`git grep -c` summed — lines containing the token), not occurrence counts, unless explicitly noted. For the heaviest prose clusters (`operator` in `cortex.ts`, `docs/`), the manifest gives the file, the verified line count, and the known line clusters, and defers the per-line transcription to a PR-time `grep` pass — exactly as the myelin manifest does for `specs/namespace.md`. Driver, schema, wire, and config-grammar files carry exact `file:Lnn`.

**Count corrections (iteration 1 → iteration 2, verified at `c61a607`):** `operator` in `src/` was claimed "3,162 lines across ~280 files" → actual **2,584 lines across 298 files**; `operator` in `docs/` claimed "~1,400" → actual **1,124 lines**; `{org}` claimed "342 in docs/" → actual **143 lines in `docs/`** (175 occurrences), **199 lines in `src/`**, **347 lines repo-wide**. Per-file: `cortex-config.ts` "115" → **96**; `stack.ts` "43" → **39**; `cortex.ts` "114" → **95** `operator` + 11 `{org}`; `network-registry` carve-out "241" → **191** lines. A deterministic ground-truth document cannot carry unverified counts — these are now all re-pinned.

Read this as the script: each PR claims one rename or one file/cluster, performs every listed change, runs `bunx tsc --noEmit && bun test`, opens for review.

**The principal has decided the full vocabulary rename proceeds** — this is the cortex half of a root-cause fix across the ecosystem (myelin's companion manifest is `myelin/docs/migrations/0001-vocabulary-grilled-2026-05.md`). cortex **consumes** myelin's published language; cortex's Tier-2/Tier-3 PRs MUST land in lockstep with myelin's companion releases. This manifest's job is to make cortex's rename *correct, complete, and safe to execute*.

---

## Scale note (read first)

`operator` alone is **2,584 lines across 298 files** in `src/`, plus **1,124 lines across `docs/`** (verified at `c61a607`, 2026-05-21). This is an order of magnitude larger than the myelin manifest's surface. The manifest is therefore structured in two registers:

- **Exact `file:Lnn`** — for the *load-bearing* files: the config schema (`cortex-config.ts`, `stack.ts`), the bus-wire driver files (`src/bus/myelin/*`), the vendored schema, the `migrate-config` CLI, `cortex.yaml.example`, and `CLAUDE.md`/`agents-md`. These are where a wrong edit breaks compilation, the wire, or a deployed config.
- **File + verified count + known clusters** — for the *bulk-prose* files (`cortex.ts` comments, the ~40 `docs/*.md` design docs). Each gets a CI-grep guard (completion signal §2); the PR author transcribes per-line at PR time against a fresh `grep`. This is the myelin manifest's `specs/namespace.md` discipline applied at cortex's scale.

The CI grep guard (completion signal §2) is what makes the bulk-prose register *safe*: nothing slips through because the guard fails on any un-allow-listed `operator`/`{org}`.

---

## Rename inventory (canonical)

| #   | Old | New | Tier | Scope | Source |
|-----|---|---|---|---|---|
| C-R1  | `operator` — the human (`OperatorSchema`, `Operator` type, `operator:` config block, "the operator" prose) | `principal` (`PrincipalSchema`, `Principal`, `principal:`) | 2 (config schema) / 1 (prose) | config + code + prose | cortex-Q «operator→principal» |
| C-R2  | `operator.id` (`cortex.yaml` key) | `principal.id` | **2 (config-file format)** | config schema + every deployed `cortex.yaml` | cortex-Q |
| C-R3  | `operatorId` / `agent.operatorId` (code property + variable) **and** `operatorDiscordId` / `operatorMattermostId` / `operatorSlackId` / `operatorRoleId` | `principalId` / `agent.principalId` / `principalDiscordId` / … | 1 (internal) / 2 (where on a parsed config shape) | code | cortex-Q |
| C-R4  | `home_operator` (policy / `PolicyPrincipalSchema` field, MC worker SQL column) | `home_principal` | 2 (config + DB column) | config schema + code + SQL + prose | cortex-Q |
| C-R5  | `{org}` (subject-grammar token in cortex's subject-building code + docs) | `{principal}` | 3 (code) / 1 (comments+docs) | code + grammar + prose | cortex-Q3 (myelin owns grammar) |
| C-R6  | `org` (code parameter / variable in subject builders — `source.org`, `opts.org`, `orgFromConfig`) | `principal` | 3 (code — positional/keyed param) | code | cortex-Q3 |
| C-R7  | `Broadcast` / `"broadcast"` (dispatch mode — **vendored** `distribution_mode` enum value) | `Offer` / `"offer"` | **3 (wire enum — vendored from myelin)** | vendored schema + validator + test fixtures + prose (cortex *reads/validates* `distribution_mode`; emits none) | cortex-Q13b |
| C-R8  | `signed_by[].principal` / `originator.principal` (myelin wire fields cortex **reads**) | `.identity` | **3 (wire — consumed from myelin)** | vendored schema + validator + every accessor + tests | myelin-R2 (cortex consumes) |
| C-R9  | `target_principal` (myelin envelope wire field cortex **reads**) | `target_assistant` | **3 (wire — consumed from myelin)** | vendored schema + validator + dispatch path + tests | myelin-R13 (cortex consumes) |
| C-R10 | `"Myelin stack"` (the M1–M7 architecture) | `"Myelin layer model"` | 1 | prose | cortex-CONTEXT «stack vs layer» |
| C-R11 | `topic` (NATS-subject sense) | `subject` | 1 | prose | cortex-Q «topic→subject» |
| C-R12 | `persona` — the named-being *entity* sense | `assistant` | 1 | prose | cortex-Q «persona→assistant» |
| C-R13 | `@{principal}` / `@{org}` (subject segment) → `@{assistant}` ; `"principal address"` prose | `@{assistant}` / `"assistant address"` | 1 | grammar + prose + code comments | cortex-Q5 |
| C-R14a | `operator` prose — mechanically resolvable to `principal` | `principal` | 1 | prose | cortex-Q2 |
| C-R14b | `operator` prose — genuinely ambiguous (explicitly deferred, listed) | TBD by follow-up grill | — | prose | cortex-Q2 |

### Renames this manifest does NOT make (carve-outs)

- **`src/services/network-registry/` (the SERVICE only) — `operator_id` / `operator_pubkey` / `OperatorRecord` / `/operators/{operator_id}` REST routes.** The task brief flagged this service as a carve-out on the hypothesis that it handles *network-level* operator registrations. **Investigation contradicts the hypothesis** (see the dedicated decision below). `network-registry`'s `operator_id` is `{operator_id}/{stack_slug}` — e.g. `andreas/laptop`, `andreas/server` — i.e. it is *exactly* the `principal` (one human, multiple stacks, one pubkey). **The SERVICE TREE is still carved out of this manifest** — but for a *different, stronger* reason: it is a self-contained Cloudflare-Worker service with its own REST-API + signed-wire-schema versioning lifecycle, and folding its rename into the myelin-coupled lockstep PRs would entangle two independent release trains. It gets its **own** follow-up manifest (`0002-network-registry-vocabulary.md`). See "network-registry carve-out — reasoned decision" below. **The cortex-side CLIENT of this service is NOT carved out** — `src/common/registry/` + `src/bus/network-resolver.ts` live in `src/` and are handled by *this* manifest (see the dedicated "network-registry CLIENT" section); only their `0002`-wire-coupled JSON keys are lockstep-flagged.
- **WebSocket fan-out `broadcast`** — `broadcastEvent`, `broadcastIterationCreated`, `broadcastTaskUpdated`, `broadcastTransition`, and ~230 sibling hits across `src/surface/mc/`. This `broadcast` is the *NATS/WS fan-out mechanism verb* (broadcasting an event to every connected dashboard client) — **not** the dispatch mode. It is correct vocabulary and stays. Mirrors the myelin manifest's R12a decision ("the named mode is Offer; the transport behaviour is still a broadcast").
- **NSC operator-account terminology** — any `nsc operator`, `OP_*`, NSC-CLI "operator account" references. NATS infra terminology, not the cortex `operator`-the-human concept. Left unchanged (none found in `src/` at `c61a607` outside docs; PR-time grep confirms).
- **Legacy `grove` / `mf.net-{op}` references** — `docs/architecture.md:139` `mf.net-{op}.events.>` and any `mf.net-{operator}` legacy-subject citation describe the pre-myelin subject shape. Historical record; left verbatim (C-R14b).
- **`personas/*.md` filenames + the `persona:` config field + `persona-format.ts` / `docs/persona-format.md`** — the *file-format* sense of `persona` is correct and stays. `docs/persona-format.md` is wholly about the persona-file format; **no entity-prose rename applies to it** (verified — every hit is "persona file" / "persona format"). Only the *entity* sense ("the persona Luna") renames under C-R12, and cortex already overwhelmingly says "agent"/"assistant" for the entity — C-R12 is a near-zero rename (see C-R12 section).

### C-R8/C-R9 note — cortex CONSUMES, it does not OWN

`signed_by[].principal`, `originator.principal`, `target_principal`, and `distribution_mode` are **myelin's wire grammar**. cortex carries a *vendored copy* of myelin's schema at `src/bus/myelin/vendor/envelope.schema.json` and a vendored validator at `src/bus/myelin/envelope-validator.ts`. cortex does not redefine these — it **re-vendors** when myelin re-cuts them. Therefore:

- The cortex C-R7/C-R8/C-R9 PRs are **companion PRs** to specific myelin releases (myelin-R2/R11/R13). They land *after* myelin's transition release and *before* myelin's breaking major.
- During myelin's back-compat window, cortex's consuming code reads BOTH old and new field names (`env.originator?.identity ?? env.originator?.principal`).
- The vendored schema/validator update is a **mechanical re-vendor**, not a cortex design change. The PR cites the myelin release it re-vendors from.

---

## network-registry carve-out — reasoned decision

**The task brief's hypothesis:** "`src/services/network-registry/` genuinely handles network-level operator registrations; its internal 'operator' terminology is NATS/network-aligned."

**The evidence (read `src/services/network-registry/src/types.ts` + `README.md`):**

- `network-registry/src/types.ts:12` — `stack_id : {operator_id}/{stack_slug}`. The `operator_id` is the *first* segment of a stack id.
- `network-registry/src/types.ts:25-27` — *"A single stack identity belonging to an operator. An operator can declare multiple stacks (e.g. `andreas/laptop`, `andreas/server`) and the registry stores them as a flat list keyed by operator."*
- `network-registry/src/types.ts:71` — `operator_pubkey` — one Ed25519 pubkey per `operator_id`.
- `README.md:14-15` — `POST /operators/{operator_id}/register`, `GET /operators/{operator_id}`.

**Conclusion:** `network-registry`'s `operator_id` is **not** a network-level concept. It is *exactly* `cortex:principal` — one human, who owns one pubkey and runs multiple stacks (`andreas/laptop`, `andreas/server`). The brief's hypothesis is **wrong**; under the canonical glossary this service's `operator` should be `principal` (`OperatorRecord` → `PrincipalRecord`, `operator_pubkey` → `principal_pubkey`, `/operators/{operator_id}` → `/principals/{principal_id}`).

**The decision — still carve it out, for a stronger reason:** `network-registry` is a standalone Cloudflare-Worker service (`wrangler.toml`, its own `bun install`, its own test rig, DNS at `network.meta-factory.ai`) with a **public signed REST-API contract**. Renaming its wire is a Tier-3 change to *that service's* API, on *that service's* release cadence — independent of myelin's envelope-schema cadence. Folding it into this manifest's myelin-lockstep PR train would couple two unrelated release trains and inflate every cortex Tier-3 PR's blast radius.

**Action:** the `network-registry` SERVICE TREE's vocabulary rename is **deferred to a dedicated follow-up manifest** `docs/migrations/0002-network-registry-vocabulary.md` (filed as a cortex issue). Until then, the **191 `operator` lines under `src/services/network-registry/`** (verified at `c61a607`; iteration 1 said "241") are on the CI-grep allow-list (completion signal §2) — explicitly excepted, not silently skipped. The follow-up manifest will handle: `OperatorRecord`→`PrincipalRecord`, `operator_id`/`operator_pubkey` JSON keys, the `/operators/*` routes (with a `/principals/*` route + a deprecation-window alias for the old path), `src/services/network-registry/__tests__/operators.test.ts` → `principals.test.ts`, and the `home_operator` field that appears in `network-registry/src/types.ts` (C-R4 — flagged for review: this one field bridges both manifests; resolve in lockstep).

**Coupling to the cortex-side client:** `0002` MUST cross-reference *this* manifest's "network-registry CLIENT" section. The client (`src/common/registry/client.ts`, `types.ts`, `__tests__/client.test.ts`, `src/bus/network-resolver.ts`) reads this service's `operator_id`/`operator_pubkey` JSON keys and mirrors its `OperatorRecord` shape — those wire-coupled reads rename in **lockstep** with `0002`'s API rename, in a `0002`-companion cortex PR. The client's *cortex-native code identifiers* (the `operatorId` params/locals/private fields) are NOT deferred — they rename in PR-5 of this manifest. Two registers, one for each side of the HTTP boundary.

---

## Per-file changes

### `src/common/types/cortex-config.ts` — the config schema (DRIVER — land early)

The Zod schema for `cortex.yaml`. **96 `operator` hits** (iteration 1 said 115 — re-verified at `c61a607`). This file defines `OperatorSchema` and the `operator:` config key — every deployed `cortex.yaml` is shaped by it. **Tier 2 (config-file format).** Exact lines for the schema-defining block; PR-time grep for the comment cluster. The config *reader* that consumes this schema is `src/common/config/loader.ts` (see its dedicated section — it carries the C-R2 dual-key-read change).

- **C-R1 + C-R2** — the schema definition:
  - L87 `export const OperatorSchema = z.object({` → `export const PrincipalSchema = z.object({`
  - L131 `export type Operator = z.infer<typeof OperatorSchema>;` → `export type Principal = z.infer<typeof PrincipalSchema>;`
  - L1798 `operator: OperatorSchema,` (the key in `CortexConfigSchema`) → `principal: PrincipalSchema,` — **this is the `cortex.yaml` top-level `operator:` → `principal:` key rename. Config-file-format change. See the `cortex.yaml` deployment-migration section.**
  - L1859 error-message literal `"use \`operator:\` + \`agents:[]\` per architecture §9.1. "` → `"use \`principal:\` + \`agents:[]\` …"`
- **C-R3** — the `operatorDiscordId` / `operatorMattermostId` / `operatorSlackId` fields inside `OperatorSchema` (L110–114 region — PR-time grep `operator` L110–125): each `operatorDiscordId` etc. is a *field of the schema*; the field keys themselves are `discordId` / `mattermostId` / `slackId` already (verify at PR time — the comments say "Operator's Discord user id"). The **comments** rename `Operator's` → `Principal's`.
- **C-R5** — `{org}` token in the `OperatorSchema.id` doc (L89 region `* Operator identifier — used as the \`{org}\` subject segment … (\`local.{org}.…\`)`) → `{principal}` / `local.{principal}.…`.
- **C-R14a** — the comment cluster: L7 `*   operator:                  who is running this cortex instance` → `principal:` ; L79 `// Operator — who is running this cortex instance` → `// Principal — …` ; L83–84 the `OperatorSchema` doc block ("The operator is the human…", "grove-v2's `agent.operatorId`…") → "The principal is the human…", "`agent.principalId`" ; L98, L100, L106 (the validation-error string `"operator id must be lowercase…"` → `"principal id must be lowercase…"`) ; L119 ; L159, L185, L198, L223, L236, L242, L311, L338 — every "operator" prose hit. **PR-time `grep -n 'operator\|Operator' src/common/types/cortex-config.ts` enumerates all 96; each gets a per-line call.** Known: the schema-structural ones above are exact; the rest are comments + the `home_operator` field (next entry).
- **C-R4** — the `home_operator` field on `PolicyPrincipalSchema`:
  - L1197 `home_operator: z.string().regex(` → `home_principal: z.string().regex(`
  - L1192 comment `* grammar — \`OperatorSchema.id\` enforces it at the operator` → `\`PrincipalSchema.id\` … at the principal`
  - L1346 comment `* Peer operator id — same letter-prefix grammar as \`OperatorSchema.id\`.` → `Peer principal id … \`PrincipalSchema.id\``
- **Config-schema note (C-R2):** renaming the top-level `operator:` key (L1798) is a **config-file-format change** — `loadConfig` reads `operator:` off every deployed `cortex.yaml`. The renaming PR MUST: (a) accept BOTH `operator:` and `principal:` keys on read for one minor cycle (prefer `principal:`), (b) emit only `principal:` when `migrate-config` writes, (c) log a deprecation warning when `operator:` is read. Treat exactly like myelin's `PrincipalRegistryFile.principals` config-key change. See "`cortex.yaml` deployment migration" below.

### `src/common/config/loader.ts` — the config loader (DRIVER — the dual-key-read site for C-R2)

The config *schema* (`cortex-config.ts`) defines the `operator:` key; **`loader.ts` is the file that READS it** off every deployed `cortex.yaml` and does the structural cortex-shape detection. The C-R2 back-compat plan ("config loader accepts both keys for one minor cycle") names *this* file — iteration 1 omitted it, which left the C-R2 plan with no implementation site. **41 `operator` hits, 6 `operatorId` hits.** Tier 2 (it is the reader of the config-file format). Exact lines for the structural detection.

- **C-R2 — the structural dual-key detection (exact):**
  - L84 `operator?: {` — the `operator` field on the `LoadedConfig` projection type → `principal?: {`
  - L116 comment `* Detect whether \`raw\` is a cortex-shape config (operator + agents[]) vs` → `(principal + agents[])`
  - L119 comment `* The check is structural — must have \`operator:\` (object) AND \`agents:\`` → `must have \`principal:\` (object) AND \`agents:\``
  - L146–147 `raw.operator !== null && typeof raw.operator === "object"` — the runtime structural test → **dual-key during the migration window:** `((raw.principal ?? raw.operator) != null && typeof (raw.principal ?? raw.operator) === "object")`. The loader prefers `principal:`; when only `operator:` is present it reads it and logs the one-line deprecation warning naming `cortex config migrate` (C-R2 plan).
  - L177 comment `* Detection is structural: presence of \`operator:\` (object) + \`agents:\`` → `presence of \`principal:\` …`
  - L168 comment `* or cortex-shape \`cortex.yaml\` (operator: + agents:[] …` → `principal: + agents:[]`
- **C-R3 (structural code) — the loader projects the config onto `LoadedConfig`:**
  - L362 `operatorId: cortexConfig.operator.id,` (synthesised `BotConfig.agent` — see the `BotConfig` legacy-shape decision in `config.ts`; the *legacy field* `operatorId` may stay, but `cortexConfig.operator.id` → `cortexConfig.principal.id`) — PR-time: resolve against the C-R3 / legacy-`BotConfig` decision.
  - L355, L362–364, L370, L404–413 — every `cortexConfig.operator.*` read → `cortexConfig.principal.*` (follows the schema rename in PR-1).
- **C-R14a** — the comment bulk (L30, L59, L69, L72, L78–82, L92, L99, L197, L264, L269, L280–285, L341, L351, L368, L403) — "operator" → "principal". PR-time `grep -n 'operator' src/common/config/loader.ts` enumerates all 41.
- **Loader note (C-R2):** `loader.ts` is the **single read-site** that makes the `operator:`→`principal:` key rename non-breaking. The PR-1 back-compat regression test (rollback artefact §4) exercises *this* file with both an `operator:`-keyed and a `principal:`-keyed `cortex.yaml`. Lands in PR-1 alongside `cortex-config.ts`.

### `src/common/config/watcher.ts` — config hot-reloader (C-R3)

Hot-reloads `cortex.yaml` on change. **1 `operatorId` hit** (plus `operatorName` / `operatorDiscordId` / `operatorMattermostId` siblings in the change-detection field list).

- **C-R3** — L95 `"agent.operatorId",` (a watched field-path literal) → `"agent.principalId",` ; L96 `"agent.operatorDiscordId",` → `"agent.principalDiscordId",` ; L97 `"agent.operatorMattermostId",` → `"agent.principalMattermostId",` ; L68 `"agent.operatorName",` → `"agent.principalName",`. These string literals are **dotted field-paths into the parsed config shape** — they MUST flip in lockstep with the `agent.*Id` field renames (C-R3 on `LoadedConfig`/`BotConfig.agent`). If `BotConfig.agent.operatorId` is kept as a legacy model (see `config.ts` decision), the watched paths that target the *legacy* shape stay; the ones targeting the cortex-native shape rename — PR-time per-line call against the C-R3 decision.
- **C-R14a** — L494 comment `// Skip debounce for explicit triggers — operator wants the reload now.` → `principal wants the reload now.`
- Lands in PR-6 (non-wire code) — depends on PR-1.

### `src/common/types/stack.ts` — stack-id grammar (DRIVER)

**39 `operator` hits** (iteration 1 said 43 — re-verified at `c61a607`). Defines the `{operator_id}/{stack_id}` grammar + the `ParsedStackId.operator` field.

- **C-R6** — the parsed-stack-id field:
  - L151 `operator: string;` (the `{operator_id}` segment field on the parsed shape) → `principal: string;`
  - L150 comment `/** The \`{operator_id}\` segment. */` → `/** The \`{principal_id}\` segment. */`
- **C-R5 / C-R14a** — the grammar comments: L5 `* one operator can run multiple cortex stacks side-by-side` → `one principal can…` ; L7–8 `local.{operator}.{stack}.…` / `local.{operator}.…` → `local.{principal}.…` ; L13 `\`{operator_id}/{stack_id}\`` → `{principal_id}/{stack_id}` ; L16, L18, L25, L27, L36, L52, L64, L66, L68, L80, L81, L84, L88, L95 (the `stack.id` regex error string `"stack.id must match {operator_id}/{stack_id} format…"` → `{principal_id}/{stack_id}`), L116, L128, L145 — every "operator" → "principal" / `{operator_id}` → `{principal_id}`. PR-time grep enumerates all 39.
- **Stack-id grammar note:** `{operator_id}/{stack_id}` is a **wire/identity grammar** (it surfaces as the `local.{principal}.{stack}.…` subject prefix and as `did:mf:<principal>-<stack>`). The *grammar shape* (`A/B` slash form) does not change — only the token *name* `{operator_id}` → `{principal_id}`. No runtime data migration needed for the grammar itself; the data migration is the `cortex.yaml` `operator.id` → `principal.id` (C-R2).

### `src/bus/myelin/vendor/envelope.schema.json` — vendored wire schema (Tier 3 — re-vendor)

cortex's **vendored copy** of myelin's envelope schema. **Updates by re-vendoring from myelin, not by hand-editing the design.** 2-space JSON.

- **C-R8** — `signed_by` stamp `principal` keys + `originator.principal`:
  - L179 `"required": ["principal", "attribution"],` (originator) → `["identity", "attribution"]`
  - L181 `"principal": {` (originator property) → `"identity": {`
  - L211 `"required": ["method", "principal", "signature", "at"],` (ed25519 stamp) → `["method", "identity", "signature", "at"]`
  - L214 `"principal": { "type": "string", "pattern": "^did:mf:…` (ed25519 stamp property) → `"identity": { … }`
  - L222 `"required": ["method", "principal", "stamped_by", "signature", "at"],` (hub-stamp) → `["method", "identity", "stamped_by", …]`
  - L225 `"principal": { "type": "string", "pattern": "^did:mf:…` (hub-stamp property) → `"identity": { … }`
- **C-R7** — `distribution_mode` enum:
  - L168 `"enum": ["broadcast", "direct", "delegate"],` → `["offer", "direct", "delegate"]` (target; transition release accepts both — see distribution_mode plan)
  - L169 description `"… broadcast = competing consumers; …"` → `"offer = competing consumers; …"` ; same line `"operator-facing routing semantics"` → `"principal-facing routing semantics"` (C-R14a)
- **C-R9** — `target_principal`:
  - L171 property key `"target_principal": {` → `"target_assistant": {`
  - L174 description references `target_principal` → `target_assistant`
  - L201 `"then": { "required": ["target_principal"] }` → `["target_assistant"]`
- **C-R14a** — L110 `"description": "DID of principal receiving/paying for this work."` — here "principal" means the human → **keep** (correct vocabulary). L159 `"… bidding (F-10) = broadcast bid-request …"` — "broadcast" as a *verb* describing the bidding flow → rewrite to "offer" for consistency; carries no wire weight.
- **Re-vendor note:** when myelin bumps its schema `$id` to `…/envelope/v2`, this vendored file's `$id` follows. Keep the v1 vendored copy until cortex's last v1-replaying consumer drains (see JetStream replay note).

### `src/bus/myelin/envelope-validator.ts` — vendored validator (Tier 3)

The vendored validator + the `DistributionMode` type + the `getActorPrincipal` accessor. **9 hits relevant.**

- **C-R7** — `DistributionMode`:
  - L285 `export type DistributionMode = "broadcast" | "direct" | "delegate";` → transition: `"broadcast" | "offer" | "direct" | "delegate"`; post-major: `"offer" | "direct" | "delegate"`
  - L162 comment table `* | \`broadcast\` | competing consumers — first ack wins |` → `| \`offer\` | …`
  - L152 comment `* | \`bidding\` | F-10 broadcast bid-request, …` — "broadcast" here is the bidding-flow verb → rewrite to "offer bid-request" for consistency (no wire weight).
- **C-R8** — `signed_by[].principal` / `originator.principal` accessors:
  - L186 `originator?: Originator;` — the `Originator` interface's `principal` field renames (PR-time: find the `Originator` interface decl in this file or `types.ts`) → `identity`
  - L402 `return last?.principal;` → `return last?.identity;`
  - L413 comment `*   1. \`envelope.originator?.principal\` — explicit policy-attribution` → `originator?.identity`
  - L417 comment `*   2. \`envelope.signed_by[0]?.principal\` — first stamp in the chain.` → `signed_by[0]?.identity`
  - L442 `if (envelope.originator?.principal) return envelope.originator.principal;` → `originator?.identity` / `originator.identity` — **back-compat read during myelin's window: `envelope.originator?.identity ?? envelope.originator?.principal`**
  - L444 `return chain[0]?.principal;` → `chain[0]?.identity` (back-compat: `chain[0]?.identity ?? chain[0]?.principal`)
  - L183 comment `* directly — that helper falls back to \`signed_by[0].principal\` …` → `signed_by[0].identity`
- **C-R9** — `target_principal`:
  - L171 `target_principal?: string;` (the `MyelinEnvelope` field decl) → `target_assistant?: string;`
  - L163 comment `* | \`direct\` | named recipient — requires \`target_principal\` |` → `target_assistant`
  - L164 comment `* | \`delegate\` | … requires \`target_principal\` …` → `target_assistant`
  - L168 comment `* F-021 — required when \`distribution_mode\` is \`direct\` or \`delegate\`.` (context for `target_principal`) — verify the field name on the surrounding decl
  - L50 comment `*     \`distribution_mode\`, \`target_principal\` per F-021.` → `target_assistant`
- **C-R5** — L37 comment `*   segment, emitting the 6-segment \`{prefix}.{org}.{stack}.{type}\` form` → `{prefix}.{principal}.{stack}.{type}`
- **C-R14a** — L205 comment `*     originator (service principal acting on behalf of an operator).` → `acting on behalf of a network` (the org-that-runs-a-hub sense → `network`, matching myelin-R12a).
- **`getActorPrincipal` rename:** the exported helper `getActorPrincipal` (referenced L493/L512 in the test) — its *name* contains "Principal" in the *myelin-identity* sense (it returns the actor's DID, which post-rename is an `identity`). Rename `getActorPrincipal` → `getActorIdentity`; keep a deprecated `export { getActorIdentity as getActorPrincipal }` alias for one minor. PR-time `grep -rn 'getActorPrincipal' src/` enumerates callers.

### `src/bus/myelin/runtime.ts` — subject-builder runtime (DRIVER — Tier 3)

**37 `{org}`/`org`/`operator` hits.** The `{org}` placeholder substituter + the `org` parameter.

- **C-R6** — `org` code identifier:
  - L291 `org: string;` (option field on the substituter input) → `principal: string;`
  - L297 `s.replaceAll("{org}", opts.org).replaceAll("{stack}.", stackToken),` → `s.replaceAll("{principal}", opts.principal)…`
  - L377 `org: orgFromConfig(config.agent.operatorId),` → `principal: principalFromConfig(config.agent.principalId)` (depends on `orgFromConfig` rename + C-R3)
  - `orgFromConfig` function → `principalFromConfig` (PR-time grep for the decl + callers)
- **C-R5** — `{org}` token in comments: L60–62 (`local.{org}.{type}` / `federated.{org}.{type}` / `public.{type}` with `no {org} segment`), L64, L71, L159, L237–243, L277, L286, L358, L363, L365 (`runtime-org-symmetry.test.ts` path — see test-file-rename note), L367, L371, L373–374 — every `{org}` → `{principal}`. PR-time grep `grep -n '{org}' src/bus/myelin/runtime.ts`.
- **C-R14a** — L65 `agent.operatorId` → `agent.principalId` ; L79, L237, L249, L277 "operator" prose → "principal".
- **Test-file rename:** `src/bus/myelin/__tests__/runtime-org-symmetry.test.ts` → `runtime-principal-symmetry.test.ts` (`git mv`). The "org symmetry" invariant becomes "principal symmetry". Fix the path reference at `envelope-validator.ts:507` and `runtime.ts:365`.

### `src/cortex.ts` — top-level entrypoint (DRIVER — heaviest prose cluster)

**95 `operator`/`Operator` hits + 11 `{org}` hits** (iteration 1 said "114" — re-verified at `c61a607`: 95 `operator`-family lines, 11 `{org}` lines). The brief's "~20 callsites in an earlier scan" was a floor. This is the single heaviest prose+code cluster. Exact lines for the *structural* hits; PR-time grep for the comment bulk.

- **C-R3 (structural code)** — known structural hits:
  - L279 `operator?: {` (a field on a local projection type) → `principal?: {`
  - L325 `operator: { id: config.agent.operatorId ?? "default" },` → `principal: { id: config.agent.principalId ?? "default" }`
  - L272 `* from \`OperatorSchema\` via \`LoadedConfig.operator\`.` → `\`PrincipalSchema\` via \`LoadedConfig.principal\``
  - L321 `* fallback path (no \`options.stack\`, no \`agent.operatorId\`)` → `agent.principalId`
- **C-R5** — `{org}` in comments: L314 `6-segment \`local.{org}.{stack}.{type}\` grammar` → `local.{principal}.{stack}.{type}`.
- **C-R8** — L1703 comment `pre-Phase-B (cortex#114) unverified \`signed_by[0].principal\` claims.` → `signed_by[0].identity`.
- **C-R14a (prose bulk)** — the remaining ~86 hits are comments: "the operator's existing `bot.yaml`", "Operators running multiple cortex instances", "operator-DM target", `notifyOperator`, "operator logs", etc. **PR-time `grep -n 'operator\|Operator\|{org}' src/cortex.ts` enumerates all 95 + 11; the PR author transcribes per-line.** The `notifyOperator` *function name* → `notifyPrincipal` is a code rename (PR-time grep for the decl + every caller); keep a deprecated alias only if it is exported (it is internal — verify; if internal, no alias).
- **CI guard:** after this PR, `check:vocab` (completion signal §2) asserts zero `operator` in `src/cortex.ts`.

### `src/cli/cortex/commands/migrate-config-lib.ts` + `migrate-config.ts` + `migrate-config-policy.ts` — the migrate-config CLI

**96 + 2 + 70 `operator` hits.** This CLI converts grove-v2 `bot.yaml` / `cortex.yaml` → `cortex.yaml`. It is **the tool that emits the `operator:` block** — so it is *also* the tool that must emit `principal:` post-rename, and (critically) the tool that performs the `cortex.yaml` `operator:` → `principal:` data migration.

- **C-R3 (structural)** — `migrate-config-lib.ts`: L52–55 `operatorId?` / `operatorName?` / `operatorDiscordId?` / `operatorMattermostId?` (legacy-input shape fields) → `principalId?` etc. ; L73 `operatorRoleId?` → `principalRoleId?` ; L125 `operator?: {` (the cortex-shape projection) → `principal?: {`.
- **C-R1 / C-R14a** — `migrate-config-lib.ts` L102, L111, L121, L136, L237, L245, L251, L292–297 (the "Lift the operator block" doc) — "operator" → "principal". `migrate-config.ts` L103 `"cortex migrate-config — convert grove-v2 bot.yaml…"` (help text) — verify no "operator" ; the **CLI command name `migrate-config` stays** (it migrates *config*, not "operators").
- **C-R4** — `migrate-config-policy.ts` + its test: `home_operator` → `home_principal` (it builds the `PolicyPrincipalSchema` block). PR-time grep `home_operator`.
- **New behavior — the data migration:** `migrate-config` MUST gain a path that rewrites a deployed `cortex.yaml`'s `operator:` block to `principal:` (key rename, `operator.id` → `principal.id`). This is the **`cortex config migrate` step** myelin's manifest cross-references. It is idempotent (re-running on an already-`principal:` file is a no-op) and preserves every nested value. See "`cortex.yaml` deployment migration".
- **PR-time grep** enumerates all 96+70 lines; the `__tests__/migrate-config*.test.ts` fixtures (`*.bot.yaml` under `__tests__/fixtures/`) carry `operatorId` / `operator:` keys — rename those fixture keys in lockstep (they exercise the migrator).

### `src/cli/cortex/commands/cloud.ts` — the cloud-network CLI command (C-R3)

**15 `operatorId` hits** verified at `c61a607`. This command reads/writes the `cloud-network` config — it carries `operatorId` on its option shapes (L81 `operatorId: string;`, L87 `operatorId: ${opts.operatorId}`, L97, L112 `Operator ID:      ${opts.operatorId}`, L120 `operatorId: opts.operatorId`, …). The `operatorId` here is the **same `cloud.operatorId`** that `src/bus/network-resolver.ts:98/105` destructures off `network.cloud` (see the network-registry CLIENT section) — so `cloud.ts` and `network-resolver.ts` rename **together**.

- **C-R3** — every `operatorId` (option-shape field, local, output label) → `principalId`. PR-time `grep -n 'operatorId' src/cli/cortex/commands/cloud.ts` enumerates all 15.
- **PR routing:** added to **PR-6** scope (CLI / non-wire code) alongside the adapters and runner — but it must land in the **same PR as `network-resolver.ts`** (PR-5/PR-6 must agree on the `network.cloud.operatorId` → `.principalId` shape; if `network-resolver.ts` is in PR-5 and `cloud.ts` in PR-6, both depend on the same `network.cloud` schema change — sequence them or fold both into PR-5).

### `src/common/policy/` — `home_operator` + policy principal model (C-R4)

`engine.ts`, `types.ts`, `factory.ts`, `resolve-access.ts`, `tool-inventory.ts` + their tests. The policy model has a `home_operator` field on the `PolicyPrincipalSchema`-derived shape.

- **C-R4** — every `home_operator` → `home_principal`. Files (PR-time `grep -rln home_operator src/common/policy/`): `factory.ts`, `types.ts`, `__tests__/engine.test.ts`, `__tests__/resolve-access.test.ts`, `__tests__/policy-gate.test.ts`, `__tests__/factory.test.ts`.
- **C-R8 (comments)** — `engine.ts` L173, L177, L180 ; `types.ts` L14, L130, L135 — `signed_by[].principal` → `signed_by[].identity` (the myelin wire field). **NB: "declared local principal" / `PolicyPrincipalSchema` in policy is cortex's OWN `principal` (the human) — that is already-correct vocabulary and does NOT rename. Only the `signed_by[].principal` *myelin-field* references rename.** This file mixes both senses — per-line care required.
- **`home_operator` note:** `home_operator` is a **persisted config field** (`cortex.yaml` `policy:` block) AND a **DB column** in the MC worker (see `src/surface/mc/worker/schema.sql` + `migrations/0003_sovereignty.sql`). Tier 2. The renaming PR accepts both column/key names for one cycle; the worker ships a SQL migration `ALTER TABLE … RENAME COLUMN home_operator TO home_principal` (see MC-worker section).

### `src/common/types.ts` + `src/common/types/config.ts` + `src/common/registry/types.ts`

- **C-R3** — `config.ts` (`operatorId` on the legacy `BotConfig.agent` shape) — the legacy `agent.operatorId` field. Decision: the **legacy `BotConfig`** shape is the *input* to `migrate-config`; renaming its fields is a breaking change to the legacy reader. **Keep `BotConfig.agent.operatorId` as-is** (it models a historical file format that pre-dates the rename) — flag for review (C-R14b-adjacent). The *cortex-native* `LoadedConfig` shape renames; the *legacy* `BotConfig` shape stays as a faithful model of old files.
- **C-R4 / C-R8 (comments)** — `types.ts` L66 `home_operator — \`signed_by[0].principal\` operator segment` → `home_principal — \`signed_by[0].identity\` principal segment`.
- **C-R3** — `registry/types.ts` `operatorId` (PR-time grep) → `principalId` where it is the cortex-native shape.

### `src/common/event-processor.ts` (C-R8 + C-R4)

- **C-R8** — L21 comment `\`signed_by[0].principal\` (after \`did:mf:\` strip → operator segment)` → `signed_by[0].identity` … `principal segment`.
- **C-R4** — `home_operator` references → `home_principal`.

### `src/bus/` — bus client code (subject-building + wire consumption)

The bus directory builds subjects (`{org}` token) and consumes myelin wire fields. Files with relevant hits: `system-events.ts` (23), `dispatch-handler.ts` (39), `github-events.ts` (7), `review-consumer.ts` (9), `capability-registry.ts` (7), `surface-router.ts` (14), `bus-dispatch-listener.ts` (10), `dispatch-events.ts` (10), `review-events.ts` (6), `network-resolver.ts` (4), `verify-signed-by-chain.ts` (11), `payload-filter.ts` (6).

- **C-R6** — the `source.org` accessor pattern. `system-events.ts:88` `` return `${src.org}.${src.agent}.${src.instance}`; `` → `${src.principal}.…` ; `github-events.ts:76`, `capability-registry.ts:212`, `bus-dispatch-listener.ts:190` — same pattern → `.principal`. **NB: this `src.org` is the first segment of myelin's `source` field — which myelin-R6 re-grammars to `{principal}.{stack}.{assistant}`. The accessor `.org` → `.principal` is cortex following myelin's `source`-shape rename. Companion to myelin-R6.**
- **C-R5** — `{org}` in comments across all bus files (PR-time `grep -rn '{org}' src/bus/`).
- **C-R8** — `verify-signed-by-chain.ts` L330 `const principal = stamp.principal;` → `const identity = stamp.identity;` ; L9, L25, L80, L86, L90, L101–104 (the `VerifyFailure` union variants `malformed_principal` / `principal_has_no_nkey_pub` carry a `principal:` field — rename the field key → `identity:`; the *kind* string `"malformed_principal"` is an error-discriminant — see error-string lockstep), L109, L335, L344, L351, L362, L392. **`verify-signed-by-chain.ts` consumes `stamp.principal` — myelin-R2's wire field. Companion to myelin-R2.** The `VerifyFailure.kind` discriminants (`"malformed_principal"` etc.) — decision: rename to `"malformed_identity"` etc. for consistency, BUT these are matched in `cortex.ts:1703`-region and tests — error-string lockstep applies (flip kind + matchers in one PR).
- **C-R8** — `system-events.ts` L566, L785 (`signed_by[0].principal`), L877 `const principalId = opts.signedBy[0]?.principal ?? "unknown";` → `?.identity`.
- **C-R8** — `surface-router.test.ts:1888` `(payload.signed_by as { principal: string }[])[0]?.principal` → `{ identity: string }[]…?.identity`.
- **C-R11** — `surface-router.test.ts:1283` comment `the adapter never subscribed to the topic in the first place.` → `subscribed to the subject`. **This is the ONLY genuine NATS-sense `topic` hit in `src/` — C-R11 is a one-line rename.**

### `src/substrates/` + `src/common/substrates/` — substrate harnesses (C-R6 / C-R8 / C-R4 — wire + identity)

`git grep substrates` returns a tree iteration 1 omitted entirely. **`src/substrates/bus-peer/harness.ts:190` builds a NATS subject from `source.org`** — the exact `source.org`→`source.principal` wire pattern (C-R6) the manifest treats with exact citations in `src/bus/`. The substrate harnesses are *substrate adapters* (the bus-peer harness and the claude-code harness); they emit and consume envelopes. Trees: `src/substrates/bus-peer/`, `src/substrates/claude-code/`, `src/common/substrates/`. Verified at `c61a607`.

- **C-R6 (structural — exact)** — `src/substrates/bus-peer/harness.ts:190`
  `` source: `${this.source.org}.${this.source.agent}.${this.source.instance}`, `` → `${this.source.principal}.${this.source.agent}.${this.source.instance}`. This is the bus-peer harness's outbound-envelope `source` field — **identical to `system-events.ts:88`'s `${src.org}.…` pattern.** Companion to myelin-R6 (`source` grammar). Tier 3. `harness.ts` also carries **6 `operator`** lines total — the rest are C-R14a prose.
- **C-R8 (wire — exact)** — `src/substrates/bus-peer/__tests__/harness.test.ts` carries **7 `signed_by` hits** (L147, L284, L393, L560, L647, L681, L702 — envelope fixtures + a `next.value.signed_by` accessor). These are myelin-R2's `signed_by[].principal` wire field — every fixture stamp + accessor renames `.principal` → `.identity` in lockstep with PR-7/PR-8. Tier 3 (companion to myelin-R2).
- **C-R4 (config-field reference — exact)** — `src/common/substrates/types.ts:411` comment `` * `principal.home_operator` / `home_stack` for sovereignty-aware `` → `principal.home_principal`. `types.ts` also carries **15 `operator`** lines (C-R14a prose — the substrate types describe "the operator's stack" etc.). `src/common/substrates/__tests__/types.test.ts` carries 1 `operator` hit.
- **C-R14a** — `src/substrates/claude-code/harness.ts` (6 `operator`), `src/substrates/claude-code/__tests__/harness.test.ts` (8 `operator`), `src/substrates/bus-peer/__tests__/harness.test.ts` (1 `operator` beyond the `signed_by` set) — "operator" prose → "principal". PR-time `grep -rn 'operator' src/substrates/ src/common/substrates/`.
- **PR routing:** the C-R6 `harness.ts:190` wire change lands in **PR-8** (bus/wire consumers, companion to myelin). The `harness.test.ts` `signed_by` fixtures land with **PR-7** (re-vendor, transition: both accepted). The `home_operator` comment + C-R14a prose land in **PR-5/PR-6** (code/prose bulk). The `check:vocab` guard must cover `src/substrates/` and `src/common/substrates/` — they were silently outside its scope in iteration 1.

### `src/common/registry/` + `src/bus/network-resolver.ts` — network-registry CLIENT (C-R3 — `0002`-coupled, lockstep companion)

**This section resolves the iteration-1 carve-out hole.** The `network-registry` *service* (`src/services/network-registry/`) is deferred to manifest `0002` — but the cortex-side **CLIENT** of that service lives in `src/` and *consumes its REST JSON contract*. Iteration 1 deferred the service and silently stranded the client. The client is kept in **this** manifest, **lockstep-flagged**: its renames must land in the same release as the `0002` network-registry API rename.

**Why kept here, not punted to `0002`:** `src/common/registry/client.ts` imports only `./signing` locally — it has **no compile-time dependency** on `src/services/network-registry/`. It consumes the service purely over HTTP/JSON. So it *can* be migrated independently of `0002`'s code — but its JSON-key reads (`operator_id`, `operator_pubkey`) and the `OperatorRecord` shape it mirrors are a *wire contract* with the `0002` service. Therefore: **rename the cortex-native code identifiers now; flag the JSON-key reads + `OperatorRecord` mirror as lockstep-with-`0002`.** Silent omission is forbidden (the iteration-1 failure).

Files + verified counts at `c61a607`:

- **`src/common/registry/client.ts` — 28 `operatorId` hits (the single heaviest `operatorId` file in the repo), 41 `operator` total.**
  - **C-R3 (cortex-native code identifiers — rename now):** the `operatorId` *parameters / locals / private fields* — L7 doc `getOperator(operatorId)`, L35 `invalidate(operatorId)`, L76 `private readonly operatorIds: readonly string[];`, L217 `getOperator(operatorId: string)`, L348, L437/L443 log strings, etc. → `principalId` / `principalIds`. PR-time `grep -n 'operatorId' src/common/registry/client.ts` enumerates all 28.
  - **`OperatorRecord` type + `getOperator()` method name** → `PrincipalRecord` / `getPrincipal()` — but these mirror the `0002` service's published shape: **flag lockstep-with-`0002`** (rename here only when `0002`'s `OperatorRecord`→`PrincipalRecord` API rename lands; keep a `getOperator` deprecated alias for one minor).
  - **JSON wire keys `operator_id` / `operator_pubkey`** (L392, L398, L418, L451, L94 cache comment) — these are READ off the `0002` service's signed REST payload. **They renamed ONLY in lockstep with `0002`'s route/payload rename** (`/operators/{operator_id}` → `/principals/{principal_id}`). Until `0002` lands, the client reads `operator_id`/`operator_pubkey` and these lines are on the `check:vocab` allow-list — *explicitly*, not silently.
- **`src/common/registry/types.ts` — 3 `operatorId` hits.** L46 `* Mirrors \`OperatorRecord\` on the producer side.` — this comment names the `0002` coupling explicitly; update it to `PrincipalRecord` in lockstep. L119 `operatorIds: string[];`, L155/L163 `getOperator(operatorId)` — cortex-native shape, renames with `client.ts`.
- **`src/common/registry/__tests__/client.test.ts` — 17 `operatorId` hits.** Renames in lockstep with `client.ts`.
- **`src/bus/network-resolver.ts` — 4 `operator` hits (all `operatorId`).** L98–99 + L105–106: `const { …, operatorId, … } = network.cloud;` / `return { …, operatorId, … }` — `operatorId` destructured off the `network.cloud` config block (the `cloud-network` config that `cloud.ts` writes, see I2). This is a **cortex-native parsed-config-shape** field → `principalId` renames with the `network.cloud` schema (C-R3, Tier-2-adjacent — it is on a parsed config shape). Lands in PR-5.
- **PR routing:** the cortex-native identifier renames (`operatorId` params/locals in `client.ts`, `types.ts`, `network-resolver.ts`, `client.test.ts`) land in **PR-5**. The `OperatorRecord`/`getOperator`/JSON-key changes are **flagged lockstep-with-`0002`** and land in a `0002`-companion cortex PR — the `0002` manifest MUST cross-reference this section. **`check:vocab` allow-list:** only the `operator_id`/`operator_pubkey` *JSON-key* lines in `client.ts`/`types.ts` go on the allow-list (pending `0002`), NOT the whole files — the cortex-native identifiers are migrated in PR-5 and must NOT be allow-listed.

### `src/runner/dispatch-listener.ts` + `worklog-manager.ts` + `agent-team.ts` (dispatch path)

`dispatch-listener.ts` (26 `operator`, plus `{org}`, `originator`, `signed_by[0].principal`) is the heaviest runner file.

- **C-R6** — `dispatch-listener.ts` L199, L324, L350, L769, L1106, L1177 — `source.org` → `source.principal` (companion to myelin-R6). `worklog-manager.ts:299-300` `` `local.${opts.org}.dispatch.task.>` `` / `` `local.${opts.org}.${opts.stack}.dispatch.task.>` `` → `local.${opts.principal}.…` (the `opts.org` option key → `opts.principal`).
- **C-R8** — `dispatch-listener.ts` L569–570, L897, L966, L968, L970, L1075, L1090, L1164 — `signed_by[0].principal` / `originator.principal` → `.identity` (companion to myelin-R2). L832 `gatedPrincipal = decision.principal;` — `decision.principal` here is cortex's *policy* principal (the human) → **keep** ; L1090/L1164 `chain[0]?.principal` → `chain[0]?.identity` (myelin wire field).
- **C-R3** — `agent-team.ts`, `dispatch-listener.ts` `operatorId` → `principalId` (PR-time grep).
- **PR-time grep** for the comment bulk in `dispatch-listener.ts` (26 hits).

### `src/taps/cc-events/` — CC event taps (`cc-events.ts`, `relay.ts`, `cloud-publisher.ts`)

- **C-R6** — `cc-events.ts:89` `` `${src?.org ?? "default"}.${src?.agent ?? "cortex"}.${...` `` → `${src?.principal ?? "default"}.…` ; L344 `const org = opts.org ?? "default";` → `const principal = opts.principal ?? "default";`.
- **C-R6 + legacy env var** — `relay.ts:202` `options.org ?? process.env.GROVE_OPERATOR ?? process.env.NATS_ORG ?? "default";` → `options.principal ?? process.env.CORTEX_PRINCIPAL ?? process.env.GROVE_OPERATOR ?? …`. **Decision:** the `GROVE_OPERATOR` / `NATS_ORG` **env-var reads stay as back-compat fallbacks** (per `CLAUDE.md` — `GROVE_*` shim retires at MIG-8); add a `CORTEX_PRINCIPAL` as the new preferred var. Flag: confirm with the deprecation-shim owner.
- **C-R8** — `relay.ts:173` the long string mentions `signed_by[0].principal` and `CORTEX_ORIGINATOR_PRINCIPAL` — the *env-var name* `CORTEX_ORIGINATOR_PRINCIPAL`: decision **flag for review** — if it carries the assistant DID it could become `CORTEX_ORIGINATOR_IDENTITY`; env-var renames need a back-compat read. The `signed_by[0].principal` *prose* → `signed_by[0].identity`.
- **C-R8** — `originator` field reads in `cc-events.ts` / `relay.ts` (the `.principal` field on the originator block cortex *writes*) → `.identity` (companion to myelin-R2; cortex is a *producer* here — it must write `identity` once myelin's transition release accepts it).

### `src/adapters/` — Discord / Mattermost / Slack adapters

`discord/index.ts` (67), `slack/index.ts` (27), `mattermost/index.ts` (17), `discord/__tests__/operator-dm-buffer.test.ts` (33).

- **C-R3** — `operatorId` / `operatorDiscordId` references → `principalId` / `principalDiscordId` (PR-time grep per file).
- **C-R14a** — "operator" prose (the adapters speak of "the operator's Discord id", "DM the operator") → "principal".
- **Test-file rename:** `src/adapters/discord/__tests__/operator-dm-buffer.test.ts` → `principal-dm-buffer.test.ts` (`git mv`). The feature is "buffer DMs to the principal". PR-time grep for any path reference.

### `src/surface/mc/` — Mission Control (API, worker, dashboard)

The MC surface has `operator` in API handlers, worker routes, SQL schema, and dashboard copy. **~89 hits in `api/handlers.ts` alone.** Distinguish three senses:

- **C-R1 / C-R14a — operator-the-human prose + `operatorId` API fields:** `api/handlers.ts`, `api/types.ts`, `worker/src/routes/state.ts` (61), `worker/src/routes/ingest.ts` (21), `notifications/discord-sink.ts` (24) — `operatorId` → `principalId`, "operator" prose → "principal". **The `operatorId` on API request/response shapes is a wire field of the MC REST API** — Tier 2; the worker accepts both keys for one cycle.
- **C-R4 — `home_operator` DB column + its partial INDEX (exact — MC-worker DB dir is `src/surface/mc/worker/`):** the `home_operator` column on the `sessions` table is defined in TWO places and **backed by a partial index in TWO places**. Verified at `c61a607`:
  - `src/surface/mc/worker/schema.sql:36` — `home_operator TEXT  -- principal.home_operator (post-\`did:mf:\` strip)` (the column, fresh-DB path).
  - `src/surface/mc/worker/schema.sql:141` — `CREATE INDEX IF NOT EXISTS idx_sessions_home_operator ON sessions(home_operator) WHERE home_operator IS NOT NULL;` (the **partial index**, fresh-DB path).
  - `src/surface/mc/worker/migrations/0003_sovereignty.sql:22` — `ALTER TABLE sessions ADD COLUMN home_operator TEXT;` (the applied migration that introduced the column).
  - `src/surface/mc/worker/migrations/0003_sovereignty.sql:27` — `CREATE INDEX IF NOT EXISTS idx_sessions_home_operator ON sessions(home_operator) WHERE home_operator IS NOT NULL;` (the same partial index, in the applied migration).
  - **The `0004` step — corrected (iteration 1 omitted the index):** SQLite/D1 `ALTER TABLE … RENAME COLUMN` does **NOT** rename the index, nor rewrite the index's `WHERE home_operator IS NOT NULL` predicate. A bare `RENAME COLUMN` leaves a dangling `idx_sessions_home_operator` index whose definition references a column name that no longer exists. The new migration `src/surface/mc/worker/migrations/0004_rename_home_operator.sql` MUST therefore do **three** statements in order:
    ```sql
    ALTER TABLE sessions RENAME COLUMN home_operator TO home_principal;
    DROP INDEX IF EXISTS idx_sessions_home_operator;
    CREATE INDEX IF NOT EXISTS idx_sessions_home_principal ON sessions(home_principal) WHERE home_principal IS NOT NULL;
    ```
  - **`schema.sql` (the fresh-DB path) updates in lockstep** — the same PR rewrites `schema.sql:36` (`home_operator` → `home_principal`) AND `schema.sql:141` (the `CREATE INDEX` → `idx_sessions_home_principal ON sessions(home_principal) WHERE home_principal IS NOT NULL`). A fresh DB built from `schema.sql` and an upgraded DB migrated via `0004_*` MUST end in the identical schema — column name AND index name AND index predicate.
  - **Do NOT hand-edit `0003_sovereignty.sql`** (it is an applied migration — editing it diverges already-migrated D1 instances) — the rename is a NEW `0004_*` migration only.
  - The route code (`worker/src/routes/state.ts`, `ingest.ts`) reads the `home_operator` column — update in the same release as the migration. Tier 2; the worker accepts both column names for one cycle (read fallback) until every D1 instance has run `0004_*`.
  - **NB — `operator_id` column is separate:** `schema.sql:139` also has `CREATE INDEX … idx_sessions_operator ON sessions(operator_id);` and an `operator_id` column. That `operator_id` is the MC-API session-ownership column (C-R3 on the MC REST wire) — a *different* rename from `home_operator`. If `operator_id` → `principal_id` is taken in this manifest's scope, its `idx_sessions_operator` index needs the same DROP/CREATE treatment — PR-time call; flagged here so it is not missed.
- **C-R3 — `src/surface/mc/worker/src/auth.ts` (REST auth — wire-adjacent):** **5 `operatorId` hits** verified at `c61a607` — L62 doc `c.set("operatorId", …)`, L65 the `requireApiKey` context type `Variables: { operatorId: string; … }`, L88 `const operatorId = keyData.operator_id ?? (keyData as any).operatorId ?? "";`, L89 audit-log `identity: operatorId`, L90 `c.set("operatorId", operatorId)`. This is the MC-worker REST auth path — it sets `operatorId` into the Hono request context that every downstream route reads, so it is **wire-adjacent** to the MC-API `operatorId`-field rename. `operatorId` (context key + type) → `principalId`; the `keyData.operator_id` JSON read is the API-key payload key — renames in lockstep with the MC-API key-shape change (back-compat read both for one cycle, exactly as L88 already reads `operator_id ?? operatorId`). Lands in **PR-4** (MC-worker), companion to the `0004` migration.
- **Carve-out — WS `broadcast`:** `api/handlers.ts:117-123` `broadcastEvent` / `broadcastIterationCreated` / `broadcastTaskUpdated` / `broadcastTransition` etc. and ~230 sibling hits — **the WS fan-out mechanism. NOT renamed.** Stays.
- **Dashboard copy:** `dashboard-v2/` — `operator` appears in component copy (`drill-input.tsx:12`, `app.tsx`, `iteration-detail.tsx`) and `agent-defaults.ts`. C-R14a prose → "principal" (user-facing label change — flag for a design/UX glance: the dashboard says "operator" to the human looking at it; "principal" is the canonical term but is more jargon-y. **Flag for review:** confirm the principal wants the *user-facing* dashboard label changed, or whether the visible label stays "operator"/"you" while the *code identifier* renames. The myelin manifest had no UI surface; this is a cortex-specific judgment call.)

### `src/common/agents/trust-resolver.ts` + `__tests__/trust-resolver-operator-verify.test.ts`

- **C-R14a** — `trust-resolver.ts` (60 hits) "operator" prose → "principal". The TrustResolver's "operator-signature verifier" → "principal-signature verifier".
- **Test-file rename:** `__tests__/trust-resolver-operator-verify.test.ts` → `trust-resolver-principal-verify.test.ts` (`git mv`).

### `CLAUDE.md` + `docs/agents-md/architecture.md` (C-R10 + C-R14a)

**`CLAUDE.md` is generated — NEVER hand-edit it** (per the repo's CLAUDE.md-management rule). The edits go in the **source section file** `docs/agents-md/architecture.md`, then `arc upgrade compass` regenerates `CLAUDE.md`.

- **C-R10** — `docs/agents-md/architecture.md` L3 `cortex is the **M7 application** of the metafactory Myelin stack` → `Myelin layer model` ; L5 `cortex is layer 7 in the OSI-style **M1–M7 Myelin stack**:` → `Myelin layer model`. These regenerate into `CLAUDE.md` L3, L5, L9, L11 (`# Cortex -- Layer-7 collaboration surface for the metafactory Myelin stack` etc.).
- **C-R14a** — `docs/agents-md/architecture.md` L3 `the operator's collaboration surface` → `the principal's collaboration surface`.
- **C-R5** — any `{org}` in the agents-md section files (PR-time grep `docs/agents-md/`).
- **Process:** edit `docs/agents-md/architecture.md` (+ any other `docs/agents-md/*.md` with hits — `critical-rules.md` has the `{topic}` image-naming hit which is **NOT** C-R11, leave it), run `arc upgrade compass`, commit both the source files AND the regenerated `CLAUDE.md`.

### `README.md` (C-R10 + C-R14a)

- **C-R10** — L4 `application that consumes the Myelin stack (M2–M6)` → `Myelin layer model (M2–M6)`.
- **C-R14a** — PR-time grep `operator` in `README.md`.

### `cortex.yaml.example` — the example config (C-R1/C-R2/C-R5 — Tier 2 exemplar)

**30 hits.** This file is what every new principal copies to make their `cortex.yaml`. It MUST show the **new** vocabulary post-rename.

- **C-R2** — L35 comment `# operator — who is running this cortex instance` → `# principal — …` ; L37 `operator:` (the block key) → `principal:` ; L42 `id: operator-name  # <REPLACE_ME>` → `id: principal-name` ; L44 `displayName: Operator Name` → `displayName: Principal Name`.
- **C-R5** — L38–39 comment `Surfaces as the \`{org}\` segment in NATS subjects (\`local.{org}.>\`)` → `{principal}` / `local.{principal}.>`.
- **C-R6** — L64 `\`deriveStackId\` defaults to \`${operator.id}/default\`` → `${principal.id}/default` ; L67 `Must match \`{operator_id}/{stack_id}\` grammar` → `{principal_id}/{stack_id}` ; L69–70 `keep operator-id half in sync with \`operator.id\`` / `id: operator-name/meta-factory` → `principal-id half` / `principal.id` / `id: principal-name/meta-factory`.
- **C-R4** — L132 `home_operator: operator-name` → `home_principal: principal-name` ; L133 `home_stack: operator-name/meta-factory` → `principal-name/meta-factory` ; L141–142 same.
- **C-R1 / C-R14a** — L46 `\`operator\` principal so the bot recognises you as the operator` → `\`principal\` principal so the bot recognises you as the principal` ; L54, L65, L77, L94, L124 ("Minimal single-principal example: declare yourself as the operator"), L130 (`- id: operator` — a *policy principal id literal*; decision: the policy-principal `id: operator` is a **literal value naming a role-binding**, rename → `id: principal` for consistency), L131, L135 (`- operator` in a roles list → `- principal`), L139, L148. **PR-time grep enumerates all 30.**
- **`__tests__/cortex.yaml-example.test.ts`** asserts against this file — update the assertions in lockstep (4 `operator` hits there).

### `docs/` — design + iteration + plan docs (C-R5 / C-R7 / C-R10 / C-R14a — bulk-prose register)

**~40 files, 1,124 `operator` lines + 143 `{org}` lines (175 occurrences) + the `Broadcast`/`Myelin stack` clusters** — verified at `c61a607`, 2026-05-21 (iteration 1 said "~1,400 operator + 342 {org}"; both were wrong — the `{org}` figure was nearly 2.4× the true count). Per the myelin manifest's `specs/namespace.md` discipline: each doc gets a PR-time `grep`, and the manifest records the file, the verified count, and the rename(s) that apply. Grouped by weight:

**Heaviest (`operator` > 60):**
- `docs/design-internet-of-agentic-work.md` — 116 `operator` + 4 `broadcast` + 1 `{org}`. C-R14a (prose) + C-R5 + C-R7. Note L21 `**M1–M7 Myelin stack**` → C-R10.
- `docs/design-mission-control.md` — 102 `operator`. C-R14a. (1 `broadcast` — verify WS-mechanism vs mode.)
- `docs/design-policy-cutover.md` — 96 `operator` + `home_operator`. C-R14a + C-R4.
- `docs/plan-internet-of-agentic-work.md` — 68. C-R14a + C-R5.
- `docs/design-mc-f12-task-curation.md` — 68 `operator` + 10 `broadcast` (verify each — task-curation likely WS-mechanism). C-R14a.
- `docs/design-mc-f12b-add-to-queue.md` — 65 `operator` + 1 `broadcast` (L119 "the topic is unhandled" = subject-matter, **not** C-R11 — leave). C-R14a.

**`docs/architecture.md` — the architecture spec (57 `operator`, exact treatment):**
- **C-R10** — L48 `**M1–M7 — the Myelin stack**` → `**M1–M7 — the Myelin layer model**` ; L69 `## 2. The Myelin stack (M1–M7)` → `## 2. The Myelin layer model (M1–M7)` ; L71 `the Myelin stack — OSI-style` → `the Myelin layer model — OSI-style` ; L557 `cortex-the-app sits at M7 of the Myelin stack` → `Myelin layer model` ; L562 `cortex's connection to the Myelin stack` → `Myelin layer model`.
- **C-R5** — L190 `local.{org}.{domain}.{entity}.{action}` → `local.{principal}.…` ; L193 `**\`local.{org}.*\`**` → `local.{principal}.*` ; PR-time grep all `{org}`.
- **C-R14a** — L35 table col `| Operator experience |` → `| Principal experience |` ; L65 `cortex — conscious processing surface where the operator perceives` → `the principal perceives` ; L117, L150, L159, L193–194 ("intra-operator" → "intra-principal", "cross-operator" → "cross-principal"), L199 `### 3.6 Operator visibility — three tiers` → `### 3.6 Principal visibility — three tiers`, L201. PR-time grep enumerates all 57.
- **Carve-out** — L139 `mf.net-{op}.events.>` — legacy subject citation, **leave** (C-R14b). L26–28 `agent personas` / `those personas` — **C-R12**: here "personas" means the *named beings* (Luna, Echo, Holly) → "agents" or "assistants". Decision: → "assistants" (the named-being entity). L37–38 "bots" — leave (informal).
- **`Broadcast` (C-R7) in `architecture.md`** — 4 `broadcast` hits — PR-time verify: which are the dispatch mode (→ `Offer`) vs the WS/NATS fan-out verb (→ leave lowercase). Likely the §3 task-routing mentions are the mode.

**`docs/plan-cortex-migration.md` — the migration plan (53 `operator`, 1 `broadcast`):**
- **C-R10** — any "Myelin stack" → "Myelin layer model" (PR-time grep).
- **C-R5 / C-R14a** — `{org}` + "operator" prose. **NB:** this plan is partly a *historical record* of MIG-0..MIG-8 — lines describing *what was migrated* may legitimately keep period vocabulary. PR author makes a per-line legacy-vs-current call, as the myelin manifest does for `migration-from-legacy-nats.md`.

**Mid-weight (`operator` 20–48):** `design-collaboration-surface.md` (48), `design-mc-dashboard-react-migration.md` (40), `design-cloud-api.md` (40), `design-soma-integration.md` (39 — note L465 "cortex/myelin stack" → C-R10), `design-mc-f11-discord-notifications.md` (39 + 11 `broadcast`), `design-capability-dispatch-review-consumer.md` (35 + `{org}`), `design-arc-agent-bots.md` (33), `design-mc-iteration-planning.md` (32), `design-gh-repo-recon-agent.md` (31), `design-pilot-restructure.md` (30 + the `| Spec | Topic |` table header — **NOT** C-R11, leave), `design-dm-operator-channel.md` (27 — **file-rename candidate**, see below), `design-mc-image-input.md` (22), `design-mc-f10-operator-input.md` (21 + 2 `broadcast` — **file-rename candidate**), `iteration-cloud-api.md` (20).

**Lighter (`operator` < 20):** `design-mc-f8-task-table.md`, `design-mc-f20-observe.md`, `design-mc-f19-dispatch.md` (+ 2 `broadcast`), `design-mc-f18-metrics.md`, `iteration-policy-cutover.md`, `design-spawn-integration.md`, `design-mc-f7-attention-view.md`, `design-cursor-substrate-bot.md`, `sop-stack-identity.md` (9), `design-mc-f6-focus-area.md`, `sop-migrate-config.md` (8), `sop-bus-review.md` (8), `iteration-mission-control.md`, `iteration-mc-dispatch-observe.md`, `design-bus-addressing.md` (+ `{org}`), `design-pi-dev-review-agent.md` (+ `{org}` + 3 `broadcast`), `design-cursor-substrate-bot.md` (+ `{org}`), `design-arc-agent-bots.md`. Each: PR-time grep, C-R5/C-R7/C-R14a.

**Doc file-rename candidates (flag for review):**
- `docs/design-dm-operator-channel.md` — the feature is "DM channel to the operator". Under the new vocab → `design-dm-principal-channel.md`. **Flag:** confirm; fix inbound links.
- `docs/design-mc-f10-operator-input.md` — "operator input" feature. → `design-mc-f10-principal-input.md`. **Flag:** F-numbered design docs may be referenced by `blueprint.yaml` / iteration docs by exact filename — check before `git mv`.

**`docs/migration-examples/*.yaml`** — `before-single-adapter.yaml` (4) / `after-single-adapter.yaml` (11) — these are example `cortex.yaml` fragments. The `after-*` MUST show new vocab (`principal:`); the `before-*` shows the *legacy* `bot.yaml` shape — **leave `before-*` as a faithful legacy example** (C-R14b), rename keys only in `after-*` (C-R2).

**`docs/diagrams/2026-05-17-soma-integration-reference-poster.svg`** — L163 `M1 – M7  Myelin stack` → `Myelin layer model` (C-R10). 12 `operator` hits in the SVG text → C-R14a. **Also regenerate the canonical copy in `~/Documents/andreas_brain/assets/`** per the repo's generated-images rule.

### Test fixtures + test files (C-R3 / C-R7 / C-R8 — lockstep with their drivers)

Every `*.test.ts` and `__tests__/fixtures/*.bot.yaml` / `*.yaml` carrying `operatorId` / `operator:` / `home_operator` / `signed_by[].principal` / `distribution_mode: "broadcast"` / `target_principal` renames **in the same PR as its driver file** (a test must compile against the renamed shape). Heaviest test files (PR-time grep, rename in lockstep): `common/registry/__tests__/client.test.ts` (83), `common/policy/__tests__/factory.test.ts` (75), `cli/cortex/commands/__tests__/migrate-config-policy.test.ts` (69), `common/agents/__tests__/trust-resolver-operator-verify.test.ts` (67 — also `git mv`), `cli/cortex/commands/__tests__/migrate-config.test.ts` (55), `common/types/__tests__/cortex-config.test.ts` (54), `common/types/__tests__/stack.test.ts` (45), `__tests__/iaw-phase-d-integration.test.ts` (41), `runner/__tests__/dispatch-listener.test.ts` (34), `bus/myelin/__tests__/envelope-validator.test.ts` (3 `broadcast`, `target_principal`, `signed_by.principal`), `bus/myelin/__tests__/runtime.test.ts` (`signed_by[].principal` fixtures L612, L623, L676, L681–682), `bus/__tests__/verify-signed-by-chain.test.ts`, `__tests__/signed-pilot-roundtrip.test.ts`, `__tests__/cortex.stack-signing-boot.test.ts`.

**Boot / integration tests (verified at `c61a607` — iteration 1 omitted these):** the `src/__tests__/` boot suite exercises the full wire-up and MUST rename in lockstep, because these tests boot cortex with a `cortex.yaml` and assert on the parsed-config shape and the dispatch path:
- `src/__tests__/cortex.test.ts` — **3 `operatorId`** + 12 `operator` lines. The top-level boot test; renames with PR-5/PR-1.
- `src/__tests__/cortex.capability-boot.test.ts` — **1 `operatorId`** + 5 `operator` lines. Boots the capability path.
- `src/__tests__/cortex.review-consumer-boot.test.ts` — **1 `operatorId`** + 5 `operator` lines. Boots the review-consumer.
These join `cortex.stack-signing-boot.test.ts` and `cortex.review-consumer.e2e.test.ts` (also in `src/__tests__/`) in the boot-suite group — each renames in lockstep with whichever driver PR changes the shape it asserts on (PR-1 for config-shape, PR-7/PR-8 for wire). The completion-signal §1 integration test (the new `principal:`-keyed end-to-end test) is added to this same directory.

---

## `distribution_mode` enum migration (C-R7 — the vendored wire-enum change)

`"broadcast"` is a **live wire enum value** in cortex's *vendored* schema (`src/bus/myelin/vendor/envelope.schema.json:168`), the `DistributionMode` type (`envelope-validator.ts:285`), and the validator's comment table (`envelope-validator.ts:162`). cortex does **not** own this enum — myelin does.

**Iteration-1 correction — cortex does NOT emit `distribution_mode`.** Iteration 1 claimed "cortex's dispatch path that *emits* `distribution_mode` switches to `"offer"`". This was unverified and is **wrong**. `git grep 'distribution_mode:'` (the object-literal *emit* form) across `src/` non-test returns **zero hits** at `c61a607`. Every non-test `distribution_mode` reference is in the **vendored schema + validator only**: `envelope-validator.ts:166` the optional field declaration `distribution_mode?: DistributionMode;`, L50/L168/L284 comments, and `vendor/envelope.schema.json:166/198/199` the schema property + the conditional that *requires* `target_assistant` when `distribution_mode` is `direct`/`delegate`. **cortex VALIDATES and READS `distribution_mode` off inbound envelopes; it does not construct or emit it.** (cortex is not a dispatch *originator* for the bidding/offer flow — that envelope is minted upstream; cortex's dispatch path consumes it.) cortex's job is therefore purely to **re-vendor the schema/validator in lockstep** — there is no cortex emit-site to switch:

1. **Transition (companion to myelin's transition release):** re-vendor the schema/validator so the validator *accepts* BOTH `"broadcast"` and `"offer"` on read. `DistributionMode = 'broadcast' | 'offer' | 'direct' | 'delegate'`. Tests that build envelope *fixtures* assert the validator accepts `"offer"` (and retain a back-compat fixture for `"broadcast"`). No cortex production code changes its emitted value — because cortex emits no `distribution_mode`.
2. **Breaking (companion to myelin's breaking major):** re-vendor the v2 schema (`enum: ["offer","direct","delegate"]`, `"broadcast"` rejected on read). `DistributionMode = 'offer' | 'direct' | 'delegate'`.
3. **Schedule:** cortex's two re-vendor PRs are gated on the corresponding myelin releases existing. cortex MUST NOT jump to the breaking re-vendor while any cortex JetStream consumer still replays a stream holding pre-migration `"broadcast"` envelopes (see JetStream replay note).

---

## Cross-cutting notes

### Error-string / discriminant lockstep (IMPORTANT)

cortex tests assert literal validator-error / discriminant strings. The `verify-signed-by-chain.ts` `VerifyFailure.kind` discriminants (`"malformed_principal"`, `"principal_has_no_nkey_pub"`) and any test matching `field === 'signed_by.principal'` / `'target_principal'` cannot serve two strings at once. **The discriminant/error-string change and the asserting tests MUST flip in the same PR** as the field rename — no transition window for the string itself. Where cortex *consumes* a myelin error string (envelope-validation surfacing), cortex's matcher updates in the same companion PR as myelin's validator change.

### Semver decisions (per-tier)

- **Tier 1** (comment/doc/prose renames — C-R5 comments, C-R10, C-R11, C-R12, C-R13, C-R14a): cortex **patch** bumps. No config/wire effect.
- **Tier 2** (C-R1/C-R2 `operator:`→`principal:` config key, C-R3 on parsed-config shapes, C-R4 `home_operator` config key + DB column): cortex **minor** for the transition release (back-compat read of both keys), then **major** for the breaking release (old key dropped). The MC-worker D1 `RENAME COLUMN` migration ships with the transition.
- **Tier 3** (C-R6 `org`→`principal` subject-builder param, C-R7/C-R8/C-R9 vendored-wire re-vendor): land in the **major**, in lockstep with myelin's breaking major. The C-R6 *parameter* rename is a source-breaking change to every caller — no runtime back-compat for a positional/keyed param.
- The cortex **package version** (`arc-manifest.yaml`, currently `2.0.10`) gets a **major bump to `3.0.0`** when the breaking release lands. (Note: cortex is already at 2.x; the vocabulary migration is the natural 3.0 line, and it coincides with the Soma-integration v3.0.0 cycle referenced in `docs/design-soma-integration.md` — sequence the two together.)

### myelin coupling × companion-PR table (drives cross-repo lockstep)

cortex consumes myelin's published language. Each row is a myelin rename cortex must follow; the cortex PR is a **companion** that lands against the named myelin release.

| myelin rename (their #) | cortex companion change | cortex files | cortex tier |
|---|---|---|---|
| `signed_by[].principal` → `.identity` (myelin-R2) | C-R8 — re-vendor schema/validator + every `.principal` accessor + `verify-signed-by-chain.ts` | `bus/myelin/vendor/*`, `bus/myelin/envelope-validator.ts`, `bus/verify-signed-by-chain.ts`, `bus/system-events.ts`, dispatch path | 3 |
| `originator.principal` → `.identity` (myelin-R2) | C-R8 — `originator` reads/writes | `bus/myelin/envelope-validator.ts`, `taps/cc-events/*`, `runner/dispatch-listener.ts` | 3 |
| `target_principal` → `target_assistant` (myelin-R13) | C-R9 — re-vendor + dispatch-path reads | `bus/myelin/vendor/*`, `envelope-validator.ts` | 3 |
| `distribution_mode "broadcast"` → `"offer"` (myelin-R11) | C-R7 — re-vendor enum (validator *reads* it; cortex emits no `distribution_mode`) | `bus/myelin/vendor/*`, `envelope-validator.ts` | 3 |
| `source` grammar 3–5 → fixed-3 (myelin-R6) | C-R6 — `source.org` → `source.principal` accessor + every subject builder | `bus/*`, `runner/dispatch-listener.ts`, `taps/cc-events/*` | 3 |
| `{org}` subject token → `{principal}` (myelin owns grammar) | C-R5 — every `{org}` in cortex subject-building code + docs | `bus/myelin/runtime.ts`, all `bus/*`, `docs/*` | 3 (code) / 1 (prose) |
| `Principal` exported type → `Identity` (myelin-R1) | cortex `import type { Principal }` from myelin → `Identity` | every cortex file importing myelin's `Principal` | 1 (follows myelin's deprecated alias) |

cortex's Tier-3 PRs land **after** myelin's transition release and **before** myelin's breaking major. cortex never re-vendors the breaking myelin schema until myelin's breaking major is cut.

### PR ordering (dependency-ordered sequence)

```
PR-1  src/common/types/cortex-config.ts   — C-R1/C-R2/C-R3/C-R4/C-R5/C-R14a.
      + src/common/types/stack.ts           OperatorSchema→PrincipalSchema, operator:→
      + src/common/config/loader.ts         principal: key. loader.ts carries the
      + src/common/config/watcher.ts        DUAL-KEY READ (back-compat both keys) +
                                            the watched-field-path literals.
                                            home_operator→home_principal. Tier 2.
                                            Land first — the config schema + reader.
PR-2  src/cli/cortex/commands/             — C-R1/C-R3/C-R4 + the `cortex config migrate`
      migrate-config*                        data-migration step. Depends on PR-1.
PR-3  src/common/policy/*                  — C-R4 home_operator + C-R8 comment refs.
                                            Depends on PR-1.
PR-4  src/surface/mc/worker/* (SQL+auth)   — C-R4 DB column + 0004 migration (RENAME
                                            COLUMN + DROP/CREATE partial index) +
                                            schema.sql lockstep + auth.ts + route code.
                                            Depends on PR-1, PR-3.
PR-5  src/cortex.ts + src/common/*         — C-R3/C-R5/C-R14a prose+code bulk.
      (event-processor, types, registry,     registry = network-registry CLIENT
       substrates, network-resolver)         cortex-native identifiers. Depends on PR-1.
PR-6  src/adapters/* + src/runner/*        — C-R3/C-R6/C-R14a + test-file git mv +
      + src/cli/cortex/commands/cloud.ts     cloud.ts (must agree w/ network-resolver
      (non-wire parts)                       on network.cloud shape). Depends on PR-1.
─────  myelin transition release lands here ─────
PR-7  src/bus/myelin/vendor/* +            — C-R7/C-R8/C-R9 re-vendor (transition: both
      envelope-validator.ts (re-vendor)      old+new accepted). Companion to myelin
                                            transition. Tier 3.
PR-8  src/bus/* + src/runner/dispatch-     — C-R5/C-R6/C-R8 subject builders + wire
      listener.ts + src/taps/cc-events/*     consumers. Companion to myelin. Depends PR-7.
PR-9  cortex.yaml.example +                — C-R1/C-R2/C-R5 exemplar + migration-examples
      docs/migration-examples/*              (after-* only). Depends on PR-1, PR-2.
PR-10 docs/agents-md/* → arc upgrade       — C-R10/C-R14a/C-R5. Regenerate CLAUDE.md.
      compass → CLAUDE.md
PR-11 docs/*.md (design/iteration/plan)    — C-R5/C-R7/C-R10/C-R14a prose. Parallelisable,
                                            group by doc. + README.md + the SVG.
─────  myelin breaking major lands here ─────
PR-12 src/bus/myelin/vendor/* (re-vendor   — C-R7/C-R8/C-R9 breaking re-vendor (v2 schema,
      v2) + drop back-compat                 old names rejected). Drop the config-key
                                            back-compat. cortex 3.0.0. Depends: ALL above.
```

Tier-1 doc PRs (PR-10/PR-11) parallelise once the code lands. The **config-schema PR (PR-1) lands first**; the **wire PRs (PR-7/PR-8/PR-12) gate on myelin releases**. Each PR runs `bunx tsc --noEmit && bun test` green before merge.

### JetStream replay strategy (retained pre-migration envelopes)

cortex's `CODE_REVIEW` stream and the dispatch-lifecycle stream hold **retained envelopes** signed before the migration — old field names (`signed_by[].principal`, `target_principal`, `distribution_mode: "broadcast"`). Strategy mirrors myelin's:

1. **Dual-schema read window:** PR-7's re-vendored validator accepts BOTH old and new field names. cortex consumers stay on the transition-vendored validator for the full retention period of every stream they replay.
2. **Stream drain before the breaking re-vendor (PR-12):** for bounded-retention streams, let the retention window expire (pre-migration messages aged out) before deploying the v2-vendored validator to that stream's consumers. Document each stream's `max-age`.
3. **No re-stamp:** retained envelopes keep their original signatures — the v2 validator must still *verify* old-shape envelopes via the back-compat path (verification reads the same bytes; only field-name parsing differs).

### Rollback artefact

1. **Tag before starting:** before PR-1 merges, cut `pre-vocab-migration` (and a cortex release `v2.0.x`) so a deployment can pin the last all-old-vocabulary cortex.
2. **Config-key pinning:** because PR-1's reader accepts both `operator:` and `principal:`, a deployed `cortex.yaml` keeps working un-migrated through the entire transition — the data migration (`cortex config migrate`) can run on each stack's own schedule.
3. **Per-tier rollback:** Tier 1 — pure revert. Tier 2 — revert to the *transition* release (reads both config keys); never roll a stack back past a release that already wrote `principal:`. Tier 3 — the breaking re-vendor (PR-12) has no clean partial rollback; roll the whole ecosystem to the transition release. This is why PR-12 lands last and only after myelin's breaking major and every cortex companion PR is verified.
4. **Rollback test:** the transition release retains a regression test proving the config reader accepts BOTH `operator:` and `principal:`, and the validator reads BOTH `signed_by[].principal` and `.identity`.

### `cortex.yaml` deployment migration (every deployed stack)

The `operator:` → `principal:` key rename (C-R2) means **every deployed stack's `cortex.yaml` needs a key migration** (`~/.config/cortex/cortex.yaml` on each machine — `andreas/meta-factory`, `andreas/work`, `andreas/halden`, plus any peer's stacks).

- cortex ships a **`cortex config migrate`** step (added to the existing `migrate-config` CLI — PR-2). It rewrites a `cortex.yaml`: `operator:` → `principal:`, `operator.id` → `principal.id`, `home_operator` → `home_principal` in every `policy:` principal entry. Idempotent; preserves every nested value and comment where possible.
- The config **loader accepts both keys for one minor cycle** (PR-1) — so a myelin/cortex upgrade does NOT hard-break an un-migrated `cortex.yaml`. The loader logs a one-line deprecation warning naming `cortex config migrate`.
- The cortex Tier-2 **release notes MUST tell every principal to run `cortex config migrate`** before the breaking major (PR-12 / cortex 3.0.0) removes the `operator:` back-compat.
- **`cortex.yaml.example`** is updated in PR-9 to show `principal:` so new stacks start on the new vocabulary.

### Consumer impact (who else reads cortex's surfaces)

- **The MC dashboard frontend** (CF Pages, deployed independently) reads the MC REST API. The `operatorId` API-field rename (C-R3 on MC API shapes) is a frontend-coupled change — the dashboard build must update in lockstep with the worker (see the repo's dashboard-deployment rule: backend + frontend deploy separately). Flag: the dashboard PR is a companion to PR-4.
- **`pilot`** drives PRs through cortex's review loop and consumes dispatch envelopes — pilot follows myelin's wire renames directly (it is a myelin consumer too); cortex's changes do not add a separate pilot coupling beyond the shared myelin wire.
- **`signal-collector`** taps cortex's published events — `source.org`→`source.principal` and `signed_by[].identity` are visible to it; signal follows myelin's wire renames.

### Completion signal — what proves the migration is done

1. **Integration test on the new shape:** a `src/__tests__/` test boots cortex with a `principal:`-keyed `cortex.yaml`, publishes + consumes a `dispatch.task` envelope using the new vocabulary end-to-end (`signed_by[].identity`, `target_assistant`, `distribution_mode: "offer"`, `source` fixed-3) and asserts cortex routes it.
2. **CI grep guard:** a `bun` script (`check:vocab` in `package.json` — does not yet exist; added by this migration) asserts **no `operator` and no `{org}`** in `src/`, `cortex.yaml.example`, `docs/agents-md/` outside an explicit allow-list. The allow-list contains exactly: the **entire `src/services/network-registry/` SERVICE tree** (deferred to manifest `0002`), the `operator_id`/`operator_pubkey` **JSON-key lines in `src/common/registry/client.ts` + `types.ts`** (the `0002`-wire-coupled reads — NOT the whole files; the cortex-native identifiers in those files are migrated in PR-5 and must stay un-allow-listed), the WS-mechanism `broadcast*` symbols, the legacy-env-var fallbacks (`GROVE_OPERATOR`/`NATS_ORG`), the legacy-citation lines in `docs/plan-cortex-migration.md` / `docs/migration-examples/before-*.yaml`, the `mf.net-{op}` citation in `docs/architecture.md:139`, and the back-compat config-key reader in `src/common/config/loader.ts`. The guard's scope MUST also cover `src/substrates/` and `src/common/substrates/` (in `src/`, so already in scope — but explicitly verified, since iteration 1 never mentioned those trees). Any new occurrence fails CI.
   - **Allow-list review note:** the `check:vocab` allow-list is itself a code artefact and a security/correctness-relevant one. **It must be reviewed on every change** — too broad an entry wrongly *allows* a real miss (a `principal`-sense `operator` slips through un-migrated); too narrow wrongly *blocks* a legitimate infra term (e.g. an `nsc operator` NATS-account reference or a `network.operator` infra concept that is genuinely not the human). Each allow-list entry carries a one-line comment naming *why* it is excepted and which manifest (`0001`/`0002`) owns its eventual removal. Treat an allow-list diff as a reviewable change, not boilerplate.
3. **Config back-compat removed:** the breaking major (PR-12 / cortex 3.0.0) has dropped the `operator:` config-key reader and every `@deprecated` alias.
4. **All companion PRs merged:** every row of the myelin-coupling table has a merged cortex PR on the corresponding myelin release.

### Known-residual note (post-iteration-2 sweep)

A re-grep of `operatorId`, `operator.id`, `{org}`, `signed_by`, `target_principal`, `distribution_mode`, `"broadcast"` across `src/` at `c61a607` confirms the **exact register** now names every load-bearing site (config schema + reader + watcher, both `substrates/` trees, the registry CLIENT, the MC-worker DB + `auth.ts`, the vendored wire files). Remaining items are intentionally in the **bulk-prose register** (file + count + cluster, CI-guard-gated), not silently dropped:

- **`src/runner/review-pipeline.ts`** — 4 `operator` hits, including L170 a comment `Sourced from cortex.yaml's \`operator.id\` …`. The runner section names `dispatch-listener.ts` / `worklog-manager.ts` / `agent-team.ts` explicitly; `review-pipeline.ts` is C-R14a prose only and is caught by the `check:vocab` guard over all of `src/runner/`. Flagged here so PR-6 includes it.
- **`src/bus/__tests__/bus-dispatch-listener.test.ts`** (8 `operatorId`), **`src/common/config/__tests__/watcher.test.ts`** (7 `operatorId`), **`src/common/config/__tests__/loader.test.ts`** (`operator.id` fixtures) — test files that rename in lockstep with their drivers (PR-1/PR-6) per the test-fixtures rule; not individually transcribed.
- **`src/common/types/config.ts`** carries 7 `operatorId` across the *legacy `BotConfig`* shape AND the `CloudPublisher` config shape (L558/L566) — the legacy-`BotConfig` ones are the C-R14b "keep as faithful legacy model" decision; the `CloudPublisher` ones (`network.cloud.operatorId`) rename with `cloud.ts` + `network-resolver.ts` (PR-5/PR-6). Per-line call at PR time.
- `distribution_mode` / `"broadcast"` / `target_principal` non-test residuals are **entirely** within the vendored wire files (`bus/myelin/vendor/*`, `envelope-validator.ts`) — fully covered by the exact register; no residual.

---

## C-R14b — explicitly deferred ambiguous lines

Lines using "operator" / `persona` in a sense not mechanically resolvable. **Listed, not silently dropped:**

- **`src/services/network-registry/` (entire SERVICE tree, 191 lines — verified at `c61a607`)** — deferred to manifest `0002-network-registry-vocabulary.md` (own service, own release cadence). The `home_operator` field in `network-registry/src/types.ts` bridges C-R4 and `0002` — resolve in lockstep. **NB:** the cortex-side CLIENT (`src/common/registry/`, `src/bus/network-resolver.ts`) is NOT deferred — it is handled by this manifest's "network-registry CLIENT" section; only its `0002`-wire-coupled JSON keys (`operator_id`/`operator_pubkey`) and the `OperatorRecord` mirror are lockstep-flagged.
- **`src/common/types/config.ts` legacy `BotConfig.agent.operatorId`** — models the *historical* grove-v2 file format (the input to `migrate-config`). Decision leans "keep as a faithful legacy model"; flagged for review — confirm with the `migrate-config` owner.
- **`docs/plan-cortex-migration.md` historical lines** — lines describing what MIG-0..MIG-8 migrated *from* may keep period vocabulary. Per-line legacy-vs-current call at PR time.
- **`docs/migration-from-legacy-nats.md`-style citations + `mf.net-{op}`** — legacy subject-format citations; stay verbatim.
- **Env-var names `GROVE_OPERATOR` / `NATS_ORG` / `CORTEX_ORIGINATOR_PRINCIPAL`** — `GROVE_*` is the documented back-compat shim (retires at MIG-8) — stays. `CORTEX_ORIGINATOR_PRINCIPAL` → possibly `CORTEX_ORIGINATOR_IDENTITY` — deferred; env-var renames need a back-compat read window and a separate call.
- **Dashboard user-facing "operator" labels** — whether the *visible* dashboard copy changes to "principal" (canonical but jargon-y) or stays "operator"/"you" while only code identifiers rename — a UX call for the principal. Deferred.

---

## Ambiguities flagged for the review loop

1. **network-registry framing.** The brief said network-registry is network-aligned; the code says its `operator_id` is the *principal*. This manifest carves it out anyway (own service cadence) but on corrected grounds. **Reviewer: confirm the carve-out + the `0002` follow-up plan.**
2. **`persona` → `assistant` is near-empty in cortex.** cortex already says "agent"/"bot" for the entity; the only entity-prose hits are in `docs/architecture.md:26-27` ("agent personas"). `persona-format.md`, the `persona:` config field, `personas/*.md` all stay. **Reviewer: confirm C-R12 is correctly scoped to ~2 lines.**
3. **`topic` → `subject` is one line.** Only `surface-router.test.ts:1283` is the genuine NATS sense. **Reviewer: confirm no NATS-sense `topic` was missed (the `{topic}` image-naming + "Spec | Topic" table + "the topic is unhandled" hits are correctly excluded).**
4. **Doc file-renames** (`design-dm-operator-channel.md`, `design-mc-f10-operator-input.md`) — `git mv` candidates; F-numbered docs may be referenced by exact filename in `blueprint.yaml`. **Reviewer: confirm before renaming.**
5. **Dashboard user-facing label** (C-R14b) — change visible "operator" copy or only code identifiers? **Reviewer/principal: decide.**
6. **Bulk-prose register.** The ~1,124 `docs/` lines + the comment-bulk share of the 2,584 `src/` lines (verified at `c61a607`) are NOT transcribed per-line here — they are file + count + cluster, gated by the CI grep guard. This matches the myelin manifest's `specs/namespace.md` method but at larger scale. **Reviewer: confirm the bulk-prose register is acceptable, or name specific files that need exact per-line treatment promoted into the manifest.**
7. **Env-var renames** (`CORTEX_ORIGINATOR_PRINCIPAL`, the `GROVE_OPERATOR` fallback) — deferred to C-R14b. **Reviewer: confirm.**

---

## Per-PR checklist (template)

For each PR:

- [ ] Pull latest `main`; respect the PR-ordering dependency sequence above
- [ ] Apply every change in this manifest under the PR's scope (PR-time `grep` for the bulk-prose files)
- [ ] `bunx tsc --noEmit` clean
- [ ] `bun test` green (full suite, not just the file touched)
- [ ] For a config-key / DB-column / wire-field PR: confirm the transition release reads BOTH old and new (back-compat regression test added)
- [ ] For a wire PR (C-R7/C-R8/C-R9): confirm it is a faithful **re-vendor** from the named myelin release, cited in the PR body
- [ ] If the PR touches `docs/agents-md/*`: run `arc upgrade compass` and commit the regenerated `CLAUDE.md` alongside the source
- [ ] If the PR touches `cortex.yaml.example`: update `__tests__/cortex.yaml-example.test.ts` in lockstep
- [ ] Cross-link the companion myelin PR (per the myelin-coupling table) in the body
- [ ] Reference this manifest path in the PR body
- [ ] For the breaking major (PR-12): confirm `cortex 3.0.0` bump in `arc-manifest.yaml`, the `check:vocab` guard is green, and every `@deprecated` alias is removed
