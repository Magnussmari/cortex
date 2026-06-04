/**
 * TC-1b (#632) — `cortex provision-stack` CLI tests.
 *
 * Coverage:
 *   1. generate writes a seed (mode 600) + prints pubkey, NOT the seed.
 *   2. generate --json envelope carries pubkey + fingerprint, no seed.
 *   3. generate refuses to clobber without --force (exit 1); --force succeeds.
 *   4. generate rejects a bad principal-id (exit 2).
 *   5. claim prints a signed body for an existing seed (no network).
 *   6. register POSTs the proof-of-possession claim through an injected
 *      registry route and reports success; a rejecting route → exit 1.
 *   7. no seed material in stdout/stderr on any path.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchProvisionStack } from "../provision-stack";

// Real registry route for the register round-trip.
import registryApp from "../../../../services/network-registry/src/index";
import type { Env } from "../../../../services/network-registry/src/index";
import {
  makeRegistryKey,
  resetStores,
} from "../../../../services/network-registry/__tests__/helpers";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tc1b-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  resetStores();
});

/** Read the seed off disk so we can assert it never appears in CLI output. */
function seedOnDisk(path: string): string {
  return readFileSync(path, "utf-8").trim();
}

describe("cortex provision-stack generate (TC-1b #632)", () => {
  test("[1] writes seed chmod 600, prints pubkey (not the seed)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
    ]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(seedPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(seedPath).mode & 0o777).toBe(0o600);
    }
    // stdout shows the NKey pub + the cortex.yaml block.
    expect(res.stdout).toContain("nkey_pub:");
    expect(res.stdout).toContain("andreas/default");
    // SECRET: the seed must NOT be in any output.
    const seed = seedOnDisk(seedPath);
    expect(res.stdout).not.toContain(seed);
    expect(res.stderr).not.toContain(seed);
  });

  test("[2] --json envelope carries pubkey + fingerprint, no seed", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      status: string;
      data: Record<string, string>;
    };
    expect(env.status).toBe("ok");
    expect(env.data.nkey_pub).toMatch(/^U/);
    const pub = env.data.pubkey_b64 ?? "";
    expect(pub.length).toBe(44);
    expect(env.data.fingerprint).toBe(pub.slice(0, 12));
    expect(env.data.seed_mode).toBe("600");
    // No seed field anywhere in the envelope.
    expect(JSON.stringify(env)).not.toContain(seedOnDisk(seedPath));
  });

  test("[3] refuses to clobber without --force (exit 1); --force succeeds", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const first = seedOnDisk(seedPath);

    const refuse = await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    expect(refuse.exitCode).toBe(1);
    expect(refuse.stderr).toMatch(/refusing to overwrite/i);
    expect(seedOnDisk(seedPath)).toBe(first); // unchanged

    const forced = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
      "--force",
    ]);
    expect(forced.exitCode).toBe(0);
    expect(seedOnDisk(seedPath)).not.toBe(first); // rotated
  });

  test("[4] rejects a bad principal-id (exit 2)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "BAD_CAPS",
      "--seed-path",
      seedPath,
    ]);
    expect(res.exitCode).toBe(2);
    expect(existsSync(seedPath)).toBe(false);
  });

  test("[4b] rejects --stack-id whose prefix mismatches principal (exit 2)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
      "--stack-id",
      "someoneelse/research",
    ]);
    expect(res.exitCode).toBe(2);
  });
});

describe("cortex provision-stack claim (TC-1b #632)", () => {
  test("[5] prints a signed body for an existing seed (no network)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    const res = await dispatchProvisionStack(["claim", "andreas", "--seed-path", seedPath]);
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(res.stdout) as {
      claim: { principal_id: string; principal_pubkey: string; stacks: { stack_id: string }[] };
      signature: string;
    };
    expect(body.claim.principal_id).toBe("andreas");
    expect(body.claim.stacks[0]!.stack_id).toBe("andreas/default");
    expect(body.signature.length).toBeGreaterThan(0);
    // The printed body is public — but the raw seed must still not appear.
    expect(res.stdout).not.toContain(seedOnDisk(seedPath));
  });
});

describe("cortex provision-stack register (TC-1b #632)", () => {
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    return {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
  }

  test("[6] register POSTs proof-of-possession and reports success", async () => {
    const env = await configuredEnv();
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    // Patch global fetch to route to the in-memory registry app.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seedPath,
        "--registry-url",
        "http://registry.test",
        "--json",
      ]);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
      expect(out.status).toBe("ok");
      expect(out.data.registered).toContain("HTTP 201");
      expect(res.stdout).not.toContain(seedOnDisk(seedPath));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("[6b] register surfaces a registry rejection as exit 1", async () => {
    // Unconfigured registry → 503 registry_unconfigured.
    const env: Env = { ENVIRONMENT: "test" };
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seedPath,
        "--registry-url",
        "http://registry.test",
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(/registry rejected/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
