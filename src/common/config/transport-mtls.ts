/**
 * TC-4d / TC-4e (Trust & Confidentiality, #627 Phase 4) — transport-mTLS
 * options builder.
 *
 * Transport-layer defense-in-depth: mutual-TLS on the wire, gated by the
 * `security.transport.mtls` posture toggle (TC-0, default OFF). This module is
 * the single, DRY mapping from the posture's mTLS mode + a cert/key/ca path
 * block to the concrete `tls` block nats.js's `connect({ tls })` consumes —
 * applied at every connection site (primary link + per-network leaf links in
 * the LinkPool, the cortex-relay, and the cloud-publisher→Worker leg).
 *
 * INDEPENDENT of the envelope-signing path (`security.signing` →
 * `resolveSigningKnobs`): signing is an M3/M4 envelope-layer concern; mTLS is
 * an M1/M2 transport-layer concern. They engage on orthogonal toggles.
 *
 * ## DECIDED mode mapping (a security decision — do not improvise)
 *
 * | `transport.mtls` | build tls? | missing/invalid cert/key/ca          |
 * | ---------------- | ---------- | ------------------------------------ |
 * | `off`            | never      | n/a — plaintext, byte-identical today |
 * | `on`             | best-effort| warn, connect plaintext (offer mode) |
 * | `require`        | always     | **FAIL CLOSED** — throw, never plaintext |
 *
 * - **off** — return `undefined`. No `tls` block is passed to `connect()`;
 *   the connection is plaintext NKey/JWT auth, byte-identical to pre-TC-4d.
 *   This is the load-bearing back-compat invariant.
 * - **on** — OFFER a client cert when the cert/key/ca paths are configured
 *   and load cleanly. If they are absent or unreadable, log a warning and
 *   return `undefined` (connect plaintext) — `on` is advisory, not enforcing.
 * - **require** — REFUSE a non-mTLS connection. A missing, unreadable, or
 *   bad-permission cert/key/ca is a hard error: this throws so the connect
 *   site fails closed rather than silently downgrading to plaintext.
 *
 * ## Hard line (CLAUDE.md "NEVER disable authentication")
 *
 * This builder NEVER emits `rejectUnauthorized: false` or any skip-verify /
 * insecure escape hatch. mTLS means BOTH sides verify: the server verifies our
 * client cert, and our client verifies the server cert against the configured
 * (or system) CA. nats.js's node transport defaults `rejectUnauthorized` to
 * `true`; we leave it at that default and never override it.
 *
 * ## Secret discipline (CLAUDE.md "NEVER use empty catch blocks")
 *
 * - The private KEY file is chmod-600 gated via the shared `enforceChmod600`
 *   (same gate as the nkey-seed / `.creds` loaders).
 * - Cert/key/ca CONTENTS are NEVER logged — only paths and a short SHA-256
 *   fingerprint of the client cert (for join/audit) ever reach a log line.
 */

import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { TlsOptions } from "nats";
import { enforceChmod600 } from "./file-permissions";
import { expandTilde } from "./loader";

/** The `transport.mtls` toggle's three settable values (mirrors the schema). */
export type MtlsMode = "off" | "on" | "require";

/**
 * The cert/key/ca path block read from the posture config
 * (`security.transport.tls`). All three are optional so a partial config
 * surfaces a clear per-mode error rather than a schema rejection: a principal
 * who sets `mtls: require` but forgets `key_path` should get a fail-closed
 * connect error naming the missing field, not a silent plaintext fallback.
 */
export interface MtlsPaths {
  /** Path to the PEM client certificate this stack presents. */
  cert_path?: string;
  /** Path to the PEM private key for `cert_path`. chmod-600 enforced. */
  key_path?: string;
  /** Path to the PEM CA bundle used to verify the server's cert. */
  ca_path?: string;
}

/** Where this builder is being invoked — threaded into log lines for triage. */
export interface MtlsContext {
  /** e.g. "primary link", `leaf "<id>"`, "cortex-relay", "cloud-publisher". */
  readonly site: string;
}

/**
 * Short, non-sensitive fingerprint of a PEM blob — SHA-256, first 16 hex
 * chars. Safe to log: it identifies WHICH cert is in play without revealing
 * any key/cert bytes. Never call this on a private key.
 */
function fingerprint(pem: string): string {
  return createHash("sha256").update(pem).digest("hex").slice(0, 16);
}

/**
 * Build the nats.js `tls` options for a connection, gated by the mTLS posture
 * mode. Returns `undefined` when no `tls` block should be passed (plaintext).
 *
 * Loads cert/key/ca CONTENTS (not paths) so the chmod-600 gate on the private
 * key runs in OUR loader rather than being delegated to nats.js — same
 * discipline as `loadCredsBytes` / `loadStackSigningKey`. Passing contents via
 * `cert`/`key`/`ca` keeps the path off the nats.js side and lets us enforce the
 * permission policy uniformly.
 *
 * @param mode  `security.transport.mtls`.
 * @param paths `security.transport.tls` cert/key/ca path block (may be empty).
 * @param ctx   Connection site label for log lines.
 * @throws under `require` when cert/key/ca is absent, unreadable, or the key
 *         file is not chmod-600 — the connect site MUST fail closed.
 */
export function buildNatsTlsOptions(
  mode: MtlsMode,
  paths: MtlsPaths | undefined,
  ctx: MtlsContext,
): TlsOptions | undefined {
  // off — plaintext, byte-identical to pre-TC-4d. No tls block at all.
  if (mode === "off") return undefined;

  const certPath = paths?.cert_path;
  const keyPath = paths?.key_path;
  const caPath = paths?.ca_path;

  // A complete client-cert triple is cert + key (+ optional CA for server
  // verification; when ca_path is omitted the system trust store is used).
  const haveClientCert = certPath !== undefined && keyPath !== undefined;

  if (!haveClientCert) {
    const missing = [
      certPath === undefined ? "cert_path" : null,
      keyPath === undefined ? "key_path" : null,
    ]
      .filter((m): m is string => m !== null)
      .join(", ");
    if (mode === "require") {
      // Fail closed — never silently downgrade to plaintext under `require`.
      throw new Error(
        `transport.mtls=require but ${missing} missing for ${ctx.site}: ` +
          `refusing to connect without a client certificate (no plaintext fallback)`,
      );
    }
    // mode === "on" — advisory offer mode. No client cert configured ⇒
    // connect plaintext, but say so loudly so the principal notices the gap.
    process.stderr.write(
      `WARNING: transport.mtls=on but ${missing} missing for ${ctx.site} — ` +
        `connecting WITHOUT a client certificate (set security.transport.tls.{cert_path,key_path} to offer mTLS)\n`,
    );
    return undefined;
  }

  // Load the materials. Under `require` any failure (missing file, bad perms,
  // unreadable CA) is fatal — propagate so the connect site fails closed.
  // Under `on` a load failure degrades to plaintext with a loud warning.
  try {
    // certPath/keyPath are non-undefined here (haveClientCert gate above).
    const expandedCert = expandTilde(certPath);
    const expandedKey = expandTilde(keyPath);

    // chmod-600 gate on the PRIVATE KEY only — same policy as the nkey-seed
    // / `.creds` loaders. The cert + CA are public material; no perm gate.
    enforceChmod600(expandedKey);

    const cert = readFileSync(expandedCert, "utf-8");
    const key = readFileSync(expandedKey, "utf-8");
    const ca = caPath !== undefined ? readFileSync(expandTilde(caPath), "utf-8") : undefined;

    // Pass CONTENTS, not paths. NEVER set rejectUnauthorized:false — both
    // sides verify (CLAUDE.md hard line). When `ca` is omitted, nats.js's
    // node transport verifies the server against the system trust store.
    const tls: TlsOptions = {
      cert,
      key,
      ...(ca !== undefined ? { ca } : {}),
    };

    process.stderr.write(
      `transport.mtls=${mode}: ${ctx.site} presenting client cert ` +
        `(fingerprint sha256:${fingerprint(cert)}${ca !== undefined ? ", custom CA" : ", system CA"})\n`,
    );
    return tls;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === "require") {
      // Fail closed — re-throw with the site so the principal can fix the path
      // / permissions. The connect site must NOT fall back to plaintext.
      throw new Error(
        `transport.mtls=require: failed to load client cert/key/ca for ${ctx.site}: ${message} ` +
          `(refusing to connect — fix the cert paths/permissions or set mtls=on to allow plaintext fallback)`,
        { cause: err },
      );
    }
    // mode === "on" — degrade to plaintext, loudly.
    process.stderr.write(
      `WARNING: transport.mtls=on: failed to load client cert/key/ca for ${ctx.site}: ${message} — ` +
        `connecting WITHOUT mTLS (plaintext)\n`,
    );
    return undefined;
  }
}

/**
 * TC-4e — client-cert material for an HTTPS mTLS leg (the cloud-publisher →
 * Worker POST). Mirrors {@link buildNatsTlsOptions} but returns PEM strings in
 * the shape Bun's `fetch({ tls })` (and node's `https.Agent`) consume, rather
 * than nats.js's `TlsOptions`. Same posture gating + same hard line: NEVER a
 * skip-verify hatch.
 */
export interface HttpsMtlsMaterial {
  /** PEM client certificate. */
  cert: string;
  /** PEM private key (loaded from a chmod-600 file). */
  key: string;
  /** PEM CA bundle, when a custom CA is configured (else system trust store). */
  ca?: string;
}

/**
 * Build HTTPS client-cert material for the cloud-publisher leg, gated by the
 * mTLS posture mode. Returns `undefined` when no client cert should be
 * presented (plaintext-over-TLS, i.e. server-auth-only HTTPS — the default).
 *
 * - `off` — `undefined` (today's behaviour: ordinary HTTPS, server auth only).
 * - `on`  — present a client cert when cert/key load; degrade (warn) if not.
 * - `require` — a missing/invalid cert FAILS CLOSED (throws).
 *
 * @throws under `require` when cert/key/ca is absent, unreadable, or the key
 *         file is not chmod-600.
 */
export function buildHttpsMtlsMaterial(
  mode: MtlsMode,
  paths: MtlsPaths | undefined,
  ctx: MtlsContext,
): HttpsMtlsMaterial | undefined {
  if (mode === "off") return undefined;

  const certPath = paths?.cert_path;
  const keyPath = paths?.key_path;
  const caPath = paths?.ca_path;
  const haveClientCert = certPath !== undefined && keyPath !== undefined;

  if (!haveClientCert) {
    const missing = [
      certPath === undefined ? "cert_path" : null,
      keyPath === undefined ? "key_path" : null,
    ]
      .filter((m): m is string => m !== null)
      .join(", ");
    if (mode === "require") {
      throw new Error(
        `transport.mtls=require but ${missing} missing for ${ctx.site}: ` +
          `refusing to send without a client certificate (no plaintext fallback)`,
      );
    }
    process.stderr.write(
      `WARNING: transport.mtls=on but ${missing} missing for ${ctx.site} — ` +
        `sending WITHOUT a client certificate (server-auth HTTPS only)\n`,
    );
    return undefined;
  }

  try {
    const expandedCert = expandTilde(certPath);
    const expandedKey = expandTilde(keyPath);
    enforceChmod600(expandedKey);
    const cert = readFileSync(expandedCert, "utf-8");
    const key = readFileSync(expandedKey, "utf-8");
    const ca = caPath !== undefined ? readFileSync(expandTilde(caPath), "utf-8") : undefined;
    process.stderr.write(
      `transport.mtls=${mode}: ${ctx.site} presenting client cert ` +
        `(fingerprint sha256:${fingerprint(cert)}${ca !== undefined ? ", custom CA" : ", system CA"})\n`,
    );
    return { cert, key, ...(ca !== undefined ? { ca } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === "require") {
      throw new Error(
        `transport.mtls=require: failed to load client cert/key/ca for ${ctx.site}: ${message} ` +
          `(refusing to send — fix the cert paths/permissions or set mtls=on to allow fallback)`,
        { cause: err },
      );
    }
    process.stderr.write(
      `WARNING: transport.mtls=on: failed to load client cert/key/ca for ${ctx.site}: ${message} — ` +
        `sending WITHOUT mTLS (server-auth HTTPS only)\n`,
    );
    return undefined;
  }
}

/**
 * TC-4e — advisory warning when a FEDERATED leaf link connects WITHOUT TLS.
 * Cross-principal cleartext on a federated leaf is a confidentiality risk
 * (another principal's deployment is on the far end); even when `mtls` is off
 * the principal should KNOW the federated traffic is in the clear.
 *
 * Fires regardless of posture (it's advisory, not gated) — but is most
 * relevant when `mtls` is off and federated leaves exist. A leaf whose URL is
 * `tls://…` OR which built a `tls` block is considered protected and is NOT
 * warned about. A `nats://…` federated leaf with no `tls` block triggers the
 * warning.
 *
 * The runtime has no `SystemEventSource` threaded into the LinkPool (see
 * `runtime.ts` F-3b/F-3c seams), so this writes to stderr by default and
 * additionally invokes an optional structured sink so a caller that DOES have
 * an event source can promote it to a `system.error` audit envelope.
 *
 * @param info  the leaf identity + url + whether a tls block was built.
 * @param sink  optional structured sink (defaults to stderr only).
 */
export interface FederatedCleartextWarning {
  /** The leaf's pool key (`leaf_node`). */
  readonly leafId: string;
  /** The federation network id riding this leaf. */
  readonly networkId: string;
  /** The leaf's connect URL (credentials already redacted by the caller). */
  readonly safeUrl: string;
}

/**
 * Emit the federated-leaf-without-TLS warning. Called by the LinkPool when a
 * leaf for a federated network connects over a non-TLS transport.
 *
 * @param info structured warning payload.
 * @param sink optional structured sink; when provided it runs IN ADDITION to
 *   the stderr line (so an event-source-backed caller can audit it).
 */
export function warnFederatedCleartext(
  info: FederatedCleartextWarning,
  sink?: (info: FederatedCleartextWarning) => void,
): void {
  process.stderr.write(
    `WARNING: federated leaf "${info.leafId}" (network=${info.networkId}) connected to ${info.safeUrl} ` +
      `WITHOUT TLS — cross-principal traffic on this leaf is in CLEARTEXT. ` +
      `Set security.transport.mtls and a tls:// leaf URL to protect it.\n`,
  );
  if (sink !== undefined) {
    sink(info);
  }
}
