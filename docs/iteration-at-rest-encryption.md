# At-Rest Encryption Iteration (TC-4c)

**Mission:** High-sensitivity at-rest data (prompts, commands, tool I/O, task/iteration bodies, auth detail) is unreadable from stolen disk bytes, leaked backups, or D1 exports — while every routing/lookup/filter column stays cleartext and queryable.

**Design Spec:** `docs/design-at-rest-encryption.md`
**Tracking Issue:** [#638](https://github.com/the-metafactory/cortex/issues/638) (TC-4c) · **Umbrella:** [#627](https://github.com/the-metafactory/cortex/issues/627) (Trust & Confidentiality) · **Gate:** [#628](https://github.com/the-metafactory/cortex/issues/628) (TC-0 `encryption.at_rest` toggle)

**Drive posture:** field-level, toggle-gated, `off` by default. Every slice lands behind `encryption.at_rest: off` so nothing changes for existing operators until the explicit `off→on` flip.

---

## Legend

- `[x]` done
- `[ ]` not started
- 🏃 in progress
- **(sub-issue)** — slice becomes a GitHub sub-issue of #638

---

## Slice 1 — `FieldCipher` helper + key custody (sub-issue)

The foundation: the crypto wrapper + the key-management decision from design §3–§4. No store touched yet.

- [ ] Thin `FieldCipher` wrapping myelin's AES-256-GCM (`@the-metafactory/myelin` `agent-identity/encryption.ts`) — takes a pre-derived DEK, not a per-value passphrase
- [ ] Self-describing per-value envelope: `{ v, alg, kid, iv, ct, aad }` (design §4) + `isFieldEnvelope()` type guard (mirrors myelin `isEncryptedPrivateKey`)
- [ ] Per-value random 12-byte nonce; AAD = `"{table}.{column}"` (+ row id where cheap)
- [ ] Key custody = recommendation (b′): keychain KEK → HKDF DEK → per-store HKDF sub-keys; PBKDF2-600k passphrase fallback for headless (design §3.3)
- [ ] `kid` field present so rotation is *possible* later (no rotation command yet — O-7)
- [ ] Single-message decrypt-failure (anti-oracle), reusing myelin's pattern

### Acceptance (Slice 1)

- [ ] `FieldCipher.seal()/.open()` round-trips arbitrary strings; tampered ciphertext / wrong key → single opaque error
- [ ] DEK derives from keychain KEK, **not** from the stack identity seed (correlation test: deleting the keychain entry makes data unreadable even with the identity seed present)
- [ ] Headless passphrase path produces a usable DEK with no keychain
- [ ] Toggle `off` ⇒ `FieldCipher` is pass-through (bytes identical to today)

---

## Slice 2 — Local SQLite high-sensitivity columns (sub-issue)

Wire the cipher into the local DB seams. Non-indexed, unambiguous columns only.

- [ ] `events.payload` — seal at `insertEvent` stringify seam (`db/events.ts:89`), open at `listEventsForSession` parse seam (`:167`)
- [ ] `tasks.description` — at the `db/tasks.ts` mapper boundary
- [ ] `iterations.body` + `iterations.imported_body` — at `db/iterations.ts` boundary
- [ ] `agent_task_assignment.block_reason` — JSON-envelope wrap so `json_valid` CHECK passes (design §2.6; **no** REBUILD migration)
- [ ] Confirm no encrypted column participates in any index (re-check against `schema.ts` indices)

### Acceptance (Slice 2)

- [ ] With toggle `on`, the four columns are ciphertext on disk (`sqlite3` shows envelopes, not plaintext)
- [ ] Dashboard list/filter/sort queries unchanged (touch only cleartext columns; no decrypt on list paths)
- [ ] Drill-down read decrypts correctly; round-trips through `insertEvent`→`listEventsForSession`
- [ ] `block_reason` write passes both schema CHECKs (`json_valid` + blocked-iff-non-null)
- [ ] Toggle `off` ⇒ existing tests pass byte-identically

---

## Slice 3 — D1 field columns (sub-issue)

Worker-side field encryption before `INSERT`. DEK delivered as `wrangler secret`.

- [ ] `github_events.payload` — seal at `worker/src/routes/github.ts:117` insert; open at the read routes (`state.ts`, `stats.ts`)
- [ ] `audit_log.detail` + `audit_log.ip` — seal at `worker/src/auth.ts:33` + `user-auth/middleware/audit.ts:22`; open at `admin.ts` read
- [ ] D1 DEK as a `wrangler secret`, separate from the local KEK (design §3.5)
- [ ] (Candidate) `sessions.description` (D1) if cheap

### Acceptance (Slice 3)

- [ ] D1 export shows ciphertext for `github_events.payload`, `audit_log.detail`/`ip`
- [ ] github sync + audit read paths decrypt correctly in the Worker
- [ ] Indexed columns (`repo`, `principal_id`, `timestamp`, `event_type`) untouched and still queryable
- [ ] Documented honestly: protects D1 export / third-party, NOT a fully-compromised CF account (O-6)

---

## Slice 4 — Event JSONL (`published/`) (sub-issue)

Encrypt the durable spool at the relay boundary — **not** in the hook (hooks stay non-blocking, no crypto-in-hook per CLAUDE.md).

- [ ] Seal `prompt_preview` / `command_preview` / `tool_input` / `tool_output` at the `cortex-relay` raw→published stage
- [ ] Pairs with TC-4b file-mode hardening (dependency note, not duplicated here)
- [ ] `raw/` left cleartext in v1 (short-lived; TC-4b chmod-guarded) — pending O-3

### Acceptance (Slice 4)

- [ ] `published/` JSONL high-sensitivity fields are envelopes on disk
- [ ] Hook remains non-blocking, makes no crypto/network call
- [ ] cortex daemon reads `published/` and decrypts before bus publish

---

## Slice 5 — Migration + enable behind toggle (sub-issue)

The `off→on` flip + one-time backfill of existing plaintext.

- [ ] Resumable, idempotent backfill: skip already-enveloped values (crash-safe re-run) — design §5.2
- [ ] Key provisioning on first `on` (keychain entry / passphrase prompt; persist wrapped DEK + salt)
- [ ] D1 paginated re-encrypt job (Worker-side or `wrangler d1 execute` script)
- [ ] JSONL `published/` rewrite with migrated-marker
- [ ] `on→off` does **not** auto-decrypt (guarded admin command only — accidental toggle can't expose data)
- [ ] Runbook: backup-first; WAL/transactional in-place rewrite pattern (template: `init.ts:50-78`)

### Acceptance (Slice 5)

- [ ] Fresh `off→on` on a populated DB encrypts all targeted existing rows; re-run is a no-op
- [ ] Mid-migration crash resumes cleanly (idempotent)
- [ ] Perf gate measured cipher-on vs off: p99 ingest overhead < 1ms/event, drill-down read < 50ms/page (design §6)
- [ ] `encryption.at_rest: off` still byte-identical to pre-TC-4c behaviour

---

## Slice 6 — Queryable-column follow-up (sub-issue, deferred)

The columns that are *both* sensitive *and* queried by value. Explicitly later.

- [ ] `users.email` — decision: blind-index (HMAC sibling column) for login lookup vs leave cleartext (O-2)
- [ ] `learnings.content` — confirm cleartext in v1 (encryption breaks `LIKE` search + relevance scoring); scope decision for the runner-learning DB (O-5)
- [ ] (Optional) key-rotation command using the envelope `kid` (O-7)

### Acceptance (Slice 6)

- [ ] Chosen email resolution implemented or explicitly documented as accepted-cleartext with rationale
- [ ] `learnings.content` posture ratified and documented

---

## Exit Criteria

- [ ] Slices 1–5 complete; Slice 6 either complete or split into its own tracked follow-up
- [ ] `encryption.at_rest: off` (default) ⇒ no behavioural or byte change vs pre-TC-4c
- [ ] `encryption.at_rest: on` ⇒ all v1-targeted columns/files ciphertext at rest, all routing/lookup/filter columns cleartext and queryable
- [ ] Key custody anchored on a keychain/operator KEK uncorrelated with the stack identity seed (the §3.1 correlation broken)
- [ ] Performance gate met; migration idempotent + resumable; no auth/dashboard/ingest regressions
- [ ] All design §8 open questions (O-1..O-7) resolved or explicitly carried as follow-ups
