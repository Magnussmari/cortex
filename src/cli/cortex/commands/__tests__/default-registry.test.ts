/**
 * cortex#1228 (PR3.5) — tests for the baked-in default registry trust anchor
 * and the {@link resolveRegistryAnchor} precedence chokepoint.
 */

import { describe, test, expect } from "bun:test";

import {
  DEFAULT_REGISTRY,
  isDefaultRegistryUrl,
  resolveRegistryAnchor,
  type RegistryAnchor,
} from "../default-registry";

// =============================================================================
// The compiled-in anchor
// =============================================================================

describe("DEFAULT_REGISTRY anchor", () => {
  test("host is the canonical network.meta-factory.ai (serves /registry/pubkey)", () => {
    expect(DEFAULT_REGISTRY.url).toBe("https://network.meta-factory.ai");
    // Must NOT be the stale `registry.` host (doesn't resolve).
    expect(DEFAULT_REGISTRY.url).not.toContain("registry.meta-factory.ai");
  });

  test("pubkey is the VERIFIED live anchor (base64 Ed25519, 44 chars incl '=')", () => {
    // Verified 2026-06-27 against GET https://network.meta-factory.ai/registry/pubkey.
    expect(DEFAULT_REGISTRY.pubkey).toBe(
      "ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk=",
    );
    expect(DEFAULT_REGISTRY.pubkey).toHaveLength(44);
    expect(DEFAULT_REGISTRY.pubkey.endsWith("=")).toBe(true);
    // Non-empty ⇒ the default is genuinely pinned (no accidental TOFU fallback).
    expect(DEFAULT_REGISTRY.pubkey).not.toBe("");
  });

  test("no rotation in progress (next undefined) in steady state", () => {
    expect(DEFAULT_REGISTRY.next).toBeUndefined();
  });
});

// =============================================================================
// isDefaultRegistryUrl
// =============================================================================

describe("isDefaultRegistryUrl", () => {
  test("matches the anchor URL", () => {
    expect(isDefaultRegistryUrl("https://network.meta-factory.ai")).toBe(true);
  });
  test("trailing-slash insensitive", () => {
    expect(isDefaultRegistryUrl("https://network.meta-factory.ai/")).toBe(true);
    expect(isDefaultRegistryUrl("https://network.meta-factory.ai///")).toBe(true);
  });
  test("a custom URL is NOT the default", () => {
    expect(isDefaultRegistryUrl("https://registry.meta-factory.ai")).toBe(false);
    expect(isDefaultRegistryUrl("https://r.test")).toBe(false);
  });
  test("undefined / empty is NOT the default", () => {
    expect(isDefaultRegistryUrl(undefined)).toBe(false);
    expect(isDefaultRegistryUrl("")).toBe(false);
  });
});

// =============================================================================
// resolveRegistryAnchor — the precedence chokepoint
// =============================================================================

describe("resolveRegistryAnchor — default fallback (the headline)", () => {
  test("NOTHING configured → falls back to the default anchor, PINNED, no TOFU", () => {
    const r = resolveRegistryAnchor({});
    expect(r.url).toBe(DEFAULT_REGISTRY.url);
    expect(r.pubkey).toBe(DEFAULT_REGISTRY.pubkey);
    expect(r.tofu).toBe(false);
    expect(r.trust).toBe("default-pinned");
  });

  test("default URL configured but NO pubkey → still pinned to the baked key (no TOFU)", () => {
    const r = resolveRegistryAnchor({ configUrl: "https://network.meta-factory.ai" });
    expect(r.pubkey).toBe(DEFAULT_REGISTRY.pubkey);
    expect(r.tofu).toBe(false);
    expect(r.trust).toBe("default-pinned");
  });

  test("default URL with trailing slash + no pubkey → still default-pinned", () => {
    const r = resolveRegistryAnchor({ configUrl: "https://network.meta-factory.ai/" });
    expect(r.pubkey).toBe(DEFAULT_REGISTRY.pubkey);
    expect(r.trust).toBe("default-pinned");
  });
});

describe("resolveRegistryAnchor — explicit pins win", () => {
  test("flag pubkey wins over everything", () => {
    const r = resolveRegistryAnchor({
      flagUrl: "https://custom.test",
      flagPubkey: "Z".repeat(43) + "=",
      configUrl: "https://network.meta-factory.ai",
      configPubkey: "Y".repeat(43) + "=",
    });
    expect(r.url).toBe("https://custom.test");
    expect(r.pubkey).toBe("Z".repeat(43) + "=");
    expect(r.tofu).toBe(false);
    expect(r.trust).toBe("flag-pinned");
  });

  test("config pubkey pins when no flag", () => {
    const r = resolveRegistryAnchor({
      configUrl: "https://custom.test",
      configPubkey: "Y".repeat(43) + "=",
    });
    expect(r.pubkey).toBe("Y".repeat(43) + "=");
    expect(r.tofu).toBe(false);
    expect(r.trust).toBe("config-pinned");
  });

  test("an explicit pin on the DEFAULT url is honoured as config/flag-pinned", () => {
    const r = resolveRegistryAnchor({
      configUrl: "https://network.meta-factory.ai",
      configPubkey: "Y".repeat(43) + "=",
    });
    expect(r.pubkey).toBe("Y".repeat(43) + "=");
    expect(r.trust).toBe("config-pinned");
  });
});

describe("resolveRegistryAnchor — custom registry TOFU (gated)", () => {
  test("custom URL, NO pubkey → TOFU (caller must warn)", () => {
    const r = resolveRegistryAnchor({ configUrl: "https://custom.test" });
    expect(r.url).toBe("https://custom.test");
    expect(r.pubkey).toBeUndefined();
    expect(r.tofu).toBe(true);
    expect(r.trust).toBe("tofu");
  });

  test("flag URL (custom), NO pubkey → TOFU", () => {
    const r = resolveRegistryAnchor({ flagUrl: "https://flag.custom" });
    expect(r.tofu).toBe(true);
    expect(r.trust).toBe("tofu");
  });
});

describe("resolveRegistryAnchor — secure-by-default when the anchor is UNPINNED", () => {
  // The escape hatch (if we ever ship without a verified pubkey): an empty
  // anchor pubkey must NEVER be pinned — it must fall back to TOFU, not pin "".
  const unpinned: RegistryAnchor = { url: "https://network.meta-factory.ai", pubkey: "" };

  test("default URL + empty anchor pubkey → TOFU, NOT an empty pin", () => {
    const r = resolveRegistryAnchor({ configUrl: "https://network.meta-factory.ai", anchor: unpinned });
    expect(r.pubkey).toBeUndefined();
    expect(r.tofu).toBe(true);
    expect(r.trust).toBe("tofu");
  });

  test("nothing configured + empty anchor pubkey → default URL but TOFU", () => {
    const r = resolveRegistryAnchor({ anchor: unpinned });
    expect(r.url).toBe(unpinned.url);
    expect(r.pubkey).toBeUndefined();
    expect(r.tofu).toBe(true);
  });
});
