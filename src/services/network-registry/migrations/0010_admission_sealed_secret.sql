-- ADR-0018 PR5b (#1240) — leaf-secret sealed delivery + revoke.
--
-- Background
-- ──────────
-- PR5a created the member PoP-read endpoint with a `sealed_secret` slot that
-- the response synthesised as NULL (the column did not yet exist). PR5b is the
-- secret-delivery mechanism:
--   1. Add `sealed_secret` column — the OPAQUE per-member ciphertext the
--      hub-admin seals to the member's ed25519 pubkey (`crypto_box_seal`). The
--      registry only ever carries this blob; it cannot read it (ADR-0018 Q1 b′).
--   2. Add REVOKED to the status CHECK — `cortex network secret revoke-member`
--      transitions ADMITTED → REVOKED (after cutting transport at the hub), so
--      the roster + the member PoP-read both stop serving the member (Q6).
--
-- SQLite cannot add a value to a CHECK constraint nor (portably) DROP a column
-- across all D1-supported versions, so we recreate the table — the SAME
-- portable pattern migration 0007 used — preserving every column 0007/0008
-- established, adding `sealed_secret`, widening the status CHECK, copying
-- surviving rows, and recreating BOTH indexes (the status index AND the 0008
-- per-network COALESCE unique index). New `sealed_secret` starts NULL for every
-- copied row.
--
-- Safety: the registry is not yet deployed at this schema version (per the
-- 0007/0008 headers), so the recreate has no live rows to migrate beyond the
-- copy below.

-- Step A — new table: 0007/0008 columns + sealed_secret + widened status CHECK.
CREATE TABLE IF NOT EXISTS admission_requests_v2 (
  request_id      TEXT    NOT NULL PRIMARY KEY,
  principal_id    TEXT    NOT NULL,
  peer_pubkey     TEXT    NOT NULL,
  requested_scope TEXT    NOT NULL,
  network_id      TEXT    ,
  status          TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'ADMITTED', 'REJECTED', 'REVOKED')),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  granted_by      TEXT    ,
  -- ADR-0018 Q1 (b′) — opaque per-member sealed ciphertext. The registry never
  -- reads it. NULL until add-member (sealed) delivers it; NULL again on revoke.
  sealed_secret   TEXT
);

-- Step B — copy surviving rows; sealed_secret starts NULL.
INSERT INTO admission_requests_v2
  (request_id, principal_id, peer_pubkey, requested_scope, network_id,
   status, created_at, updated_at, granted_by, sealed_secret)
SELECT
  request_id, principal_id, peer_pubkey, requested_scope, network_id,
  status, created_at, updated_at, granted_by, NULL
FROM admission_requests;

-- Step C — swap the table in.
DROP TABLE IF EXISTS admission_requests;
ALTER TABLE admission_requests_v2 RENAME TO admission_requests;

-- Step D — recreate indexes (status + the 0008 per-network COALESCE unique).
CREATE INDEX IF NOT EXISTS idx_admission_requests_status
  ON admission_requests (status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admission_requests_peer_network
  ON admission_requests (principal_id, peer_pubkey, COALESCE(network_id, ''));
