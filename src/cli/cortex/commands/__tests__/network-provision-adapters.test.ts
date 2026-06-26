/**
 * G1d / T1 (cortex#1139) — LIVE signing-identity adapter tests.
 *
 * Regression cover for cortex#1236 BLOCKER: the live adapter must expand the
 * portable `~` seed path at the fs boundary so the O_EXCL write and the
 * existence probe target the SAME `$HOME`-rooted path. The CLI tests inject a
 * fake signing port, so this is the only test that exercises the real adapter
 * with a tilde path. HOME is pinned to a tmpdir; the signing port is NOT mocked.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildSigningIdentityAdapter } from "../network-provision-adapters";

describe("buildSigningIdentityAdapter — live, tilde expansion (cortex#1236)", () => {
  let home: string;
  let prevHome: string | undefined;
  const RAW_SEED = "~/.config/nats/andreas-research.seed";

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cortex-provision-home-"));
    process.env.HOME = home;
    // generateStackIdentity writes the seed but does NOT mkdir -p; the real
    // arc-provisioned tree already has ~/.config/nats — mirror that here.
    mkdirSync(join(home, ".config", "nats"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("generate writes the seed under $HOME, NOT a literal ~ dir", () => {
    const adapter = buildSigningIdentityAdapter();
    const res = adapter.generate({ seedPath: RAW_SEED, force: false });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.nkeyPub).toMatch(/^U/);
      expect(res.fingerprint.length).toBeGreaterThan(0);
    }

    // The seed landed at the EXPANDED path…
    const expanded = join(home, ".config", "nats", "andreas-research.seed");
    expect(existsSync(expanded)).toBe(true);
    // …and NOT in a literal "~" directory under cwd (the bug).
    expect(existsSync(join(process.cwd(), "~"))).toBe(false);
  });

  test("exists agrees with generate on the expanded path (idempotent re-run, no EEXIST)", () => {
    const adapter = buildSigningIdentityAdapter();

    // Before generate: the probe sees nothing.
    expect(adapter.exists(RAW_SEED)).toBe(false);

    const first = adapter.generate({ seedPath: RAW_SEED, force: false });
    expect(first.ok).toBe(true);

    // After generate: the probe (expanded) sees the file the write (expanded)
    // produced. Because they agree, the orchestrator's `signingNeeded =
    // !signingSeedExists` short-circuits on a re-run → generate is never called
    // again → no O_EXCL EEXIST. The divergence this asserts against is the
    // cortex#1236 bug (probe expanded, write literal `~`).
    expect(adapter.exists(RAW_SEED)).toBe(true);
  });
});
