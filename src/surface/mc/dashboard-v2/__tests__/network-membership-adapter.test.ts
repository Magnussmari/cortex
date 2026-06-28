/**
 * MC-A1 (cortex#1275) — unit tests for the pure networks roster presentation
 * adapter (verdict → badge, roster_status → chip, member tally). DOM-free.
 */

import { describe, it, expect } from "bun:test";
import {
  verdictBadge,
  rosterStatusBadge,
  summarizeMembership,
} from "../lib/network-membership-adapter";

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
