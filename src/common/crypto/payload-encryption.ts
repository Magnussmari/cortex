/**
 * M3 — federated payload encryption with a per-network key (TC-3.1).
 *
 * ADR-0019 (amended 2026-06-27 — option-1 per-network key) /
 * `docs/design-envelope-encryption.md` §3.1. cortex#1241, umbrella #627.
 *
 * THE MODEL (per-network key, NOT sealed-to-recipient):
 *   - One symmetric AEAD key `K` per network. EVERY admitted member holds `K`,
 *     so every member can read; outsiders cannot. ALL federated payloads —
 *     Direct, Delegate AND Offer — are sealed with `K`.
 *   - This module USES `K` to seal `payload` (libsodium XChaCha20-Poly1305 AEAD).
 *     It does NOT use the sealed-box primitive (`crypto_box_seal`); that is for
 *     *delivering* `K` to members (PR5b, `seal-to-principal.ts`). M3 only
 *     CONSUMES `K` (read from `policy.federated.networks[].payload_key`).
 *   - Encrypt-then-sign: seal `payload` FIRST, then the runtime's existing
 *     `signed_by` signing covers the ciphertext. Receiver verifies `signed_by`
 *     on the sealed form, THEN decrypts. (Ordering enforced at the call sites:
 *     the publish path seals before `signEnvelope`; the receive path opens only
 *     after `verifySignedByChain` succeeds.)
 *
 * --- Why this is tamper-evident WITHOUT myelin's `extensions` ∈ SIGNABLE_FIELDS
 * The ciphertext lands in `payload`, which IS in myelin's SIGNABLE_FIELDS — so
 * the per-author `signed_by` signature covers the ciphertext. The `extensions.enc`
 * marker is NOT signed (myelin excludes `extensions`), but it carries only the
 * scheme id + network id + key id — non-secret routing-for-decrypt metadata.
 * The AEAD ASSOCIATED DATA binds the ciphertext to the already-signed cleartext
 * header fields (`id` + `type` + `sovereignty.classification`). Consequences:
 *   - A hub cannot lift the ciphertext onto a DIFFERENT envelope header: the AAD
 *     would not match → AEAD open fails closed. (And the different header would
 *     need re-signing anyway, which the hub can't do.)
 *   - Tampering the unsigned `extensions.enc` (or the nonce) only mis-selects a
 *     key/algorithm or corrupts the nonce → AEAD open fails closed (a DoS, never
 *     a confidentiality or integrity break).
 * So M3 needs NO myelin-side `extensions`-in-SIGNABLE_FIELDS change. The `nonce`
 * is carried INSIDE `payload` (which IS signed) for belt-and-braces — a nonce
 * swap then also breaks the signature, not just the AEAD tag.
 *
 * --- Async note
 * libsodium-wrappers has no synchronous init; every entry point awaits the
 * memoized `sodium.ready`. The publish + receive paths are already async.
 */

import sodium from "libsodium-wrappers";
import type { Envelope } from "../../bus/myelin/envelope-validator";

/** AEAD scheme id stamped into `extensions.enc.alg`. Versioned so it can evolve. */
export const PAYLOAD_ENC_ALG = "xchacha20poly1305" as const;

/** Standard (non-url-safe) base64, matching the rest of the federation crypto surface. */
const B64 = (): typeof sodium.base64_variants.ORIGINAL =>
  sodium.base64_variants.ORIGINAL;

/** Bytes in an XChaCha20-Poly1305 key (32) and nonce (24). */
const KEY_BYTES = 32;

/** Per-network symmetric AEAD key plus its id (rotation epoch). */
export interface NetworkKey {
  /** Key id / rotation epoch — stamped into `extensions.enc.kid` so a member
   *  selects the right `K` (current, or a grace-window previous) on open. */
  readonly kid: string;
  /** 32-byte XChaCha20-Poly1305 key. */
  readonly key: Uint8Array;
}

/** Per-network encryption posture from `policy.federated.networks[].encryption`. */
export type EncryptionMode = "off" | "enabled" | "required";

/** The `extensions.enc` marker on a sealed envelope. NOT a `recipients[]` list —
 *  it is a network key, so it names the network + key, never a recipient set. */
export interface SealedEncMarker {
  readonly alg: typeof PAYLOAD_ENC_ALG;
  /** Network id — selects which `K`. */
  readonly net: string;
  /** Network-key id (rotation epoch). */
  readonly kid: string;
}

/** The sealed `payload` body that replaces the cleartext domain payload. */
interface SealedPayloadBody {
  /** base64 AEAD ciphertext (includes the Poly1305 tag). */
  readonly ciphertext: string;
  /** base64 XChaCha20 nonce. Carried inside `payload` so it is under the signature. */
  readonly nonce: string;
}

/** Thrown when a sealed envelope names a network/key the local keyring lacks.
 *  The caller decides the posture response (required → reject; transition → log). */
export class NetworkKeyUnavailableError extends Error {
  constructor(
    readonly net: string,
    readonly kid: string,
  ) {
    super(`payload-encryption: no key for network=${net} kid=${kid}`);
    this.name = "NetworkKeyUnavailableError";
  }
}

async function ready(): Promise<void> {
  await sodium.ready;
}

/**
 * AEAD associated-data: bind the ciphertext to the cleartext header fields.
 * Deterministic, canonical, computed identically on seal + open. Any divergence
 * between seal-time and open-time → AEAD tag mismatch → fail closed (the
 * lift-onto-another-header defence — a hub cannot move the ciphertext onto a
 * different envelope header).
 *
 * Bound fields: `id`, `type`, `sovereignty.classification` (all in myelin's
 * SIGNABLE_FIELDS, so doubly protected) plus `correlation_id` (NOT signed —
 * myelin excludes it — so the AAD is what makes a correlation_id swap under a
 * sealed body tamper-evident; ADR-0019 receive-path lock).
 */
function associatedData(envelope: Envelope): Uint8Array {
  const bound = JSON.stringify([
    envelope.id,
    envelope.type,
    envelope.sovereignty.classification,
    envelope.correlation_id ?? null,
  ]);
  return sodium.from_string(bound);
}

/**
 * Is this envelope a sealed (encrypted-payload) envelope? Keyed on the presence
 * of a well-formed `extensions.enc` marker. Used by the receive path to decide
 * between cleartext (transition window) and sealed inbound.
 */
export function isSealedPayload(envelope: Envelope): boolean {
  return readMarker(envelope) !== undefined;
}

/** Parse + validate the `extensions.enc` marker, or `undefined` if absent/malformed. */
export function readMarker(envelope: Envelope): SealedEncMarker | undefined {
  const ext = envelope.extensions;
  if (ext === undefined || typeof ext !== "object") return undefined;
  const enc = (ext).enc;
  if (enc === undefined || typeof enc !== "object") return undefined;
  const m = enc as Record<string, unknown>;
  if (
    m.alg !== PAYLOAD_ENC_ALG ||
    typeof m.net !== "string" ||
    typeof m.kid !== "string"
  ) {
    return undefined;
  }
  return { alg: PAYLOAD_ENC_ALG, net: m.net, kid: m.kid };
}

/**
 * Seal `envelope.payload` with the network key `K`. Returns a NEW envelope whose
 * `payload` carries `{ ciphertext, nonce }` and whose `extensions.enc` carries
 * `{ alg, net, kid }`. All other (cleartext, routing/trust) metadata is copied
 * verbatim. Encrypt-then-sign: the CALLER signs the returned envelope.
 *
 * Idempotency guard: an already-sealed envelope is returned unchanged (double-
 * seal would bury the marker and break open).
 */
export async function sealPayload(
  envelope: Envelope,
  net: string,
  networkKey: NetworkKey,
): Promise<Envelope> {
  if (isSealedPayload(envelope)) return envelope;
  await ready();
  assertKeyBytes(networkKey.key);
  const plaintext = sodium.from_string(JSON.stringify(envelope.payload));
  const nonce = sodium.randombytes_buf(
    sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  );
  const aad = associatedData(envelope);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad,
    null,
    nonce,
    networkKey.key,
  );
  const sealedBody: SealedPayloadBody = {
    ciphertext: sodium.to_base64(ciphertext, B64()),
    nonce: sodium.to_base64(nonce, B64()),
  };
  const marker: SealedEncMarker = { alg: PAYLOAD_ENC_ALG, net, kid: networkKey.kid };
  return {
    ...envelope,
    payload: { ...sealedBody },
    extensions: { ...(envelope.extensions ?? {}), enc: { ...marker } },
  };
}

/**
 * Open a sealed envelope. Resolves `K` from `keyring` via the marker's
 * `net` + `kid`, verifies the AEAD tag (incl. the AAD binding to the cleartext
 * header), and returns a NEW envelope with the recovered cleartext `payload` and
 * the `extensions.enc` marker stripped. The CALLER must have already verified the
 * `signed_by` chain (verify-before-decrypt).
 *
 * @throws NetworkKeyUnavailableError when the keyring lacks the named key.
 * @throws Error (generic) on any AEAD open failure — wrong key, tampered
 *   ciphertext, or a header that does not match the AAD (lift attempt). The
 *   message carries no key or plaintext material.
 */
export async function openPayload(
  envelope: Envelope,
  keyring: NetworkKeyring,
): Promise<Envelope> {
  const marker = readMarker(envelope);
  if (marker === undefined) {
    throw new Error("payload-encryption: openPayload called on a non-sealed envelope");
  }
  const networkKey = keyring.resolve(marker.net, marker.kid);
  if (networkKey === undefined) {
    throw new NetworkKeyUnavailableError(marker.net, marker.kid);
  }
  await ready();
  const body = envelope.payload as unknown as Partial<SealedPayloadBody>;
  if (typeof body.ciphertext !== "string" || typeof body.nonce !== "string") {
    throw new Error("payload-encryption: sealed payload missing ciphertext/nonce");
  }
  const aad = associatedData(envelope);
  let plaintext: Uint8Array;
  try {
    const ciphertext = sodium.from_base64(body.ciphertext, B64());
    const nonce = sodium.from_base64(body.nonce, B64());
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      aad,
      nonce,
      networkKey.key,
    );
  } catch (err) {
    // Generic on purpose (cryptographic-doom): do not distinguish wrong-key
    // from tampered-ciphertext from header-mismatch, and never surface bytes.
    throw new Error(
      "payload-encryption: failed to open sealed payload (wrong key, tampered ciphertext, or header mismatch)",
      { cause: err },
    );
  }
  const recovered = JSON.parse(sodium.to_string(plaintext)) as Record<string, unknown>;
  return {
    ...envelope,
    payload: recovered,
    extensions: stripEncMarker(envelope.extensions),
  };
}

/** Remove the `enc` marker from `extensions`, dropping `extensions` entirely if it
 *  becomes empty (so a round-trip seal→open is byte-clean). */
function stripEncMarker(
  extensions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (extensions === undefined) return undefined;
  const { enc: _enc, ...rest } = extensions;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function assertKeyBytes(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `payload-encryption: network key must be ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
}

// ===========================================================================
// NetworkKeyring — the per-member set of network keys (current + grace previous)
// ===========================================================================

/**
 * Holds the network keys a member stack possesses, keyed by network id. Each
 * network may carry several keys (the current one used for sealing, plus
 * grace-window previous keys retained to open in-flight / replayed envelopes
 * sealed before a rotation). Selection on open is by `kid`.
 *
 * For M3 the keys are sourced from config (`payload_key`); PR5b populates them
 * over the admission/seal channel. The keyring is the consumption contract:
 * whoever delivers `K` adds it here.
 */
export class NetworkKeyring {
  /** network id → keys, current first. */
  private readonly byNet: Map<string, NetworkKey[]>;

  constructor(entries: readonly { net: string; keys: readonly NetworkKey[] }[] = []) {
    this.byNet = new Map();
    for (const { net, keys } of entries) {
      if (keys.length === 0) continue;
      this.byNet.set(net, [...keys]);
    }
  }

  /** The current (sealing) key for a network, or `undefined` if none held. */
  current(net: string): NetworkKey | undefined {
    return this.byNet.get(net)?.[0];
  }

  /**
   * Resolve a key for `(net, kid)`. Strict `kid` match across current + grace
   * keys. Returns `undefined` (fail closed) when the network is unknown or no
   * held key matches `kid` — the caller raises `NetworkKeyUnavailableError`.
   */
  resolve(net: string, kid: string): NetworkKey | undefined {
    const keys = this.byNet.get(net);
    if (keys === undefined) return undefined;
    return keys.find((k) => k.kid === kid);
  }

  /** Whether the keyring holds at least one key for `net`. */
  has(net: string): boolean {
    return this.byNet.has(net);
  }
}
