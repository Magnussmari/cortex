/**
 * ADR-0018 PR5b — leaf PSK minting tests.
 */

import { describe, test, expect } from "bun:test";
import { mintLeafPsk, pskFingerprint } from "../leaf-psk";

describe("mintLeafPsk", () => {
  test("mints a high-entropy base64url PSK (URL/HOCON-safe charset)", () => {
    const psk = mintLeafPsk();
    // 32 bytes → 43 base64url chars (no padding).
    expect(psk.length).toBe(43);
    expect(psk).toMatch(/^[A-Za-z0-9_-]+$/); // no +, /, =, @, : — safe in URL userinfo + HOCON
  });

  test("is unique across mints (CSPRNG)", () => {
    const set = new Set(Array.from({ length: 100 }, () => mintLeafPsk()));
    expect(set.size).toBe(100);
  });
});

describe("pskFingerprint", () => {
  test("is short, stable, and not the secret itself", async () => {
    const psk = mintLeafPsk();
    const fp = await pskFingerprint(psk);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).not.toBe(psk);
    expect(await pskFingerprint(psk)).toBe(fp); // stable
  });
});
