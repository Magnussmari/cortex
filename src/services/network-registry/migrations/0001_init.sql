-- cortex#682 (D.4 Roadmap items 1+2): durable storage for the network
-- registry. Backs the principal directory AND the nonce-replay cache so
-- both survive Worker-isolate recycling — the durability gate before the
-- PROD deploy.
--
-- Apply:
--   bunx wrangler d1 migrations apply cortex-network-registry-dev --env dev --remote
--   bunx wrangler d1 migrations apply cortex-network-registry      --env production --remote
--
-- Schema notes
-- ────────────
-- `principals` mirrors the PrincipalRecord wire shape (src/types.ts).
-- The variable-length `stacks` and `capabilities` lists are stored as
-- JSON text columns rather than child tables: the registry only ever
-- reads/writes a principal as a whole record (UPSERT on register, SELECT
-- on resolve, SELECT * for roster/capability scans), so normalising into
-- join tables would buy nothing and cost a multi-statement write per
-- register. JSON-in-a-column keeps putPrincipal a single atomic UPSERT.
--
-- `nonces` is the durable replay cache. The nonce is the PRIMARY KEY, so
-- a replay across isolates/colos collides on INSERT and is rejected
-- durably (D1NonceCache.recordIfFresh uses INSERT OR IGNORE → fresh iff a
-- row was created). `seen_at` (epoch ms) drives opportunistic pruning of
-- entries older than NONCE_WINDOW_MS.

CREATE TABLE IF NOT EXISTS principals (
  principal_id      TEXT PRIMARY KEY,
  principal_pubkey  TEXT NOT NULL,
  -- JSON-encoded StackIdentity[] (may be an empty array '[]').
  stacks            TEXT NOT NULL DEFAULT '[]',
  -- JSON-encoded Capability[] (may be an empty array '[]').
  capabilities      TEXT NOT NULL DEFAULT '[]',
  -- ISO-8601 UTC; mirrors PrincipalRecord.updated_at.
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce    TEXT PRIMARY KEY,
  -- Epoch milliseconds the nonce was first seen. Drives window pruning.
  seen_at  INTEGER NOT NULL
);

-- Supports the opportunistic prune in D1NonceCache.recordIfFresh
-- (DELETE FROM nonces WHERE seen_at < ?), keeping the cache bounded to
-- roughly the NONCE_WINDOW_MS horizon without a full-table scan.
CREATE INDEX IF NOT EXISTS idx_nonces_seen_at ON nonces(seen_at);
