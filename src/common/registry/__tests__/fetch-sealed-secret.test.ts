/**
 * ADR-0018 PR5b — member-side fetch + unseal round-trip tests.
 *
 * Exercises the FULL crypto round-trip with REAL keys: mint a member identity,
 * seal a leaf-secret envelope to its pubkey (as the hub-admin would), serve it
 * through a fake `/admission-requests/mine`, and prove the member fetches +
 * unseals exactly its own PSK — and that wrong-network / no-blob / tampered /
 * wrong-recipient all fail soft-closed.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "nkeys.js";
import { sealToPrincipal } from "../../crypto/seal-to-principal";
import { encodeLeafSecretEnvelope, decodeLeafSecretEnvelope } from "../sealed-leaf-secret";
import { fetchSealedLeafSecret, type FetchLike } from "../fetch-sealed-secret";
import { materialFromSeedString, type StackIdentityMaterial } from "../../../bus/stack-provisioning";

function newMember(): StackIdentityMaterial {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  return materialFromSeedString(seed);
}

/** A fake registry serving a fixed set of /mine rows. */
function fakeRegistry(rows: unknown[]): FetchLike {
  return async (url) => {
    if (url.endsWith("/admission-requests/mine")) {
      return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
}

async function sealedFor(material: StackIdentityMaterial, leafPsk: string, leafUser: string): Promise<string> {
  const plaintext = encodeLeafSecretEnvelope({ leaf_psk: leafPsk, leaf_user: leafUser });
  return sealToPrincipal(plaintext, material.pubkeyB64);
}

describe("fetchSealedLeafSecret — round-trip", () => {
  test("member fetches + unseals its own leaf PSK", async () => {
    const member = newMember();
    const sealed = await sealedFor(member, "PSK-abc", "alice");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealed },
    ]);

    const res = await fetchSealedLeafSecret({
      registryUrl: "https://registry.example",
      networkId: "metafactory",
      principalId: "alice",
      material: member,
      fetchImpl,
    });
    expect(res).toEqual({ ok: true, leafPsk: "PSK-abc", leafUser: "alice" });
  });

  test("selects the row for the TARGET network (ignores other networks)", async () => {
    const member = newMember();
    const sealedMeta = await sealedFor(member, "PSK-meta", "alice");
    const sealedOther = await sealedFor(member, "PSK-other", "alice");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "other", status: "ADMITTED", sealed_secret: sealedOther },
      { request_id: "r2", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealedMeta },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok && res.leafPsk).toBe("PSK-meta");
  });

  test("no admitted+sealed row → soft-closed { ok: false }", async () => {
    const member = newMember();
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "PENDING", sealed_secret: null },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("a blob sealed to a DIFFERENT member does not open (fails soft-closed)", async () => {
    const member = newMember();
    const stranger = newMember();
    const sealedForStranger = await sealedFor(stranger, "PSK-x", "bob");
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: sealedForStranger },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("a tampered ciphertext fails soft-closed", async () => {
    const member = newMember();
    const sealed = await sealedFor(member, "PSK-abc", "alice");
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-3);
    const fetchImpl = fakeRegistry([
      { request_id: "r1", principal_id: "alice", peer_pubkey: member.pubkeyB64, network_id: "metafactory", status: "ADMITTED", sealed_secret: tampered },
    ]);
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });

  test("registry HTTP error → soft-closed", async () => {
    const member = newMember();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "down" });
    const res = await fetchSealedLeafSecret({ registryUrl: "x", networkId: "metafactory", principalId: "alice", material: member, fetchImpl });
    expect(res.ok).toBe(false);
  });
});

describe("LeafSecretEnvelope — the M3 seam", () => {
  test("encode→decode round-trips leaf_psk + leaf_user", () => {
    const env = decodeLeafSecretEnvelope(encodeLeafSecretEnvelope({ leaf_psk: "p", leaf_user: "u" }));
    expect(env).toEqual({ v: 1, leaf_psk: "p", leaf_user: "u" });
  });

  test("tolerates the future payload_key field (M3 #1246 rides the same envelope)", () => {
    const json = encodeLeafSecretEnvelope({ leaf_psk: "p", leaf_user: "u", payload_key: "K" });
    const env = decodeLeafSecretEnvelope(json);
    expect(env.payload_key).toBe("K");
    expect(env.leaf_psk).toBe("p");
  });

  test("rejects a malformed envelope without echoing the plaintext", () => {
    expect(() => decodeLeafSecretEnvelope("not json")).toThrow(/not valid JSON/);
    expect(() => decodeLeafSecretEnvelope(JSON.stringify({ leaf_user: "u" }))).toThrow(/leaf_psk/);
  });
});
