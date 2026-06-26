/**
 * M3 (cortex#1241, ADR-0019 §4) — END-TO-END encrypt-then-sign / verify-before-
 * decrypt, exercised through the REAL myelin signer + verifier (no mocks).
 *
 * Proves the load-bearing composition:
 *   seal(payload, K) → signEnvelope(sealed) → verifyEnvelopeIdentity(sealed) → openPayload(K)
 * i.e. the per-author `signed_by` signature covers the CIPHERTEXT, verification
 * runs on the sealed form (verify-before-decrypt), and decryption recovers the
 * plaintext. Plus: tampering the signed ciphertext breaks the SIGNATURE (payload
 * ∈ SIGNABLE_FIELDS), and the cleartext routing metadata is unchanged + signed.
 */

import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import {
  signEnvelope,
  verifyEnvelopeIdentity,
  createInMemoryRegistry,
} from "@the-metafactory/myelin/identity";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import { NetworkKeyring, openPayload, sealPayload, type NetworkKey } from "../payload-encryption";

const PRINCIPAL_DID = "did:mf:andreas-meta-factory";

async function makeKeypair(): Promise<{ seedB64: string; pubB64: string }> {
  await sodium.ready;
  const seed = sodium.randombytes_buf(32);
  const kp = sodium.crypto_sign_seed_keypair(seed);
  return {
    seedB64: Buffer.from(seed).toString("base64"),
    pubB64: Buffer.from(kp.publicKey).toString("base64"),
  };
}

async function netKey(kid = "research/k1"): Promise<NetworkKey> {
  await sodium.ready;
  return { kid, key: sodium.randombytes_buf(32) };
}

function federatedEnvelope(): Envelope {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "andreas.meta-factory.luna",
    type: "dispatch.task.dispatched",
    timestamp: new Date().toISOString(),
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 3,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { prompt: "the confidential task body", secret: "do-not-leak" },
  };
}

function registryFor(pubB64: string) {
  const registry = createInMemoryRegistry();
  registry.add({
    id: PRINCIPAL_DID,
    display_name: PRINCIPAL_DID,
    network: "andreas",
    public_key: pubB64,
    type: "agent",
    created_at: new Date(0).toISOString(),
  });
  return registry;
}

describe("encrypt-then-sign round-trip (real myelin signer + verifier)", () => {
  test("seal → sign → verify(sealed) → open recovers the plaintext", async () => {
    const { seedB64, pubB64 } = await makeKeypair();
    const k = await netKey();
    const env = federatedEnvelope();

    // 1. ENCRYPT, then 2. SIGN — the signature covers the ciphertext.
    const sealed = await sealPayload(env, "research", k);
    const signed = (await signEnvelope(
      sealed as never,
      seedB64,
      PRINCIPAL_DID,
    )) as unknown as Envelope;

    // 3. VERIFY on the sealed form (verify-before-decrypt). Passes.
    const verify = await verifyEnvelopeIdentity(signed as never, registryFor(pubB64));
    expect(verify.status).toBe("verified");

    // 4. DECRYPT after verify — plaintext recovered.
    const opened = await openPayload(signed, new NetworkKeyring([{ net: "research", keys: [k] }]));
    expect(opened.payload).toEqual(env.payload);

    // The wire form never carried the plaintext.
    expect(JSON.stringify(signed)).not.toContain("do-not-leak");
  });

  test("tampering the signed ciphertext breaks the SIGNATURE (payload ∈ SIGNABLE_FIELDS)", async () => {
    const { seedB64, pubB64 } = await makeKeypair();
    const k = await netKey();
    const sealed = await sealPayload(federatedEnvelope(), "research", k);
    const signed = (await signEnvelope(sealed as never, seedB64, PRINCIPAL_DID)) as unknown as Envelope;

    // Flip a byte of the (signed) ciphertext.
    await sodium.ready;
    const ct = sodium.from_base64(signed.payload.ciphertext as string, sodium.base64_variants.ORIGINAL);
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    const tampered: Envelope = {
      ...signed,
      payload: {
        ...signed.payload,
        ciphertext: sodium.to_base64(ct, sodium.base64_variants.ORIGINAL),
      },
    };

    const verify = await verifyEnvelopeIdentity(tampered as never, registryFor(pubB64));
    expect(verify.status).not.toBe("verified");
  });

  test("cleartext routing metadata stays signed + unchanged through the round-trip", async () => {
    const { seedB64, pubB64 } = await makeKeypair();
    const k = await netKey();
    const env = federatedEnvelope();
    const sealed = await sealPayload(env, "research", k);
    const signed = (await signEnvelope(sealed as never, seedB64, PRINCIPAL_DID)) as unknown as Envelope;

    // Verify passes; then mutating a SIGNED metadata field (type) breaks verify.
    expect((await verifyEnvelopeIdentity(signed as never, registryFor(pubB64))).status).toBe(
      "verified",
    );
    const reTyped: Envelope = { ...signed, type: "dispatch.task.delegated" };
    expect(
      (await verifyEnvelopeIdentity(reTyped as never, registryFor(pubB64))).status,
    ).not.toBe("verified");

    // And the routing fields are byte-identical pre/post seal.
    expect(signed.id).toBe(env.id);
    expect(signed.source).toBe(env.source);
    expect(signed.sovereignty).toEqual(env.sovereignty);
  });
});
