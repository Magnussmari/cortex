#!/usr/bin/env bun
/**
 * `generate-registry-keypair` — provision the network-registry's OWN signing
 * keypair (the `REGISTRY_SIGNING_KEY` Cloudflare Worker secret).
 *
 * Closes the headline provisioning gap flagged in `docs/sop-network-registry.md`:
 * principals were told to `wrangler secret put REGISTRY_SIGNING_KEY` and paste a
 * base64 key, but nothing in the repo MADE one. This is that tool.
 *
 * ## Why it lives HERE (in the registry service, not the cortex CLI)
 *
 * The registry signing key is the registry's OWN concern. By living inside
 * `src/services/network-registry/` this script imports `../src/signing.ts`
 * directly and reuses the EXACT functions the Worker runs — `generateKeypair`
 * (WebCrypto Ed25519) and, crucially, `pubkeyFromPkcs8` (the registry's own
 * pubkey-derivation path used by `ensurePublicKey` at boot). That makes the
 * correctness contract below a check against the registry's real code, not a
 * re-implementation. The alternative — a `cortex` CLI subcommand — would have
 * to reach across the root↔Worker bundle boundary (the registry is excluded
 * from the root tsconfig) and re-derive PKCS#8 handling, exactly the coupling
 * `stack-provisioning.ts` had to carry for the per-stack NKey case. The
 * registry key has no NKey bridge to justify that, so it belongs with the
 * Worker that consumes it.
 *
 * ## What it produces
 *
 *   1. A fresh Ed25519 keypair via WebCrypto.
 *   2. PRIVATE key exported as PKCS#8 → base64 — the `REGISTRY_SIGNING_KEY`
 *      secret value (`wrangler secret put`). This is the ONLY sensitive line
 *      of output; everything else is public.
 *   3. PUBLIC key exported as raw 32 bytes → base64 — what principals pin as
 *      `policy.federated.registry.pubkey` and (optionally) `REGISTRY_PUBLIC_KEY`.
 *   4. A short fingerprint (first 12 base64 chars of the raw pubkey) for
 *      log-safe reference.
 *
 * ## Correctness contract (load-bearing)
 *
 * Before emitting anything, the script asserts that
 * `pubkeyFromPkcs8(<emitted PKCS#8 base64>)` returns EXACTLY the raw-public
 * base64 it is about to print. If the generated key does not round-trip
 * through the registry's OWN derive path, the key is useless to the Worker —
 * so we refuse to emit it and exit non-zero. A test pins the same invariant
 * (`__tests__/generate-registry-keypair.test.ts`).
 *
 * ## Secrets discipline
 *
 * The PKCS#8 private key is printed to stdout exactly once, clearly labelled as
 * the secret, because the principal NEEDS it to paste into `wrangler secret put`.
 * It is NEVER written to a log sink, and (by default) NEVER written to a file.
 * With `--out <path>` the private key is written chmod 600 with an O_EXCL
 * create (refuses to clobber, refuses to follow a planted symlink) — mirroring
 * the seed-file discipline in `src/bus/stack-provisioning.ts` (TC-1b).
 *
 * ## Usage
 *
 *   bun run gen-key                       # print keypair + next steps to stdout
 *   bun run gen-key --json                # machine-readable envelope
 *   bun run gen-key --out registry.pkcs8  # also write the private key chmod 600
 *   bun run gen-key --out k --force       # allow overwriting an existing file
 *
 * Exit codes:
 *   0  success
 *   1  operational failure (round-trip mismatch, clobber refused, write error)
 *   2  usage error (unknown flag, --out without a value)
 */

import { writeFileSync, chmodSync } from "fs";

import { generateKeypair, pubkeyFromPkcs8, base64ToBytes } from "../src/signing";

// =============================================================================
// Result shape (mirrors the cortex CLI ExitResult convention)
// =============================================================================

export interface KeygenResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface KeygenOptions {
  /** Emit a JSON envelope instead of human-readable text. */
  json?: boolean;
  /**
   * If set, also write the PKCS#8 private key to this path, chmod 600,
   * refusing to clobber an existing file unless `force`.
   */
  out?: string;
  /** Allow overwriting an existing `--out` file (deliberate rotation). */
  force?: boolean;
}

// =============================================================================
// Core
// =============================================================================

/**
 * Generate a registry keypair, verify it round-trips through the registry's
 * own `pubkeyFromPkcs8`, and render the principal-facing output. Pure with
 * respect to stdout/stderr (returns strings); the only side effect is the
 * optional chmod-600 file write under `--out`.
 */
export async function generateRegistryKeypair(
  opts: KeygenOptions = {},
): Promise<KeygenResult> {
  // 1. Mint the keypair using the SAME WebCrypto path the Worker tests use.
  const { privateKeyB64, publicKeyB64 } = await generateKeypair();

  // 2. CORRECTNESS CONTRACT — the emitted PKCS#8 MUST derive, through the
  //    registry's OWN function, to the emitted raw pubkey. If not, the key is
  //    unusable by the Worker; refuse to emit it.
  let derived: string;
  try {
    derived = await pubkeyFromPkcs8(privateKeyB64);
  } catch (err) {
    return opError(
      `round-trip check failed: pubkeyFromPkcs8 threw: ${err instanceof Error ? err.message : String(err)}`,
      opts.json ?? false,
    );
  }
  if (derived !== publicKeyB64) {
    return opError(
      `round-trip mismatch: pubkeyFromPkcs8(private) !== exported raw pubkey — ` +
        `generated key is not consumable by the registry; refusing to emit`,
      opts.json ?? false,
    );
  }

  // Sanity-check the shapes so a malformed export can't slip into output.
  const rawPubLen = base64ToBytes(publicKeyB64).length;
  if (rawPubLen !== 32) {
    return opError(
      `unexpected raw public key length ${rawPubLen.toString()} (want 32)`,
      opts.json ?? false,
    );
  }

  const fingerprint = publicKeyB64.slice(0, 12);

  // 3. Optional chmod-600 file write of the PRIVATE key.
  let outNote: string | undefined;
  if (opts.out !== undefined) {
    const writeRes = writePrivateKeyFile(opts.out, privateKeyB64, opts.force ?? false);
    if (!writeRes.ok) return opError(writeRes.reason, opts.json ?? false);
    outNote = `${opts.out} (chmod 600)`;
  }

  // 4. Render.
  if (opts.json) {
    // The JSON envelope mirrors the cortex CLI `{ status, items, data }` shape.
    // The private key IS present here (the principal needs it) — clearly keyed
    // as `registry_signing_key`, the single sensitive field.
    const data: Record<string, string> = {
      algorithm: "Ed25519",
      registry_signing_key: privateKeyB64, // SECRET — PKCS#8 base64
      registry_public_key: publicKeyB64, // raw base64 (pin this)
      fingerprint,
      ...(outNote !== undefined && { private_key_file: outNote }),
    };
    const envelope = { status: "ok", items: [], data };
    return ok(JSON.stringify(envelope, null, 2) + "\n");
  }

  return ok(renderHuman({ privateKeyB64, publicKeyB64, fingerprint, outNote }));
}

// =============================================================================
// File write (chmod 600, refuse-clobber, O_EXCL) — mirrors TC-1b discipline
// =============================================================================

function writePrivateKeyFile(
  path: string,
  privateKeyB64: string,
  force: boolean,
): { ok: true } | { ok: false; reason: string } {
  try {
    // Non-force create uses "wx" (O_EXCL|O_CREAT): the no-clobber guarantee is
    // KERNEL-enforced (no existsSync→write TOCTOU) and a symlink planted at
    // `path` is REFUSED rather than followed-and-written-through. Force
    // (deliberate rotation) overwrites in place ("w"); the chmod re-assert
    // below covers that path, where writeFileSync ignores `mode` on an
    // already-existing file.
    writeFileSync(path, privateKeyB64 + "\n", {
      mode: 0o600,
      ...(force ? {} : { flag: "wx" }),
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return {
        ok: false,
        reason:
          `refusing to overwrite existing file at ${path} — rotating the registry ` +
          `signing key is a federation-wide event (every consumer must re-pin). ` +
          `Pass --force to rotate deliberately.`,
      };
    }
    return { ok: false, reason: `failed to write ${path}: ${e.message}` };
  }
  // Defensive: an inherited umask can clear bits from the create-mode on some
  // platforms, so re-assert 600 explicitly. No-op on POSIX where the create
  // mode already took; harmless on win32 (ACL-governed).
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch (err) {
      return {
        ok: false,
        reason: `wrote ${path} but failed to chmod 600: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { ok: true };
}

// =============================================================================
// Rendering
// =============================================================================

function renderHuman(args: {
  privateKeyB64: string;
  publicKeyB64: string;
  fingerprint: string;
  outNote: string | undefined;
}): string {
  const { privateKeyB64, publicKeyB64, fingerprint, outNote } = args;
  return [
    `network-registry: generated a fresh Ed25519 signing keypair`,
    ``,
    `  fingerprint:  ${fingerprint}`,
    `  public key:   ${publicKeyB64}`,
    ...(outNote !== undefined ? [`  private file: ${outNote}`] : []),
    ``,
    `─── REGISTRY_SIGNING_KEY (SECRET — base64 PKCS#8 Ed25519 private key) ───`,
    privateKeyB64,
    `────────────────────────────────────────────────────────────────────────`,
    ``,
    `Next steps:`,
    ``,
    `  1. Set the secret on the Worker (paste the SECRET line above when prompted):`,
    `       bunx wrangler secret put REGISTRY_SIGNING_KEY --env production`,
    ``,
    `  2. Pin the PUBLIC key on every consuming cortex (cortex.yaml):`,
    `       policy:`,
    `         federated:`,
    `           registry:`,
    `             url: https://network.meta-factory.ai`,
    `             pubkey: ${publicKeyB64}`,
    ``,
    `  3. (Optional) The Worker derives its pubkey from the secret at boot via`,
    `     pubkeyFromPkcs8(). Set REGISTRY_PUBLIC_KEY only if you want to skip`,
    `     that derivation — it must equal the public key above.`,
    ``,
    `The private key is the registry's federation-wide trust anchor. Anyone`,
    `holding it can forge a signed assertion for ANY principal. Keep it ONLY as`,
    `a Worker secret — never in cortex.yaml, never in a log, never committed.`,
    ``,
  ].join("\n");
}

// =============================================================================
// Result builders
// =============================================================================

function ok(stdout: string): KeygenResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function opError(reason: string, json: boolean): KeygenResult {
  const stderr = json
    ? JSON.stringify({ status: "error", items: [], error: { reason } }, null, 2) + "\n"
    : `generate-registry-keypair: ${reason}\n`;
  return { exitCode: 1, stdout: "", stderr };
}

function usageError(reason: string): KeygenResult {
  return { exitCode: 2, stdout: "", stderr: `generate-registry-keypair: ${reason}\n${helpText()}` };
}

// =============================================================================
// Arg parsing + dispatch
// =============================================================================

export function parseArgs(argv: string[]): KeygenOptions | KeygenResult {
  const opts: KeygenOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        opts.json = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--out": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) {
          return usageError(`--out requires a value`);
        }
        opts.out = value;
        i++;
        break;
      }
      case "--help":
      case "-h":
        return { exitCode: 0, stdout: helpText(), stderr: "" };
      default:
        return usageError(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

export async function dispatch(argv: string[]): Promise<KeygenResult> {
  const parsed = parseArgs(argv);
  if ("exitCode" in parsed) return parsed; // help or usage error
  return generateRegistryKeypair(parsed);
}

function helpText(): string {
  return `generate-registry-keypair — provision the network-registry signing keypair

Usage:
  bun run gen-key [--out <path>] [--force] [--json]

Produces a fresh Ed25519 keypair:
  • REGISTRY_SIGNING_KEY  base64 PKCS#8 private key — paste into wrangler secret put
  • public key            base64 raw 32-byte pubkey — pin as policy.federated.registry.pubkey

The generated key is verified to round-trip through the registry's OWN
pubkeyFromPkcs8() before anything is emitted.

Flags:
  --out <path>   Also write the PKCS#8 private key to <path>, chmod 600
                 (refuses to clobber an existing file without --force).
  --force        Allow overwriting an existing --out file (deliberate rotation).
  --json         Emit a { status, items, data } envelope instead of text.
  --help, -h     Show this help.

Secrets: the private key is printed once (clearly labelled) because you need it
for wrangler. It is NEVER logged, and only written to disk with --out (chmod 600).
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatch(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
