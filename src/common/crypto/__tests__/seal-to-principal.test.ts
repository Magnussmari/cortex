/**
 * Tests for the shared `seal-to-principal` core (#1238).
 *
 * This is the most security-critical primitive in the encryption series
 * (ADR-0019 / docs/design-envelope-encryption.md §3.4), so the suite is
 * deliberately adversarial: it proves authenticity (tamper rejection),
 * confidentiality (a different recipient cannot open), derivation
 * consistency (sender-side seal ↔ recipient-side open over the *published
 * ed25519 pubkey*), and that no secret material leaks into error text.
 */

import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";

import {
  ed25519PubToX25519,
  ed25519SeedToX25519,
  openSealed,
  sealToPrincipal,
} from "../seal-to-principal";

/** Deterministic-ish test identity: a fresh ed25519 seed + its public key b64. */
async function makeIdentity(): Promise<{
  seed: Uint8Array;
  edPubB64: string;
  edPub: Uint8Array;
}> {
  await sodium.ready;
  const seed = sodium.randombytes_buf(32);
  const kp = sodium.crypto_sign_seed_keypair(seed);
  return {
    seed,
    edPub: kp.publicKey,
    edPubB64: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
  };
}

describe("seal-to-principal — round-trip", () => {
  test("string plaintext seals and opens to the exact same bytes", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    const plaintext = "the leaf PSK is hunter2 — never log me";

    const sealed = await sealToPrincipal(plaintext, edPubB64);
    const opened = await openSealed(sealed, seed);

    expect(new TextDecoder().decode(opened)).toBe(plaintext);
  });

  test("Uint8Array plaintext seals and opens byte-identically", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    const plaintext = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 42]);

    const sealed = await sealToPrincipal(plaintext, edPubB64);
    const opened = await openSealed(sealed, seed);

    expect(Array.from(opened)).toEqual(Array.from(plaintext));
  });

  test("empty plaintext round-trips", async () => {
    const { seed, edPubB64 } = await makeIdentity();

    const sealed = await sealToPrincipal(new Uint8Array(0), edPubB64);
    const opened = await openSealed(sealed, seed);

    expect(opened.length).toBe(0);
  });

  test("large plaintext (256 KiB) round-trips", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    await sodium.ready;
    const plaintext = sodium.randombytes_buf(256 * 1024);

    const sealed = await sealToPrincipal(plaintext, edPubB64);
    const opened = await openSealed(sealed, seed);

    expect(Array.from(opened)).toEqual(Array.from(plaintext));
  });

  test("sealing the same plaintext twice yields different ciphertexts (ephemeral sender key)", async () => {
    const { edPubB64 } = await makeIdentity();

    const a = await sealToPrincipal("same", edPubB64);
    const b = await sealToPrincipal("same", edPubB64);

    // crypto_box_seal uses a fresh ephemeral keypair each call → IND-CPA.
    expect(a).not.toBe(b);
  });
});

describe("seal-to-principal — output encoding", () => {
  test("ciphertext is valid standard base64 and round-trips through base64", async () => {
    const { edPubB64 } = await makeIdentity();

    const sealed = await sealToPrincipal("payload", edPubB64);

    // Standard alphabet (not url-safe): only [A-Za-z0-9+/=].
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // Decodes without throwing and re-encodes to the same string.
    await sodium.ready;
    const bytes = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    const reencoded = sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
    expect(reencoded).toBe(sealed);
  });

  test("sealed box is 48 bytes longer than plaintext (epk[32] + MAC[16])", async () => {
    const { edPubB64 } = await makeIdentity();
    await sodium.ready;

    const sealed = await sealToPrincipal(new Uint8Array(10), edPubB64);
    const bytes = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);

    expect(bytes.length).toBe(10 + 32 + 16);
  });
});

describe("seal-to-principal — confidentiality", () => {
  test("a DIFFERENT recipient seed cannot open and leaks no plaintext", async () => {
    const sender = await makeIdentity();
    const attacker = await makeIdentity();
    const secret = "TOP-SECRET-PSK";

    const sealed = await sealToPrincipal(secret, sender.edPubB64);

    let threw = false;
    let recovered: Uint8Array | undefined;
    try {
      recovered = await openSealed(sealed, attacker.seed);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    // Belt-and-braces: even if a future impl returned instead of threw,
    // it must never hand back the plaintext.
    if (recovered) {
      expect(new TextDecoder().decode(recovered)).not.toBe(secret);
    }
  });
});

describe("seal-to-principal — authenticity / integrity", () => {
  test("a tampered ciphertext byte fails to open", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    await sodium.ready;

    const sealed = await sealToPrincipal("authentic message", edPubB64);
    const bytes = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    // Flip a bit in the MAC/ciphertext region (after the 32-byte epk).
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    const tampered = sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

    await expect(openSealed(tampered, seed)).rejects.toThrow();
  });

  test("a tampered ephemeral-pubkey prefix fails to open", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    await sodium.ready;

    const sealed = await sealToPrincipal("authentic message", edPubB64);
    const bytes = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01; // corrupt the embedded ephemeral X25519 pubkey
    const tampered = sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

    await expect(openSealed(tampered, seed)).rejects.toThrow();
  });

  test("a truncated sealed blob fails to open", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    await sodium.ready;

    const sealed = await sealToPrincipal("authentic message", edPubB64);
    const bytes = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    const truncated = sodium.to_base64(
      bytes.subarray(0, bytes.length - 4),
      sodium.base64_variants.ORIGINAL,
    );

    await expect(openSealed(truncated, seed)).rejects.toThrow();
  });
});

describe("seal-to-principal — derivation consistency", () => {
  test("sender sealing to the PUBLISHED ed25519 pub ↔ recipient opening with own seed", async () => {
    // Models the real flow: recipient registers `principal_pubkey` (ed25519,
    // base64) in the registry; an unrelated sender resolves it and seals; the
    // recipient opens with the seed it never published. No shared state but
    // the public key.
    const { seed, edPubB64 } = await makeIdentity();
    const message = "derivation must agree across the two sides";

    const sealed = await sealToPrincipal(message, edPubB64);
    const opened = await openSealed(sealed, seed);

    expect(new TextDecoder().decode(opened)).toBe(message);
  });

  test("ed25519PubToX25519 + ed25519SeedToX25519 are a consistent X25519 keypair", async () => {
    const { seed, edPub } = await makeIdentity();
    await sodium.ready;

    const xPub = ed25519PubToX25519(edPub);
    const xSec = ed25519SeedToX25519(seed);

    // crypto_scalarmult_base(secret) must reproduce the converted public key.
    const derivedPub = sodium.crypto_scalarmult_base(xSec);
    expect(Array.from(derivedPub)).toEqual(Array.from(xPub));
    expect(xPub.length).toBe(32);
    expect(xSec.length).toBe(32);
  });

  test("M3 can layer on top: a manual crypto_box_seal to ed25519PubToX25519 opens via openSealed", async () => {
    // Proves the exported conversion helper is the SAME derivation the core
    // uses, so the M3 wrapper built on the helpers interoperates with the core.
    const { seed, edPub } = await makeIdentity();
    await sodium.ready;

    const xPub = ed25519PubToX25519(edPub);
    const manualSealed = sodium.crypto_box_seal(
      sodium.from_string("built by M3"),
      xPub,
    );
    const sealedB64 = sodium.to_base64(
      manualSealed,
      sodium.base64_variants.ORIGINAL,
    );

    const opened = await openSealed(sealedB64, seed);
    expect(new TextDecoder().decode(opened)).toBe("built by M3");
  });
});

describe("seal-to-principal — input validation (no secret leakage)", () => {
  test("a non-32-byte recipient pubkey is rejected cleanly", async () => {
    const shortB64 = await (async () => {
      await sodium.ready;
      return sodium.to_base64(
        new Uint8Array(16),
        sodium.base64_variants.ORIGINAL,
      );
    })();

    await expect(sealToPrincipal("x", shortB64)).rejects.toThrow();
  });

  test("an undecodable base64 recipient pubkey is rejected cleanly", async () => {
    await expect(sealToPrincipal("x", "!!!not base64!!!")).rejects.toThrow();
  });

  test("a wrong-length seed is rejected by openSealed", async () => {
    const { edPubB64 } = await makeIdentity();
    const sealed = await sealToPrincipal("x", edPubB64);

    await expect(openSealed(sealed, new Uint8Array(31))).rejects.toThrow();
  });

  test("an undecodable base64 sealed blob is rejected by openSealed", async () => {
    const { seed } = await makeIdentity();

    await expect(openSealed("@@@not base64@@@", seed)).rejects.toThrow();
  });

  test("error messages never contain seed or plaintext material", async () => {
    const { seed, edPubB64 } = await makeIdentity();
    await sodium.ready;
    const secret = "leaf-psk-do-not-log-me-zzz";
    const sealed = await sealToPrincipal(secret, edPubB64);
    const seedB64 = sodium.to_base64(seed, sodium.base64_variants.ORIGINAL);

    // Tamper so open fails, then assert the surfaced message is generic.
    const bytes = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    const tampered = sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

    let msg = "";
    try {
      await openSealed(tampered, seed);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }

    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain(seedB64);
    // Don't echo the raw ciphertext back either.
    expect(msg).not.toContain(tampered);
  });
});
