-- ADR-0018 Gap-B (BLOCK-2) — backfill: grandfather existing capability-derived
-- roster members into ADMITTED admission rows.
--
-- Background
-- ──────────
-- Gap-B flips the SERVED roster source (`GET /networks/{id}` descriptor +
-- `/roster`) from the capability-derived view (`membersFromPrincipals` — a
-- principal is "in" network X iff one of its announced capabilities lists X in
-- `capability.networks[]`) to the admission-derived view (`rosterFromAdmissions`
-- — a principal is "in" X iff they hold an ADMITTED `admission_requests` row
-- pinned to X).
--
-- Today's LIVE members are on the roster ONLY via the capability path; none hold
-- an ADMITTED admission row (the admit step + `network_id` stamping are NEW —
-- BLOCK-1). Without this backfill, the roster-source cutover would return an
-- EMPTY roster on deploy, and the federation reconciler (which projects roster
-- members → leaf peers) would wire 0 peers — the exact #762 hand-pin-wipe /
-- federation-outage failure. This migration materialises the existing
-- capability membership as ADMITTED rows so the cutover preserves the live
-- roster byte-for-byte.
--
-- ⚠️ DEPLOY SEQUENCING — this migration MUST be applied on the registry deploy
-- that ships the Gap-B roster-source switch (it is the data half of that change).
-- Applying the code without this migration empties the live roster.
--
-- Security
-- ────────
-- This grandfathers ONLY principals ALREADY on the roster under the retired
-- capability rule — i.e. those whose registered `capabilities[].networks[]`
-- already names the network. It grants NO new access: every (principal, network)
-- pair it admits was already a roster member a moment before the cutover. A
-- principal with no capability targeting a network gets NO row (and stays off
-- that roster). `granted_by` is a system/backfill marker, not an admin pubkey,
-- so the provenance of these rows is auditable and distinguishable from a real
-- admin admission.
--
-- Idempotency
-- ───────────
-- `INSERT OR IGNORE` respects the 0008 unique index
-- `(principal_id, peer_pubkey, COALESCE(network_id, ''))`: re-running this
-- migration (or running it after some members were admitted for real) inserts
-- nothing for a (principal, peer, network) triple that already has a row. The
-- `peer_pubkey` is the principal's own pubkey (matching the register hook's
-- default when a claim carries no stacks); roster membership is keyed on
-- `principal_id` + `network_id` (`rosterFromAdmissions` dedupes per principal),
-- so a backfilled row and a later real admission row never double-count.
--
-- `requested_scope` mirrors the register hook (`federated.<principal>.>`).
-- `created_at`/`updated_at` are the migration instant (ISO-8601 UTC, matching
-- the `new Date().toISOString()` shape the application layer writes).
--
-- Implementation note: `capabilities` is a JSON text column; we walk it with
-- `json_each` and explode each capability's `networks[]` array, grouping to one
-- ADMITTED row per (principal, network). `json_each(NULL)` (a capability with no
-- `networks` key) yields no rows, so caps without a network target contribute
-- nothing.

INSERT OR IGNORE INTO admission_requests
  (request_id, principal_id, peer_pubkey, requested_scope, network_id,
   status, created_at, updated_at, granted_by)
SELECT
  lower(hex(randomblob(16))),                       -- opaque hex request id
  p.principal_id,
  p.principal_pubkey,                               -- peer_pubkey = principal pubkey
  'federated.' || p.principal_id || '.>',           -- mirror the register hook scope
  net.value,                                        -- the network the cap targets
  'ADMITTED',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'backfill:0009-grandfather'                        -- system marker, not an admin pubkey
FROM principals AS p
JOIN json_each(p.capabilities) AS cap
JOIN json_each(json_extract(cap.value, '$.networks')) AS net
GROUP BY p.principal_id, net.value;
