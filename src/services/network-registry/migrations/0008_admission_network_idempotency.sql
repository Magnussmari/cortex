-- ADR-0018 Gap-A — per-network admission idempotency.
--
-- Background
-- ──────────
-- Migration 0007 created `admission_requests` with a unique index on
-- `(principal_id, peer_pubkey)` — one admission row per (principal, peer). That
-- pre-dates the network-admission gate naming the TARGET network: under
-- ADR-0018 the joiner names the network at register time (`network_id`), and a
-- single stack may request admission to TWO networks. The old index would make
-- the second network's register collide with the first (ON CONFLICT DO NOTHING
-- returns the first network's row), silently dropping the second request.
--
-- This migration re-keys idempotency to the TRIPLE
-- `(principal_id, peer_pubkey, COALESCE(network_id, ''))`:
--   - two DISTINCT networks for the same (principal, peer) are two distinct rows;
--   - a network-less register (NULL network_id — a plain identity register, not
--     a join) still dedupes, because `COALESCE(network_id, '')` normalises NULL
--     to '' (SQLite would otherwise treat each raw NULL as distinct and re-insert
--     a duplicate PENDING row on every re-register). This preserves the
--     pre-ADR-0018 `(principal_id, peer_pubkey)` idempotency for that path.
--
-- The `network_id` column itself already exists (added nullable in 0007); this
-- migration only swaps the unique index. The application-layer upsert
-- (`D1IssuanceRequestStore.upsertPending`) targets the matching expression:
--   ON CONFLICT(principal_id, peer_pubkey, COALESCE(network_id, '')) DO NOTHING.
--
-- Safety: index-only change; no row rewrite. The registry is not yet deployed
-- at this schema version, so there are no live rows to migrate.

-- Drop the old (principal_id, peer_pubkey) idempotency index.
DROP INDEX IF EXISTS idx_admission_requests_peer;

-- Re-create idempotency on the per-network triple. The COALESCE expression makes
-- the index NULL-safe so a network-less register dedupes on (principal, peer).
CREATE UNIQUE INDEX IF NOT EXISTS idx_admission_requests_peer_network
  ON admission_requests (principal_id, peer_pubkey, COALESCE(network_id, ''));
