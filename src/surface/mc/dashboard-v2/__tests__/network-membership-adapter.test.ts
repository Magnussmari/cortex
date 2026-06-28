/**
 * MC-A1 (cortex#1275) — unit tests for the pure networks roster presentation
 * adapter (verdict → badge, roster_status → chip, member tally). DOM-free.
 */

import { describe, it, expect } from "bun:test";
import {
  confidentialityBadge,
  verdictBadge,
  rosterStatusBadge,
  summarizeMembership,
} from "../lib/network-membership-adapter";
import type { NetworkConfidentialityDTO } from "../../api/networks";

describe("verdictBadge", () => {
  it("maps each verdict to a distinct tone", () => {
    expect(verdictBadge("admitted-present").tone).toBe("ok");
    expect(verdictBadge("admitted-absent").tone).toBe("warn");
    expect(verdictBadge("present-but-unadmitted").tone).toBe("danger");
    expect(verdictBadge("pending").tone).toBe("pending");
  });

  it("gives every verdict a non-empty label + title", () => {
    for (const v of [
      "admitted-present",
      "admitted-absent",
      "present-but-unadmitted",
      "pending",
    ] as const) {
      const b = verdictBadge(v);
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.title.length).toBeGreaterThan(0);
    }
  });
});

describe("rosterStatusBadge", () => {
  it("distinguishes complete vs self-only authoritative reads", () => {
    expect(rosterStatusBadge("ok", "complete").tone).toBe("ok");
    expect(rosterStatusBadge("ok", "self").tone).toBe("warn");
    expect(rosterStatusBadge("ok", "self").label).toContain("self");
  });

  it("surfaces degraded reads honestly", () => {
    expect(rosterStatusBadge("unreachable", null).tone).toBe("warn");
    expect(rosterStatusBadge("not_configured", null).label).toContain("pending");
    expect(rosterStatusBadge("unauthorized", null).label).toContain("authorized");
  });
});

describe("confidentialityBadge (MC-A3, ADR-0019/0018)", () => {
  const c = (over: Partial<NetworkConfidentialityDTO>): NetworkConfidentialityDTO => ({
    mode: "off",
    key_present: false,
    key_id: null,
    ...over,
  });

  it("enabled + key held ⇒ encrypted (ok)", () => {
    const b = confidentialityBadge(c({ mode: "enabled", key_present: true, key_id: "n/k1" }));
    expect(b.posture).toBe("encrypted");
    expect(b.tone).toBe("ok");
    expect(b.label).toBe("encrypted");
    expect(b.title).toContain("n/k1");
  });

  it("required + key held ⇒ encrypted-required (ok), rejects cleartext inbound", () => {
    const b = confidentialityBadge(c({ mode: "required", key_present: true, key_id: "n/k1" }));
    expect(b.posture).toBe("encrypted-required");
    expect(b.tone).toBe("ok");
    expect(b.label).toContain("required");
    expect(b.title).toContain("REJECTED");
  });

  it("off ⇒ cleartext (warn)", () => {
    const b = confidentialityBadge(c({ mode: "off" }));
    expect(b.posture).toBe("cleartext");
    expect(b.tone).toBe("warn");
  });

  it("HONESTY HINGE: enabled but NO key ⇒ degraded (danger), never 'encrypted'", () => {
    const b = confidentialityBadge(c({ mode: "enabled", key_present: false }));
    expect(b.posture).toBe("degraded");
    expect(b.tone).toBe("danger");
    expect(b.label).not.toContain("encrypted");
    expect(b.title).toContain("CLEARTEXT");
  });

  it("HONESTY HINGE: required but NO key ⇒ degraded (danger)", () => {
    const b = confidentialityBadge(c({ mode: "required", key_present: false }));
    expect(b.posture).toBe("degraded");
    expect(b.tone).toBe("danger");
  });

  it("absent posture ⇒ unknown (warn), never assumed encrypted", () => {
    const b = confidentialityBadge(undefined);
    expect(b.posture).toBe("unknown");
    expect(b.tone).toBe("warn");
    expect(b.label).not.toContain("encrypted");
  });

  it("an unrecognized mode degrades to unknown at runtime, never 'encrypted'", () => {
    // Defensive: a server sending a mode outside the union (forward-compat / bug)
    // must hit the exhaustiveness default's runtime fallback, not over-claim.
    const bogus = { mode: "weird", key_present: true, key_id: "n/k1" } as unknown as
      NetworkConfidentialityDTO;
    const b = confidentialityBadge(bogus);
    expect(b.posture).toBe("unknown");
    expect(b.label).not.toContain("encrypted");
  });

  it("every posture has a non-empty label + title", () => {
    const cases: (NetworkConfidentialityDTO | undefined)[] = [
      c({ mode: "off" }),
      c({ mode: "enabled", key_present: true }),
      c({ mode: "required", key_present: true }),
      c({ mode: "enabled", key_present: false }),
      undefined,
    ];
    for (const tc of cases) {
      const b = confidentialityBadge(tc);
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.title.length).toBeGreaterThan(0);
    }
  });
});

describe("summarizeMembership", () => {
  it("tallies members by verdict", () => {
    const summary = summarizeMembership({
      members: [
        { principal: "a", verdict: "admitted-present", present_stacks: ["s"] },
        { principal: "b", verdict: "admitted-absent", present_stacks: [] },
        { principal: "c", verdict: "admitted-present", present_stacks: ["s"] },
        { principal: "d", verdict: "present-but-unadmitted", present_stacks: ["x"] },
        { principal: "e", verdict: "pending", present_stacks: [] },
      ],
    });
    expect(summary).toEqual({
      present: 2,
      absent: 1,
      unadmitted: 1,
      pending: 1,
      total: 5,
    });
  });

  it("handles an empty member set", () => {
    expect(summarizeMembership({ members: [] })).toEqual({
      present: 0,
      absent: 0,
      unadmitted: 0,
      pending: 0,
      total: 0,
    });
  });
});
