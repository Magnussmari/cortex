/**
 * TC-0 (Trust & Confidentiality, #628) — security-posture resolver +
 * schema-default assertions.
 *
 * Two concerns pinned here:
 *
 *  1. **Schema defaults** — `security` absent parses to all-off; a partial
 *     override (`{ signing: "permissive" }`) fills the remaining toggles with
 *     their defaults (the `emptyDefault()` + transform idiom on
 *     `AgentConfigSchema.security`).
 *
 *  2. **Resolver mapping** — `resolveSigningKnobs` implements the DECIDED
 *     `off → permissive → enforce` mapping verbatim (the table in
 *     `src/common/security-posture.ts`). This is a security decision; the
 *     test is the contract.
 *
 * The boot-site behaviour (signer attach / non-rejecting verify) is pinned
 * separately in `src/__tests__/cortex.security-posture-boot.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { AgentConfigSchema } from "../types/config";
import { resolveSigningKnobs } from "../security-posture";

// ---------------------------------------------------------------------------
// Helper — minimal valid AgentConfig with an overridable `security` block.
// ---------------------------------------------------------------------------

function parseWith(security?: unknown) {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-test-published" },
    ...(security !== undefined && { security }),
  });
}

// ---------------------------------------------------------------------------
// 1. Schema defaults
// ---------------------------------------------------------------------------

describe("AgentConfigSchema.security — defaults", () => {
  test("security absent → all toggles default off", () => {
    const cfg = parseWith();
    expect(cfg.security).toEqual({
      signing: "off",
      encryption: { payload: "off", at_rest: "off" },
      transport: { mtls: "off" },
    });
  });

  test("partial override { signing: permissive } → fills the rest with defaults", () => {
    const cfg = parseWith({ signing: "permissive" });
    expect(cfg.security).toEqual({
      signing: "permissive",
      encryption: { payload: "off", at_rest: "off" },
      transport: { mtls: "off" },
    });
  });

  test("partial nested override { encryption: { payload: require } } → siblings keep defaults", () => {
    const cfg = parseWith({ encryption: { payload: "require" } });
    expect(cfg.security).toEqual({
      signing: "off",
      encryption: { payload: "require", at_rest: "off" },
      transport: { mtls: "off" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Resolver mapping
// ---------------------------------------------------------------------------

describe("resolveSigningKnobs — DECIDED mapping", () => {
  test("off → no signer, cheap verify, never reject, fallback publish", () => {
    expect(resolveSigningKnobs("off")).toEqual({
      attachSigner: false,
      cryptoVerify: true,
      rejectEmpty: false,
      signFailureMode: "fallback",
    });
  });

  test("permissive → attach signer (if seed), verify, never reject, fallback publish", () => {
    expect(resolveSigningKnobs("permissive")).toEqual({
      attachSigner: true,
      cryptoVerify: true,
      rejectEmpty: false,
      signFailureMode: "fallback",
    });
  });

  test("enforce → attach signer, verify, REJECT unsigned, drop on sign failure", () => {
    expect(resolveSigningKnobs("enforce")).toEqual({
      attachSigner: true,
      cryptoVerify: true,
      rejectEmpty: true,
      signFailureMode: "drop",
    });
  });

  test("off and permissive are both non-rejecting (the backward-compat-safe postures)", () => {
    expect(resolveSigningKnobs("off").rejectEmpty).toBe(false);
    expect(resolveSigningKnobs("permissive").rejectEmpty).toBe(false);
    // enforce is the ONLY posture that rejects.
    expect(resolveSigningKnobs("enforce").rejectEmpty).toBe(true);
  });
});
