/**
 * ADR-0018 Gap-B (BLOCK-2) — migration 0009 backfill test.
 *
 * Runs the real SQL chain (0001 → 0004 → 0007 → 0008 → 0009) against
 * `bun:sqlite` (D1 is SQLite under the hood) and proves the backfill
 * grandfathers EXISTING capability-derived roster members into ADMITTED
 * admission rows WITHOUT granting any new access:
 *   - a principal whose `capabilities[].networks[]` names network X gets an
 *     ADMITTED row pinned to X → appears in `rosterFromAdmissions`;
 *   - a principal with NO capability targeting X gets NO row → absent;
 *   - the backfill is idempotent (re-run inserts nothing — the 0008 unique
 *     index on `(principal_id, peer_pubkey, COALESCE(network_id,''))`);
 *   - a pre-existing ADMITTED row (peer_pubkey = principal pubkey) is not
 *     duplicated.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rosterFromAdmissions } from "../src/store";
import type { AdmissionRequest, PrincipalRecord } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

let db: Database;

function applyThrough0008(): void {
  for (const f of [
    "0001_init.sql",
    "0004_issuance_requests.sql",
    "0007_admission_requests.sql",
    "0008_admission_network_idempotency.sql",
  ]) {
    db.run(readFileSync(join(migrationsDir, f), "utf8"));
  }
}

function runBackfill(): void {
  db.run(
    readFileSync(
      join(migrationsDir, "0009_backfill_admitted_from_capabilities.sql"),
      "utf8",
    ),
  );
}

function insertPrincipal(
  principalId: string,
  pubkey: string,
  capabilities: { id: string; networks?: string[] }[],
): void {
  db.run(
    `INSERT INTO principals (principal_id, principal_pubkey, stacks, capabilities, updated_at)
       VALUES (?, ?, '[]', ?, ?)`,
    [principalId, pubkey, JSON.stringify(capabilities), "2026-01-01T00:00:00Z"],
  );
}

/** Read all admission rows out of SQLite as typed AdmissionRequest[]. */
function admissionRows(): AdmissionRequest[] {
  return db
    .query(
      `SELECT request_id, principal_id, peer_pubkey, requested_scope, network_id,
              status, created_at, updated_at, granted_by
         FROM admission_requests`,
    )
    .all() as AdmissionRequest[];
}

/** Read all principals out of SQLite as typed PrincipalRecord[]. */
function principalRecords(): PrincipalRecord[] {
  const rows = db
    .query(`SELECT principal_id, principal_pubkey, stacks, capabilities, updated_at FROM principals`)
    .all() as {
    principal_id: string;
    principal_pubkey: string;
    stacks: string;
    capabilities: string;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    principal_id: r.principal_id,
    principal_pubkey: r.principal_pubkey,
    stacks: JSON.parse(r.stacks),
    capabilities: JSON.parse(r.capabilities),
    updated_at: r.updated_at,
  }));
}

beforeEach(() => {
  db = new Database(":memory:");
  applyThrough0008();
});

describe("migration 0009 — backfill ADMITTED rows from capability membership", () => {
  test("grandfathers a capability-networks[] member; a non-member is excluded", () => {
    // jc is a roster member of net-a (and net-b) via its announced caps.
    insertPrincipal("jc", "pk-jc", [
      { id: "tasks.review", networks: ["net-a", "net-b"] },
      { id: "tasks.deploy", networks: ["net-a"] },
      { id: "tasks.noop" }, // no networks key — contributes no admission row
    ]);
    // andreas announces a cap with an EMPTY networks[] → member of NO network.
    insertPrincipal("andreas", "pk-an", [{ id: "chat", networks: [] }]);
    // bob targets a DIFFERENT network only.
    insertPrincipal("bob", "pk-bob", [{ id: "chat", networks: ["other-net"] }]);

    runBackfill();

    const rows = admissionRows();
    // jc → one ADMITTED row per targeted network; andreas → none; bob → other-net only.
    const jcRows = rows.filter((r) => r.principal_id === "jc");
    expect(jcRows.map((r) => r.network_id).sort()).toEqual(["net-a", "net-b"]);
    for (const r of jcRows) {
      expect(r.status).toBe("ADMITTED");
      expect(r.peer_pubkey).toBe("pk-jc"); // peer_pubkey = principal pubkey
      expect(r.requested_scope).toBe("federated.jc.>");
      expect(r.granted_by).toBe("backfill:0009-grandfather"); // system marker, not admin
    }
    expect(rows.some((r) => r.principal_id === "andreas")).toBe(false);

    // The cutover behaviour: rosterFromAdmissions over the backfilled rows
    // reproduces the capability-derived membership exactly.
    const admitted = admissionRows();
    const principals = principalRecords();
    const rosterA = rosterFromAdmissions(admitted, principals, "net-a");
    expect(rosterA.members.map((m) => m.principal_id)).toEqual(["jc"]);
    // SECURITY: a non-member (andreas) never enters the roster — no new access.
    expect(rosterA.members.some((m) => m.principal_id === "andreas")).toBe(false);
    // bob (other-net only) is NOT in net-a, but IS in other-net.
    expect(rosterA.members.some((m) => m.principal_id === "bob")).toBe(false);
    expect(
      rosterFromAdmissions(admitted, principals, "other-net").members.map((m) => m.principal_id),
    ).toEqual(["bob"]);

    // The capability FACET is carried through onto the admitted member.
    expect(rosterA.members[0]?.capabilities.sort()).toEqual(["tasks.deploy", "tasks.review"]);
  });

  test("idempotent — re-running the backfill inserts no duplicate rows", () => {
    insertPrincipal("jc", "pk-jc", [{ id: "tasks.review", networks: ["net-a"] }]);
    runBackfill();
    const first = admissionRows().length;
    expect(first).toBe(1);
    runBackfill();
    expect(admissionRows().length).toBe(first);
  });

  test("does not duplicate a pre-existing ADMITTED row for the same triple", () => {
    insertPrincipal("jc", "pk-jc", [{ id: "tasks.review", networks: ["net-a"] }]);
    // A real admission already exists for (jc, pk-jc, net-a).
    db.run(
      `INSERT INTO admission_requests
         (request_id, principal_id, peer_pubkey, requested_scope, network_id, status, created_at, updated_at, granted_by)
       VALUES ('real-id', 'jc', 'pk-jc', 'federated.jc.>', 'net-a', 'ADMITTED', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'admin-pubkey')`,
    );
    runBackfill();
    const rows = admissionRows().filter((r) => r.principal_id === "jc" && r.network_id === "net-a");
    expect(rows.length).toBe(1);
    expect(rows[0]?.request_id).toBe("real-id"); // the real row survives untouched
    expect(rows[0]?.granted_by).toBe("admin-pubkey");
  });
});
