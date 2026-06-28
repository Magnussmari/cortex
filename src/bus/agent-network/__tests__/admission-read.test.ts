/**
 * MC-A1 (cortex#1275) — unit tests for the admission-rows read (ADR-0018 Q3
 * source of truth). Drives `resolveAdmittedRoster` over a fake
 * `AdmissionRowsProvider` — no transport, no registry, no crypto.
 *
 * The load-bearing property: membership comes from the admission STATUS
 * (ADMITTED / PENDING), filtered to the target network — never from capabilities,
 * and a SELF-scoped read is flagged non-authoritative so the caller suppresses
 * anomaly detection.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveAdmittedRoster,
  type AdmissionRow,
  type AdmissionRowsProvider,
  type AdmissionRowsResult,
} from "../admission-read";

function provider(result: AdmissionRowsResult): AdmissionRowsProvider {
  return { readAdmissionRows: () => Promise.resolve(result) };
}

function row(over: Partial<AdmissionRow> & { principal_id: string }): AdmissionRow {
  return { network_id: "research-collab", status: "ADMITTED", ...over };
}

describe("resolveAdmittedRoster", () => {
  it("projects ADMITTED rows → admitted[], PENDING rows → pending[]", async () => {
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({
        ok: true,
        scope: "complete",
        rows: [
          row({ principal_id: "jc", status: "ADMITTED" }),
          row({ principal_id: "newcomer", status: "PENDING" }),
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.roster.admitted).toEqual(["jc"]);
    expect(res.roster.pending).toEqual(["newcomer"]);
    expect(res.roster.authoritative).toBe(true);
  });

  it("drops REJECTED / REVOKED rows — they are not members", async () => {
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({
        ok: true,
        scope: "complete",
        rows: [
          row({ principal_id: "rejected", status: "REJECTED" }),
          row({ principal_id: "revoked", status: "REVOKED" }),
          row({ principal_id: "jc", status: "ADMITTED" }),
        ],
      }),
    );
    expect(res.ok && res.roster.admitted).toEqual(["jc"]);
    expect(res.ok && res.roster.pending).toEqual([]);
  });

  it("filters to the target network, dropping other-network + network-less rows", async () => {
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({
        ok: true,
        scope: "complete",
        rows: [
          row({ principal_id: "jc", network_id: "research-collab", status: "ADMITTED" }),
          row({ principal_id: "other", network_id: "ops-net", status: "ADMITTED" }),
          row({ principal_id: "registered-only", network_id: null, status: "ADMITTED" }),
        ],
      }),
    );
    expect(res.ok && res.roster.admitted).toEqual(["jc"]);
  });

  it("flags a SELF-scoped read non-authoritative (anomaly detection must be suppressed)", async () => {
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({
        ok: true,
        scope: "self",
        rows: [row({ principal_id: "andreas", status: "ADMITTED" })],
      }),
    );
    expect(res.ok && res.roster.authoritative).toBe(false);
    expect(res.ok && res.roster.admitted).toEqual(["andreas"]);
  });

  it("dedupes principals, preserving first-seen order", async () => {
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({
        ok: true,
        scope: "complete",
        rows: [
          row({ principal_id: "b", status: "ADMITTED" }),
          row({ principal_id: "a", status: "ADMITTED" }),
          row({ principal_id: "b", status: "ADMITTED" }),
        ],
      }),
    );
    expect(res.ok && res.roster.admitted).toEqual(["b", "a"]);
  });

  it("passes through a read failure verbatim (never throws)", async () => {
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({ ok: false, reason: "unreachable", detail: "registry down" }),
    );
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toBe("unreachable");
  });

  it("never treats capabilities as membership — there is no capability input at all", async () => {
    // Asserted by construction: AdmissionRow has no capability field, and the
    // projection keys solely on `status`. An ADMITTED row with no capabilities
    // is still a full member.
    const res = await resolveAdmittedRoster(
      "research-collab",
      provider({
        ok: true,
        scope: "complete",
        rows: [row({ principal_id: "silent-member", status: "ADMITTED" })],
      }),
    );
    expect(res.ok && res.roster.admitted).toEqual(["silent-member"]);
  });
});
