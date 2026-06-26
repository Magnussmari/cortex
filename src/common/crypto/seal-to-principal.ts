/**
 * `seal-to-principal` — the shared sealed-box crypto CORE (#1238).
 *
 * One cryptographic operation, two consumers. This module is the single
 * implementation of "seal an opaque blob to a principal's already-registered
 * ed25519 identity, anonymously" that BOTH of the following depend on:
 *
 *   1. Leaf-secret distribution (ADR-0018 option b′, PR5b) — seals the
 *      per-member NATS leaf PSK to the admitted joiner's registered pubkey.
 *      Uses this core DIRECTLY: `sealToPrincipal` / `openSealed`.
 *
 *   2. M3 federated payload encryption (ADR-0019 / docs/design-envelope-
 *      encryption.md §3.4, TC-3) — seals the envelope `payload` to the
 *      recipient stack's registered pubkey. Does NOT use the seal/open
 *      functions here directly for its on-the-wire shape; instead it layers
 *      an envelope-binding wrapper (`extensions.enc` + AEAD associated-data
 *      over `id`/`type`/`sovereignty.classification`) on top of the exported
 *      ed25519→X25519 conversion helpers.
 *
 * THE BOUNDARY (why this file is deliberately small):
 *   - CORE (here)  = the ed25519→X25519 derivation + anonymous seal/open
 *                    (`crypto_box_seal` / `crypto_box_seal_open` semantics).
 *   - M3 (NOT here) = the AAD/AEAD envelope-binding wrapper. M3 owns that
 *                     and builds it on the conversion helpers this module
 *                     exports. Do not add envelope/AAD logic to this file.
 *
 * Having the ed25519→X25519 derivation in EXACTLY ONE place is the point:
 * two independent derivations is a key-derivation-divergence and security-
 * review hazard (ADR-0019 design constraint L4). Both consumers, one module.
 *
 * --- Construction ---------------------------------------------------------
 * Sealed box = libsodium `crypto_box_seal` (anonymous-sender sealed box):
 *   - The recipient identity is an ed25519 keypair (the SAME seed the stack
 *     already signs envelopes with — NO new key material, ADR-0019 L3).
 *   - The X25519 sealing keys are derived from that ed25519 identity via
 *     `crypto_sign_ed25519_{pk,sk}_to_curve25519`.
 *   - Each seal uses a fresh ephemeral X25519 keypair (forward-ish secrecy
 *     against the sender; IND-CPA); the blob is `epk[32] || box`, and the
 *     box authenticates with a Poly1305 tag — tamper-evident on open.
 *   - The sender is anonymous: the recipient learns nothing about who sealed
 *     it from the blob alone (authorship, where needed, is established by the
 *     surrounding envelope `signed_by[]` chain, not by this core).
 *
 * Base64 is the STANDARD alphabet (not url-safe), matching the rest of the
 * federation crypto surface (`src/common/registry/signing.ts`).
 *
 * --- Async note -----------------------------------------------------------
 * libsodium-wrappers has no synchronous init; every entry point awaits the
 * memoized `sodium.ready`. The leaf-secret and M3 publish/admission paths are
 * already async, so this is free at the call sites.
 */

import sodium from "libsodium-wrappers";

/** Length of an ed25519 seed / X25519 key, in bytes. */
const SEED_BYTES = 32;
const ED25519_PUB_BYTES = 32;

/** Standard (non-url-safe) base64, to match the registry signing surface. */
const B64 = (): typeof sodium.base64_variants.ORIGINAL =>
  sodium.base64_variants.ORIGINAL;

/**
 * Resolve the libsodium ready promise once. `sodium.ready` is itself a
 * memoized promise, so awaiting it repeatedly is cheap; this wrapper just
 * gives the intent a name at each call site.
 */
async function ready(): Promise<void> {
  await sodium.ready;
}

function bytesFromB64(b64: string, label: string): Uint8Array {
  try {
    return sodium.from_base64(b64, B64());
  } catch (err) {
    // Never echo the input back — it may be (or be derived from) secret
    // material. Surface only the field name and the underlying cause.
    throw new Error(`seal-to-principal: ${label} is not valid base64`, {
      cause: err,
    });
  }
}

// ===========================================================================
// Conversion helpers — exported so the M3 wrapper derives identically.
// The derivation lives in EXACTLY these two functions (ADR-0019 L4).
// ===========================================================================

/**
 * Derive the X25519 *public* key from a 32-byte ed25519 public key
 * (`crypto_sign_ed25519_pk_to_curve25519`). This is the recipient's sealing
 * key — the value M3 resolves from the registry's `principal_pubkey`.
 *
 * @throws if `ed25519Pub` is not exactly 32 bytes, or is not a valid
 *   ed25519 point (libsodium rejects non-canonical / low-order points).
 */
export function ed25519PubToX25519(ed25519Pub: Uint8Array): Uint8Array {
  if (ed25519Pub.length !== ED25519_PUB_BYTES) {
    throw new Error(
      `seal-to-principal: ed25519 public key must be ${ED25519_PUB_BYTES} bytes, got ${ed25519Pub.length}`,
    );
  }
  return sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pub);
}

/**
 * Derive the X25519 *secret* key from a 32-byte ed25519 seed
 * (`crypto_sign_ed25519_sk_to_curve25519`, via the seed's expanded secret
 * key). This is the holder's opening key — derived from the SAME seed the
 * stack signs with; no new key material.
 *
 * @throws if `ed25519Seed` is not exactly 32 bytes.
 */
export function ed25519SeedToX25519(ed25519Seed: Uint8Array): Uint8Array {
  if (ed25519Seed.length !== SEED_BYTES) {
    throw new Error(
      `seal-to-principal: ed25519 seed must be ${SEED_BYTES} bytes, got ${ed25519Seed.length}`,
    );
  }
  const { privateKey } = sodium.crypto_sign_seed_keypair(ed25519Seed);
  try {
    return sodium.crypto_sign_ed25519_sk_to_curve25519(privateKey);
  } finally {
    // Best-effort wipe of the expanded ed25519 secret key once the X25519
    // secret is derived. JS GC may have copied it, but zeroizing the buffer
    // we hold is cheap defense-in-depth for a seed-handling module. (The
    // returned X25519 secret is the caller's to wipe after use.)
    sodium.memzero(privateKey);
  }
}

// ===========================================================================
// Core seal / open — the anonymous sealed box. PR5b/leaf-secret uses these
// directly; M3 layers its own envelope wrapper on the helpers above.
// ===========================================================================

/**
 * Seal `plaintext` to a recipient's registered ed25519 identity, anonymously.
 *
 * Equivalent to libsodium `crypto_box_seal` against the X25519 key derived
 * from the recipient's ed25519 public key. The sender is ephemeral and
 * unauthenticated at this layer (authorship rides the envelope `signed_by[]`
 * chain). Exactly what leaf-secret distribution (PR5b) needs to seal a PSK.
 *
 * @param plaintext  bytes (or a UTF-8 string) to seal.
 * @param recipientEd25519PubB64  the recipient's ed25519 public key, standard
 *   base64 (e.g. the registry `principal_pubkey`).
 * @returns standard-base64 sealed ciphertext (`epk[32] || box`).
 * @throws if the recipient key is not valid 32-byte base64 ed25519.
 */
export async function sealToPrincipal(
  plaintext: Uint8Array | string,
  recipientEd25519PubB64: string,
): Promise<string> {
  await ready();
  const edPub = bytesFromB64(recipientEd25519PubB64, "recipient public key");
  const xPub = ed25519PubToX25519(edPub);
  const message =
    typeof plaintext === "string" ? sodium.from_string(plaintext) : plaintext;
  const sealed = sodium.crypto_box_seal(message, xPub);
  return sodium.to_base64(sealed, B64());
}

/**
 * Open a sealed blob with the holder's ed25519 seed.
 *
 * Derives the X25519 keypair from the seed and runs `crypto_box_seal_open`.
 * Fails closed: a blob sealed to a different recipient, or any tampered /
 * truncated blob, throws — and the error text carries NO seed or plaintext
 * material (the cryptographic-doom guidance: authenticate, then reveal
 * nothing on failure).
 *
 * @param sealedB64  standard-base64 sealed ciphertext from {@link sealToPrincipal}.
 * @param ownEd25519Seed  the holder's 32-byte ed25519 seed.
 * @returns the recovered plaintext bytes.
 * @throws on a wrong-length seed, undecodable base64, or any open failure
 *   (wrong recipient / tampered / truncated). The message is generic.
 */
export async function openSealed(
  sealedB64: string,
  ownEd25519Seed: Uint8Array,
): Promise<Uint8Array> {
  await ready();
  if (ownEd25519Seed.length !== SEED_BYTES) {
    throw new Error(
      `seal-to-principal: seed must be ${SEED_BYTES} bytes, got ${ownEd25519Seed.length}`,
    );
  }
  const { publicKey, privateKey } =
    sodium.crypto_sign_seed_keypair(ownEd25519Seed);
  const xPub = sodium.crypto_sign_ed25519_pk_to_curve25519(publicKey);
  const xSec = sodium.crypto_sign_ed25519_sk_to_curve25519(privateKey);
  try {
    const sealed = bytesFromB64(sealedB64, "sealed blob");
    try {
      return sodium.crypto_box_seal_open(sealed, xPub, xSec);
    } catch (err) {
      // Generic on purpose: do not distinguish "wrong recipient" from
      // "tampered", and never surface key/ciphertext bytes.
      throw new Error(
        "seal-to-principal: failed to open sealed box (wrong recipient or tampered ciphertext)",
        { cause: err },
      );
    }
  } finally {
    // Best-effort wipe of the derived secret material once the open has run.
    // The outer try/finally guarantees the wipe even if base64 decode or the
    // open throws. GC may have copied these, but zeroizing the buffers we
    // hold is cheap defense-in-depth for a seed-handling module.
    sodium.memzero(privateKey);
    sodium.memzero(xSec);
  }
}
