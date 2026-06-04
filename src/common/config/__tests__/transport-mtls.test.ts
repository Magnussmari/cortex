/**
 * TC-4d / TC-4e (#627 Phase 4) — tests for the transport-mTLS options builder.
 *
 * Covers the DECIDED mode mapping + the secret/safety contract:
 *   - off → undefined (no tls block; plaintext, byte-identical to today).
 *   - on  → builds tls when cert/key load; degrades (warn, no throw) when not.
 *   - require → builds tls; FAILS CLOSED (throws) on missing/invalid material.
 *   - key file not chmod-600 → rejected (mirrors the nkey-seed loader gate).
 *   - cert/key/ca CONTENTS never appear in any stderr line (paths + fingerprint
 *     only).
 *   - the federated-leaf-without-TLS advisory fires (stderr + structured sink).
 *
 * Throwaway cert/key/ca material is written to a per-test temp dir. The builder
 * reads bytes and threads them into the tls object — it does NOT parse PEM — so
 * deterministic dummy material exercises every branch without standing up a
 * real TLS server or generating real X.509 chains.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildNatsTlsOptions,
  buildHttpsMtlsMaterial,
  warnFederatedCleartext,
  type MtlsPaths,
} from "../transport-mtls";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cortex-transport-mtls-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Distinctive throwaway contents so a leak into a log line is detectable. */
const CERT_PEM = "-----BEGIN CERTIFICATE-----\nTESTCERTBYTES-DEADBEEF\n-----END CERTIFICATE-----\n";
const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nTESTKEYBYTES-S3CR3T-DO-NOT-LOG\n-----END PRIVATE KEY-----\n";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nTESTCABYTES-CAFEBABE\n-----END CERTIFICATE-----\n";

/** Write cert+key (+optional CA) at the given key mode; return the paths. */
function writeCertMaterial(keyMode: number, withCa = true): MtlsPaths {
  const certPath = join(testDir, "client.crt");
  const keyPath = join(testDir, "client.key");
  writeFileSync(certPath, CERT_PEM);
  writeFileSync(keyPath, KEY_PEM);
  chmodSync(keyPath, keyMode);
  if (withCa) {
    const caPath = join(testDir, "ca.crt");
    writeFileSync(caPath, CA_PEM);
    chmodSync(caPath, 0o644); // CA is public material — any mode is fine.
    return { cert_path: certPath, key_path: keyPath, ca_path: caPath };
  }
  return { cert_path: certPath, key_path: keyPath };
}

/** Capture every `process.stderr.write` during `fn` and return the joined text. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

describe("buildNatsTlsOptions", () => {
  test("off → undefined (no tls block; plaintext back-compat)", () => {
    const paths = writeCertMaterial(0o600);
    const out = captureStderr(() => {
      const tls = buildNatsTlsOptions("off", paths, { site: "primary link" });
      expect(tls).toBeUndefined();
    });
    // off must be silent + emit nothing — byte-identical to today.
    expect(out).toBe("");
  });

  test("off with NO paths → undefined (the zero-config default)", () => {
    const tls = buildNatsTlsOptions("off", undefined, { site: "primary link" });
    expect(tls).toBeUndefined();
  });

  test("on → builds tls (cert/key/ca contents) when material loads", () => {
    const paths = writeCertMaterial(0o600);
    const tls = buildNatsTlsOptions("on", paths, { site: "primary link" });
    expect(tls).toBeDefined();
    expect(tls?.cert).toBe(CERT_PEM);
    expect(tls?.key).toBe(KEY_PEM);
    expect(tls?.ca).toBe(CA_PEM);
  });

  test("on without a CA → builds tls, omits ca (system trust store)", () => {
    const paths = writeCertMaterial(0o600, /* withCa */ false);
    const tls = buildNatsTlsOptions("on", paths, { site: "primary link" });
    expect(tls).toBeDefined();
    expect(tls?.cert).toBe(CERT_PEM);
    expect(tls).not.toHaveProperty("ca");
  });

  test("NEVER emits rejectUnauthorized / skip-verify (no-weaken hard line)", () => {
    const paths = writeCertMaterial(0o600);
    const tls = buildNatsTlsOptions("require", paths, { site: "primary link" });
    expect(tls).toBeDefined();
    // The tls object must carry ONLY cert/key/ca — no insecure escape hatch.
    expect(tls).not.toHaveProperty("rejectUnauthorized");
    expect(JSON.stringify(tls)).not.toContain("rejectUnauthorized");
    expect(JSON.stringify(tls)).not.toContain("insecure");
  });

  test("on with NO cert paths → undefined (degrade to plaintext) + warns", () => {
    const out = captureStderr(() => {
      const tls = buildNatsTlsOptions("on", undefined, { site: "primary link" });
      expect(tls).toBeUndefined();
    });
    expect(out).toMatch(/WARNING/);
    expect(out).toMatch(/cert_path, key_path/);
  });

  test("require with NO cert paths → FAILS CLOSED (throws, no plaintext)", () => {
    expect(() =>
      buildNatsTlsOptions("require", undefined, { site: "primary link" }),
    ).toThrow(/require.*missing.*refusing to connect/s);
  });

  test("require with a missing cert FILE → FAILS CLOSED (throws)", () => {
    const paths: MtlsPaths = {
      cert_path: join(testDir, "nope.crt"),
      key_path: join(testDir, "nope.key"),
    };
    expect(() =>
      buildNatsTlsOptions("require", paths, { site: "primary link" }),
    ).toThrow(/require.*failed to load|ENOENT|no such file/s);
  });

  test("require + key NOT chmod-600 → rejected (mirrors nkey-seed gate)", () => {
    const paths = writeCertMaterial(0o644);
    expect(() =>
      buildNatsTlsOptions("require", paths, { site: "primary link" }),
    ).toThrow(/chmod 600/);
  });

  test("on + key NOT chmod-600 → degrades to plaintext (warns, no throw)", () => {
    const paths = writeCertMaterial(0o644);
    const out = captureStderr(() => {
      const tls = buildNatsTlsOptions("on", paths, { site: "primary link" });
      expect(tls).toBeUndefined();
    });
    expect(out).toMatch(/WARNING/);
    expect(out).toMatch(/chmod 600/);
  });

  test("NEVER logs cert/key/ca CONTENTS — only paths + a fingerprint", () => {
    const paths = writeCertMaterial(0o600);
    const out = captureStderr(() => {
      buildNatsTlsOptions("require", paths, { site: "primary link" });
    });
    // The private-key bytes and the distinctive cert/CA bytes must not leak.
    expect(out).not.toContain("TESTKEYBYTES-S3CR3T-DO-NOT-LOG");
    expect(out).not.toContain("TESTCERTBYTES-DEADBEEF");
    expect(out).not.toContain("TESTCABYTES-CAFEBABE");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    // But it DOES carry a fingerprint for audit/join.
    expect(out).toMatch(/fingerprint sha256:[0-9a-f]{16}/);
  });
});

describe("buildHttpsMtlsMaterial (cloud-publisher leg)", () => {
  test("off → undefined (ordinary server-auth HTTPS, back-compat)", () => {
    const paths = writeCertMaterial(0o600);
    const mat = buildHttpsMtlsMaterial("off", paths, { site: "cloud-publisher" });
    expect(mat).toBeUndefined();
  });

  test("on → cert/key/ca material when it loads", () => {
    const paths = writeCertMaterial(0o600);
    const mat = buildHttpsMtlsMaterial("on", paths, { site: "cloud-publisher" });
    expect(mat).toEqual({ cert: CERT_PEM, key: KEY_PEM, ca: CA_PEM });
  });

  test("require with missing material → FAILS CLOSED (throws)", () => {
    expect(() =>
      buildHttpsMtlsMaterial("require", undefined, { site: "cloud-publisher" }),
    ).toThrow(/require.*missing.*refusing to send/s);
  });

  test("require + key not chmod-600 → rejected", () => {
    const paths = writeCertMaterial(0o644);
    expect(() =>
      buildHttpsMtlsMaterial("require", paths, { site: "cloud-publisher" }),
    ).toThrow(/chmod 600/);
  });

  test("never carries a skip-verify field", () => {
    const paths = writeCertMaterial(0o600);
    const mat = buildHttpsMtlsMaterial("require", paths, { site: "cloud-publisher" });
    expect(JSON.stringify(mat)).not.toContain("rejectUnauthorized");
    expect(JSON.stringify(mat)).not.toContain("insecure");
  });
});

describe("warnFederatedCleartext", () => {
  test("emits a loud stderr advisory AND invokes the structured sink", () => {
    const seen: { leafId: string; networkId: string; safeUrl: string }[] = [];
    const out = captureStderr(() => {
      warnFederatedCleartext(
        { leafId: "peer-leaf", networkId: "mf-prod", safeUrl: "nats://peer.example:4222" },
        (info) => seen.push(info),
      );
    });
    expect(out).toMatch(/WARNING/);
    expect(out).toMatch(/federated leaf "peer-leaf"/);
    expect(out).toMatch(/network=mf-prod/);
    expect(out).toMatch(/WITHOUT TLS/);
    expect(out).toMatch(/CLEARTEXT/);
    // Structured sink received the same payload (audit-envelope promotion seam).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      leafId: "peer-leaf",
      networkId: "mf-prod",
      safeUrl: "nats://peer.example:4222",
    });
  });

  test("stderr-only path works with no sink (default)", () => {
    const out = captureStderr(() => {
      warnFederatedCleartext({
        leafId: "leaf-x",
        networkId: "net-y",
        safeUrl: "nats://x:4222",
      });
    });
    expect(out).toMatch(/WARNING.*federated leaf "leaf-x"/s);
  });
});
