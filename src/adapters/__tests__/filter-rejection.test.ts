/**
 * cortex#1264 — tests for the deterministic content-filter rejection
 * message-builder (presentation layer).
 */
import { describe, test, expect } from "bun:test";
import { renderFilterRejection } from "../filter-rejection";
import type { FilterReasonCategory } from "../../runner/prompt-filter";

describe("renderFilterRejection (cortex#1264)", () => {
  test("encoded-content renders actionable, onboarding-aware guidance", () => {
    const text = renderFilterRejection("encoded-content");
    // Honest about WHY (encoded content can't be read / scanned for safety).
    expect(text).toContain("encoded content");
    expect(text).toContain("scanned for safety");
    // Actionable: register the pubkey with the CLI, then ask in plain text.
    expect(text).toContain("cortex provision-stack register");
    expect(text).toContain("plain text");
    expect(text.toLowerCase()).toContain("pubkey");
    expect(text.toLowerCase()).toContain("principal");
  });

  test("every category renders non-empty, distinct, honest text", () => {
    const categories: FilterReasonCategory[] = [
      "encoded-content",
      "injection-pattern",
      "exfiltration-pattern",
      "tool-invocation",
      "pii",
      "unspecified",
    ];
    const rendered = categories.map(renderFilterRejection);
    for (const text of rendered) {
      expect(text.length).toBeGreaterThan(0);
      // Keeps the block honest: it still says it can't process the message.
      expect(text.toLowerCase()).toContain("can't");
    }
    // Each category produces a distinct line — no collapsed copy.
    expect(new Set(rendered).size).toBe(categories.length);
  });

  test("pure + deterministic: same category in → same text out", () => {
    expect(renderFilterRejection("encoded-content")).toBe(
      renderFilterRejection("encoded-content"),
    );
    expect(renderFilterRejection("injection-pattern")).toBe(
      renderFilterRejection("injection-pattern"),
    );
  });

  test("does NOT leak the raw matched-pattern string (no opaque 'matched: base64')", () => {
    // The old reply was `I can't process that message. Content filter blocked
    // this message (matched: base64)`. The new copy must be guidance, not the
    // raw matched token.
    expect(renderFilterRejection("encoded-content")).not.toContain("matched:");
  });
});
