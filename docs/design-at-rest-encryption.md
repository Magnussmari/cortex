# Design — At-Rest Encryption (Field-Level Confidentiality for Local SQLite + Cloud D1)

**Status:** Draft
**Feature:** TC-4c — at-rest field encryption (high-sensitivity columns)
**Refs:** cortex#638 (this work item), cortex#627 (Trust & Confidentiality umbrella), cortex#628 (TC-0 `security:` posture toggles), `docs/design-trust-confidentiality.md` (Phase 4 — at-rest), `docs/design-envelope-encryption.md` (sibling: payload-in-transit confidentiality, cortex#369)
**Author:** Architect (design session: principal + Luna pending)
**Type:** Design-only — no implementation. Decision document.

---

## §0 — TL;DR

Cortex stores three classes of high-sensitivity data unencrypted at rest today: **local SQLite** (`bun:sqlite` — dashboard, mission-control, runner-learning DBs), **cloud D1** (CF-managed pages), and **event JSONL** spool files. The sibling work TC-3 (cortex#369) encrypts payloads *on the wire and in JetStream*; this slice (TC-4c) closes the **at-rest** gap for the data that lands on the operator's disk and in CF's D1.

This doc recommends:

1. **Field-level (column-level) application encryption, not whole-DB encryption.** `bun:sqlite` does not bundle SQLCipher, and D1's storage key is CF-controlled (not cortex-controllable) — so for *both* substrates the only lever cortex actually holds is encrypting specific column values *before* they hit the DB. Whole-DB / SQLCipher is documented as a rejected option (§2.2). OS full-disk encryption (FileVault/LUKS) is the assumed baseline, not a substitute (§1.4).
2. **A small, fixed allow-list of high-sensitivity, non-indexed columns** gets encrypted; everything used for routing, joins, lookups, or dashboard filtering (IDs, `principal_id`, `session_id`, timestamps, `status`, `type`, `users.email`) **stays cleartext**. This cleartext-for-queryability constraint is load-bearing and drives the whole column selection (§1.3, §2.3).
3. **Reuse myelin's existing AES-256-GCM primitive** (`@the-metafactory/myelin` `agent-identity/encryption.ts`) behind a thin cortex `FieldCipher` wrapper. Per-value random nonce, AAD binding the value to its `{table, column, row-id}`, self-describing envelope (§4).
4. **Key custody: derive a dedicated at-rest data-encryption key (DEK) from the stack identity seed via HKDF, wrapped by an operator-held key-encryption key (KEK) in the OS keychain — recommendation is option (b′), a hybrid.** The central decision and the seed-theft correlation risk are in §3. The DEK never derives directly from the same secret that an on-disk theft would also expose.
5. **Gated entirely behind `encryption.at_rest: off|on` from TC-0 (cortex#628).** `off` (default) ⇒ byte-identical to today. The `off→on` flip triggers a one-time, resumable, idempotent migration that encrypts existing plaintext rows/files in place (§5).
6. **D1 is field-level only** — cortex cannot rotate or control CF's storage-layer key, so the D1 story is exactly the same column-cipher applied in the Worker before `INSERT`, with the DEK delivered as a Worker secret (§2.4, §3.5).

The single most consequential decision is **§3 — key custody.** Everything else is mechanism.

---

## §1 — Scope & threat model

### §1.1 What this protects

At-rest confidentiality for the data cortex persists locally and in D1. Concretely: an attacker who obtains a **copy of the bytes** — a stolen laptop/disk, an exfiltrated `~/.local/share/grove/` directory, a leaked backup/Time-Machine snapshot, a dumped D1 export, or a misplaced JSONL spool — must not be able to read prompts, commands, tool I/O, task descriptions, iteration bodies, block reasons, or auth audit detail from those bytes.

### §1.2 What it does NOT protect (out of scope here)

- **Data in use.** A live cortex process holds the DEK in memory and reads plaintext; an attacker with code-execution on the running host, or who can attach to the process, defeats at-rest encryption by design. That is a different control (process hardening, TC-4a/4b file-modes).
- **Data in transit / on the bus.** Owned by TC-3 payload encryption (cortex#369) and TC-4d/4e mTLS. This doc is strictly the resting bytes.
- **File modes / directory permissions.** `chmod 0600` on the JSONL spool and DB files is the **sibling slice TC-4b** (cortex umbrella #627). At-rest encryption and file-mode hardening are complementary, not substitutes — file modes stop a same-host *other user*; encryption stops *offline byte theft*. We assume TC-4b lands alongside or before the JSONL slice here.
- **Metadata leakage.** Cleartext columns (who, when, which session, status, email) remain readable to anyone with the bytes. This is an accepted trade for queryability — see §1.3. The threat model explicitly accepts that an attacker learns *that* a session happened, *which* principal, and *when*, but not *what was said or done*.

### §1.3 The load-bearing constraint — cleartext for queryability

The dashboard, ingestor, and CLIs run real SQL against these tables: filter by `status`/`state`/`type`, join on `session_id`/`assignment_id`/`repository_id`, sort by `timestamp`/`priority`, slice by `principal_id`/`home_principal`, and (D1) look up `users.email` via a `UNIQUE` index. **Any column that participates in a `WHERE`, `JOIN`, `ORDER BY`, `GROUP BY`, or `UNIQUE` constraint must stay cleartext** (or use a deterministic blind-index, which we explicitly defer — §2.5). Randomised AES-GCM ciphertext is opaque to SQL: you cannot index it, range-scan it, or equality-match it across rows.

Therefore the encryptable set is exactly: **high-sensitivity, free-text, non-indexed, read-by-id-then-decrypt columns.** Every candidate column below was checked against `schema.ts` / `schema.sql` indices (cited file:line) to confirm it is not load-bearing for a query.

### §1.4 OS full-disk encryption is the baseline, not the control

Operators are assumed to run FileVault (macOS) / LUKS (Linux). FDE protects against a *powered-off stolen disk* but gives **zero** protection against: a running/locked-but-logged-in machine, a leaked backup that lands on un-encrypted storage, a D1 export, or a JSONL file copied off-box. Field encryption is defence-in-depth *above* FDE for exactly those cases. We state this explicitly so the doc is not read as "FDE already covers it."

---

## §2 — Per-store approach

The inventory below is verified against the source; each store gets a concrete approach and a concrete column/file list.

### §2.1 Local SQLite — `bun:sqlite` (NO encryption today)

Three databases:

| DB | Path | Defined in |
|----|------|-----------|
| dashboard.db | `~/.config/grove/state/dashboard.db` | `src/cortex.ts:119` (`STATE_DIR`) + `:2563` |
| mission-control.db | `~/.local/share/grove/mission-control.db` | `src/surface/mc/config.ts:22` |
| runner learning DB | (caller-supplied `dbPath`) | `src/runner/learning-store.ts:29` |

**Approach: app-level field encryption at the DB-access seam.** The seam is already narrow and well-factored:

- `insertEvent()` does `JSON.stringify(params.payload)` at `src/surface/mc/db/events.ts:89`; `listEventsForSession()` does `JSON.parse(row.payload)` at `:167`. **These two functions are the entire encrypt/decrypt seam for `events.payload`.** A `FieldCipher.seal()` slots in at the stringify site and `.open()` at the parse site — no caller changes.
- `tasks` / `iterations` / `agent_task_assignment` writes go through `src/surface/mc/db/{tasks,iterations,assignments}.ts`; encryption wraps the specific column at the mapper boundary (same pattern: seal on write, open on row→object).
- `learnings.content` is written/read in `src/runner/learning-store.ts` (`create()` `:63`, `rowToLearning()` `:247`). **Caveat:** `search()` (`:99`) and `getRelevant()` (`:159`) do `content LIKE ?` / in-memory substring scoring — these break under randomised encryption. See §2.5 (the learning DB is the one store where the queryability constraint bites a *feature*, not just an index).

**Columns to encrypt (local SQLite):**

| Table | Column | Sensitivity | Index check (stays queryable?) |
|-------|--------|-------------|-------------------------------|
| `events` | `payload` | prompt_preview / command_preview / tool_input / tool_output | Not indexed (`schema.ts:111-124` index `session_id`,`type`,`timestamp`,`id` — never `payload`). ✅ safe |
| `tasks` | `description` | free-text task detail | `idx_tasks_status_priority_updated` (`schema.ts:167`) covers status/priority/updated_at, not description. ✅ |
| `tasks` | `title` | *candidate* — but `title` is shown in list views w/o opening a row | Not indexed, but rendered in bulk list queries. **Open Q O-1:** encrypt title too (defence-in-depth) or leave cleartext (lower friction)? |
| `iterations` | `body`, `imported_body` | free-text iteration plan / upstream snapshot | `idx_iterations_state_priority` (`schema.ts:196`) — body not indexed. ✅ |
| `agent_task_assignment` | `block_reason` | JSON BlockReason — may quote tool output / errors | Constrained by `CHECK(json_valid(block_reason))` (`schema.ts:82`) and `CHECK((state='blocked')=(block_reason IS NOT NULL))` (`:80`). **⚠️ Encryption breaks both CHECKs** — see §2.6. |
| `learnings` | `content` | principal free-text learnings | **Breaks `LIKE` search + relevance scoring** — §2.5. |

**Stays cleartext (load-bearing):** all `id`/`*_id` columns, `principal_id`, `session_id`, `type`, `status`/`state`, `priority`, all timestamps, `source_*`, `provider`, `external_id`, `url`. These are every join/filter/sort key in the schema.

### §2.2 Rejected for local: SQLCipher / whole-DB

SQLCipher would transparently encrypt the *entire* file (including indices), removing the per-column ceremony. **Rejected because `bun:sqlite` does not bundle SQLCipher** — `bun:sqlite` links the stock SQLite amalgamation with no crypto VFS. Adopting SQLCipher means either (a) a native module + build toolchain per platform (violates the repo's "no infra to set up out-of-box" and "lightweight/pragmatic" defaults), or (b) forking the runtime DB layer. Field-level encryption needs zero native deps — it's pure WebCrypto, already vendored via myelin. **Decision: field-level.** (Documented option, not chosen: revisit SQLCipher only if bun ships first-class support.)

### §2.3 Cloud D1 — CF-managed storage

D1 is encrypted at rest *by Cloudflare* with a *CF-held* key. cortex **cannot** rotate, escrow, or withhold that key — so CF-layer at-rest gives confidentiality against third parties but **not against Cloudflare-the-operator or a compromised CF account/D1 export.** The only cortex-controllable lever is **field-level app encryption in the Worker before `INSERT`.**

**Columns to encrypt (D1 — `worker/schema.sql`):**

| Table | Column | Write seam | Index check |
|-------|--------|-----------|-------------|
| `github_events` | `payload` | `INSERT OR IGNORE INTO github_events` (`worker/src/routes/github.ts:117`) | indices on `repo`,`agent_authored`,`principal_id` (`schema.sql:142-144`) — payload not indexed. ✅ |
| `audit_log` | `detail`, `ip` | `INSERT INTO audit_log` (`worker/src/auth.ts:33`, `user-auth/middleware/audit.ts:22`) | indices on `timestamp`,`event_type` (`schema.sql:134-135`) — detail/ip not indexed. ✅ |
| `users` | `email` | auth migration `0001_auth_tables.sql` | **⚠️ `email TEXT UNIQUE NOT NULL` + `idx_users_email`** — email is a **lookup key**. Randomised encryption breaks the UNIQUE constraint and the lookup. See §2.5/Open Q O-2. |
| `sessions` (D1) | `description` | ingest pipeline | not indexed. ✅ (candidate, lower sensitivity) |

**Decision for D1:** field-level only, DEK delivered to the Worker as a `wrangler secret`. No whole-DB option exists (CF owns the key).

### §2.4 Event JSONL — `~/.claude/events/raw/` + `/published/`

Written by the cc-events tap (`src/taps/cc-events/`); carries `prompt_preview`, `command_preview`, `tool_input`, `tool_output` (`hooks/EventLogger.hook.ts:176-201`). **Constraint from CLAUDE.md: hooks must stay non-blocking and must never call the network.** WebCrypto AES-GCM is local and synchronous-enough, but the hook writes raw JSONL and *returns*; the **relay** (`cortex-relay`) is the async stage. **Recommendation: encrypt at the relay boundary (raw→published), not in the hook.** The `raw/` spool is short-lived and TC-4b chmod-guards it; `published/` is the durable spool and is where the cipher belongs. This keeps the hook dead-simple and non-blocking per the repo rule. (Open Q O-3: do we also encrypt `raw/`, or rely on TC-4b file-mode + short TTL there?)

### §2.5 The queryable-column problem (email, learnings.content)

Two columns are *both* high-sensitivity *and* queried by value:

- **`users.email`** — UNIQUE + indexed, used for login lookup.
- **`learnings.content`** — `LIKE`-searched (`learning-store.ts:99`) and substring-scored (`:159`).

Randomised AES-GCM makes these un-queryable. Three resolutions, in increasing cost:
1. **Leave cleartext** (accept the metadata leak for email; accept content-search keeps content cleartext). Simplest; documents the gap.
2. **Deterministic / blind-index** — store `HMAC(key, normalised_value)` in a sibling indexed column for equality lookup, ciphertext in the real column. Restores exact-match (email login) but **not** substring search (learnings `LIKE`). Adds a second key and a schema column.
3. **Encrypted search** is out of scope (no OPE/SSE in this design).

**Recommendation:** **defer both to a follow-up slice.** Ship the unambiguous non-indexed columns first (§7 slice ordering). `users.email` and `learnings.content` get their own sub-issue with the blind-index decision. Mark as **Open Q O-2** (email) and note learnings.content stays cleartext in v1.

### §2.6 The `block_reason` CHECK collision

`agent_task_assignment.block_reason` carries two schema CHECKs (`schema.ts:80,82`): `json_valid(block_reason)` and the blocked-iff-non-null invariant. Encrypted ciphertext is **not valid JSON**, so the `json_valid` CHECK rejects the write. Options: (a) drop/relax the `json_valid` CHECK via a REBUILD migration (the repo already has the `REBUILD_MIGRATIONS` machinery — `schema.ts:539`), keeping the blocked-iff invariant; (b) wrap the ciphertext in a JSON envelope `{"enc":"<b64>"}` so `json_valid` still passes (cheaper — no rebuild). **Recommendation: (b)** — the `FieldCipher` envelope (§4) is already JSON, so `json_valid` passes for free. Flagged so the implementer doesn't trip the CHECK.

---

## §3 — Key custody (the central decision)

This is the decision that matters. Everything in §2 and §4 is mechanism; **who holds the key, and whether it correlates with the stolen bytes, is the security property.**

### §3.1 The correlation trap

The naive move is "derive the AES key from the stack identity seed." cortex already has a stack identity (the ed25519 seed used for envelope signing). One root, no new ceremony — exactly the §0-style elegance the sibling envelope-encryption doc used for *transit* keys. **But for at-rest it is a trap:** the stack identity seed lives **on the same disk** as the encrypted DBs (`~/.config/.../identity` next to `~/.local/share/grove/...`). An attacker who steals the disk to get the ciphertext steals the seed in the same theft. **The key and the data co-reside ⇒ encryption buys nothing against the exact threat (offline disk theft) it's meant to stop.** This correlation is the crux.

### §3.2 The three options (as posed in the umbrella)

**(a) Derive DEK directly from the stack identity seed.**
- *Pro:* one root, zero new key material, zero operator ceremony, consistent with the transit-key story.
- *Con:* **full correlation** — seed-theft ⇒ data-theft (§3.1). Defeats the offline-theft threat. Acceptable *only* if the seed itself is independently protected (passphrase / keychain), which collapses (a) into (b).

**(b) Separate operator-held key / OS keychain.**
- A dedicated at-rest key, stored in the **OS keychain** (macOS Keychain / `libsecret` / a passphrase-unlocked keyfile), independent of the identity seed.
- *Pro:* **breaks the correlation** — disk theft yields ciphertext but not the key (the keychain is not a flat file the same `cp -r` grabs; it's user-login-bound, hardware-backed on macOS). Survives the exact threat model.
- *Con:* operator ceremony (unlock on boot / keychain prompt), a key to back up and not lose, headless-host friction (no interactive keychain).

**(c) Per-store keys.**
- A distinct DEK per DB / per JSONL spool, each wrapped by the same KEK.
- *Pro:* blast-radius isolation + per-store rotation; a leaked single DB DEK doesn't expose the others.
- *Con:* more keys to manage; the marginal benefit over (b) is small when one process reads all stores anyway.

### §3.3 Recommendation — (b′): HKDF-derived DEK wrapped by a keychain KEK, per-store sub-keys via HKDF `info`

Take **(b)** as the trust anchor and fold in **(c)**'s isolation cheaply:

```
KEK  = operator key in OS keychain (macOS Keychain / libsecret),
       OR passphrase-derived (PBKDF2, reusing myelin's 600k-iter KDF) for headless hosts.
DEK  = HKDF-SHA256(ikm = KEK, salt = per-host random, info = "cortex/at-rest/v1")
DEK_events       = HKDF(DEK, info="events.payload")
DEK_tasks        = HKDF(DEK, info="tasks/iterations")
DEK_d1           = (Worker secret, separate KEK — §3.5)
```

- **Trust anchor is the keychain KEK, NOT the identity seed** — this is the whole point. The identity seed signs envelopes; the at-rest KEK encrypts data; they are **deliberately uncorrelated** so a single disk theft yields neither plaintext nor a usable key.
- **Per-store sub-keys for free** via HKDF `info` (gives (c)'s isolation without (c)'s key-management cost).
- **Headless fallback:** a passphrase-derived KEK (myelin's PBKDF2-600k, `encryption.ts:20`) for servers with no interactive keychain — same primitive the identity-key protection already uses, so no new crypto.

**Why not (a):** §3.1. **Why not pure (c):** the isolation it buys is subsumed by HKDF sub-keys at a fraction of the key-management cost.

**The residual honest caveat:** on a host with **no keychain and an auto-unlock passphrase stored on the same disk** (so the daemon can restart unattended), (b′) degrades toward (a)'s correlation. We state this plainly: *unattended headless encryption is only as strong as where the unlock secret lives.* The recommendation for headless is a passphrase delivered via env/secret-manager at process start (not a disk file) — see Open Q O-4.

### §3.4 Key rotation

DEK rotation = re-wrap: generate DEK′, re-encrypt affected columns under DEK′ (the same migration machinery as the initial encrypt, §5), bump the `kid` in the envelope (§4). KEK rotation = re-wrap the DEK only (cheap, no row rewrite). The self-describing envelope carries a `kid` so old and new ciphertext coexist during rotation. Full rotation policy is a follow-up; v1 only needs the envelope to *carry* `kid` so rotation is possible later.

### §3.5 D1 key custody

The Worker cannot reach the operator's keychain. The D1 DEK is a **`wrangler secret`** (CF-encrypted secret store), distinct from the local KEK. *Pro:* CF never sees plaintext column values in D1 storage. *Con:* the secret lives in CF's secret store — so the threat "CF-the-operator is hostile" is only partially mitigated (CF holds both the D1 storage key AND the Worker secret). We document this honestly: D1 field encryption protects against **D1 export leaks and third-party D1 access**, not against a fully-compromised CF account. That is still a real, worthwhile gain over today (cleartext).

---

## §4 — Crypto

**Primitive:** AES-256-GCM, **reusing myelin's `agent-identity/encryption.ts`** behind a thin cortex `FieldCipher` wrapper (no new crypto code; the primitive is already vendored and reviewed — `node_modules/@the-metafactory/myelin/src/agent-identity/encryption.ts`). myelin's helper is currently PBKDF2-passphrase→key; for at-rest we feed it a **pre-derived DEK** (§3.3) instead of running PBKDF2 per value (PBKDF2-per-value would be catastrophic for performance — the KDF runs once at key setup, not per row).

**Per-value envelope** (self-describing, versioned — mirrors myelin's `EncryptedPrivateKey` shape):

```jsonc
{
  "v": 1,
  "alg": "aes-256-gcm",
  "kid": "atrest-v1",        // key id — enables rotation (§3.4)
  "iv":  "<base64 12-byte random nonce>",  // per-value, NIST SP 800-38D
  "ct":  "<base64 ciphertext||tag>",
  "aad": "events.payload"    // see below
}
```

- **Per-value nonce:** fresh 12-byte CSPRNG IV per encrypted value (`crypto.getRandomValues`). Never reused — GCM nonce reuse is catastrophic. With random 96-bit IVs the birthday bound is comfortable for cortex volumes; documented for the implementer.
- **AAD (additional authenticated data):** bind each ciphertext to its logical location — `"{table}.{column}"` and, where cheap, the row `id`. This prevents an attacker who can write to the DB from *moving* a valid ciphertext from one row/column to another (cut-and-paste / confused-deputy). The AAD is authenticated but not encrypted.
- **Encrypt-then-MAC is intrinsic to GCM** (the tag covers ciphertext+AAD).
- **Envelope stored as TEXT** in the existing column (it's already `TEXT`/`TEXT DEFAULT '{}'`); JSON envelope keeps `json_valid` CHECKs passing (§2.6).

**Anti-oracle / failure handling:** reuse myelin's single-message decrypt-failure pattern (`encryption.ts:140-153`) — one catch, one opaque error, no distinguishing "bad key" from "tampered" from "bad base64."

---

## §5 — Migration (encrypting existing plaintext + the `off→on` flip)

### §5.1 The flip is gated by TC-0

`encryption.at_rest: off` (default, cortex#628) ⇒ `FieldCipher` is a pass-through; bytes are byte-identical to today. `off→on` is the trigger.

### §5.2 One-time, resumable, idempotent migration

On `off→on` (or first boot with `on`):

1. **Provision the KEK/DEK** (§3.3) — keychain entry or passphrase prompt; persist the wrapped DEK + salt.
2. **Backfill each store:** stream rows, for each encryptable column: if the value is *not already* a `FieldCipher` envelope (detect via the `{"v":1,"alg":...}` shape — same `isEncryptedPrivateKey`-style guard as myelin `:164`), encrypt-in-place and `UPDATE`. **Idempotent:** re-running skips already-enveloped values, so a crash mid-migration resumes cleanly.
3. **JSONL:** rewrite `published/` files (and optionally `raw/`, Open Q O-3) value-by-value; mark migrated with a sidecar/marker so re-runs skip.
4. **D1:** a Worker-side batch job (or `wrangler d1 execute` with a paginated re-encrypt script) over `github_events`/`audit_log` — same idempotent envelope detection.
5. **`block_reason`:** wrap as JSON envelope so the `json_valid` CHECK passes (§2.6) — *no* REBUILD migration needed.

**Reversibility:** an `on→off` flip is *not* auto-decrypt (we keep it as a guarded admin command, not a config flip) — encrypted-at-rest data stays encrypted unless explicitly migrated back, so an accidental toggle can't silently expose data. Document loudly.

### §5.3 Backups

The migration touches live DBs — operators take a backup first (the runbook says so). WAL-mode (`init.ts:20`) means the migration runs inside the existing connection machinery; the REBUILD-style transactional pattern (`init.ts:50-78`) is the template for a safe in-place rewrite.

---

## §6 — Performance

- **Scope keeps cost negligible:** only non-indexed, high-sensitivity columns are touched. The hot path is the events ingestor (`insertEvent`, "hundreds of events/sec under burst" per `events.ts:8`). AES-GCM on a ~few-KB payload is single-digit microseconds — well under the existing `JSON.stringify` cost it sits next to. **No index is encrypted, so query planning is unchanged** (the whole point of §1.3).
- **Read path:** decrypt happens only when a row is actually opened (e.g. `listEventsForSession` drill-down, capped at 200 rows — `events.ts:112`). List/filter/sort queries never decrypt (they only touch cleartext columns).
- **KDF cost is one-time:** PBKDF2-600k runs once at key setup (§4), never per value.
- **Measurement plan (acceptance gate):** micro-benchmark `insertEvent` and the 200-row drill-down read with cipher on vs off; require p99 ingest overhead < 1ms/event and drill-down read overhead < 50ms/page. Numbers go in the iteration doc's acceptance criteria, measured before enabling the toggle by default.

---

## §7 — Iteration plan pointer

The phased slice plan lives in **`docs/iteration-at-rest-encryption.md`**. Summary: crypto helper + key custody → local SQLite columns → D1 field columns → JSONL → migration + enable behind toggle. Each slice has acceptance criteria; the queryable-column columns (`users.email`, `learnings.content`) are explicitly a *later* slice.

---

## §8 — Open questions (for the design session — Andreas + Luna)

- **O-1 — `tasks.title`:** encrypt (defence-in-depth; titles can leak project intent) or leave cleartext (rendered in bulk list views, lower friction)? Recommend: leave cleartext in v1, revisit.
- **O-2 — `users.email`:** blind-index (HMAC sibling column) for login lookup, or leave cleartext and accept the metadata leak? Recommend: cleartext v1, blind-index as a follow-up sub-issue.
- **O-3 — JSONL `raw/`:** encrypt the short-lived `raw/` spool too, or rely on TC-4b file-mode + short TTL and only encrypt `published/`? Recommend: `published/` only in v1.
- **O-4 — headless KEK:** for unattended daemons with no interactive keychain, where does the unlock secret live? (env from secret-manager at process start vs disk keyfile — the latter degrades to the §3.1 correlation.) Needs an operator-policy decision.
- **O-5 — `learnings.content`:** confirm it stays cleartext in v1 (breaks `LIKE` search otherwise). Is the runner-learning DB even in scope for v1, or deferred entirely?
- **O-6 — D1 CF-operator threat:** is "protect against D1 export / third-party, NOT against a fully-compromised CF account" an acceptable v1 posture? (It is the best cortex can do given CF owns the storage key.)
- **O-7 — rotation cadence:** does v1 need a rotation *command*, or only the envelope `kid` field that *enables* future rotation? Recommend: envelope carries `kid`; rotation command is a follow-up.
