/**
 * G-1113.B.4 — provider badge metadata + Sources view state (pure helpers).
 */
import { test, expect } from "bun:test";
import { providerMeta } from "../components/provider-badge";
import { sourceState, ACTIVE_PROVIDERS } from "../components/sources-view";
import { PROVIDERS } from "../../types";

test("providerMeta is total over the Provider union with non-empty labels", () => {
  for (const p of PROVIDERS) {
    const meta = providerMeta(p);
    expect(typeof meta.label).toBe("string");
    expect(meta.label.length).toBeGreaterThan(0);
  }
});

test("github + internal render as active; the rest as available", () => {
  expect(sourceState("github")).toBe("active");
  expect(sourceState("internal")).toBe("active");
  for (const p of PROVIDERS) {
    const expected = p === "github" || p === "internal" ? "active" : "available";
    expect(sourceState(p)).toBe(expected);
  }
});

test("ACTIVE_PROVIDERS matches the tasks.source_system CHECK (github, internal)", () => {
  expect([...ACTIVE_PROVIDERS].sort()).toEqual(["github", "internal"]);
});
