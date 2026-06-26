/**
 * M3 (cortex#1241) — config → keyring/seal-policy bridge.
 */

import { describe, expect, test } from "bun:test";
import type { PolicyFederatedNetwork } from "../../types/cortex-config";
import {
  buildNetworkKeyring,
  buildSealPolicyByPrincipal,
  countEncryptionEnabledNetworks,
  defaultKeyId,
  networkKeyFromConfig,
} from "../network-encryption-policy";

const K32_A = Buffer.alloc(32, 1).toString("base64");
const K32_B = Buffer.alloc(32, 2).toString("base64");

function network(o: Partial<PolicyFederatedNetwork> & { id: string }): PolicyFederatedNetwork {
  return {
    leaf_node: "leaf-x",
    peers: [],
    accept_subjects: [],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 3,
    ...o,
  };
}

describe("networkKeyFromConfig", () => {
  test("decodes payload_key (32 bytes) with default kid", () => {
    const k = networkKeyFromConfig(network({ id: "research", payload_key: K32_A }));
    expect(k?.kid).toBe("research/k1");
    expect(k?.key.length).toBe(32);
  });

  test("honours an explicit payload_key_id", () => {
    const k = networkKeyFromConfig(
      network({ id: "research", payload_key: K32_A, payload_key_id: "research/epoch-7" }),
    );
    expect(k?.kid).toBe("research/epoch-7");
  });

  test("undefined when no payload_key", () => {
    expect(networkKeyFromConfig(network({ id: "research" }))).toBeUndefined();
  });

  test("defaultKeyId shape", () => {
    expect(defaultKeyId("net1")).toBe("net1/k1");
  });
});

describe("buildNetworkKeyring", () => {
  test("one current key per keyed network; unkeyed networks absent", () => {
    const keyring = buildNetworkKeyring([
      network({ id: "research", payload_key: K32_A }),
      network({ id: "plain" }), // no key
    ]);
    expect(keyring.has("research")).toBe(true);
    expect(keyring.has("plain")).toBe(false);
    expect(keyring.current("research")?.kid).toBe("research/k1");
    expect(keyring.resolve("research", "research/k1")?.kid).toBe("research/k1");
  });
});

describe("buildSealPolicyByPrincipal", () => {
  test("maps each peer principal → its network seal policy when encryption on", () => {
    const map = buildSealPolicyByPrincipal([
      network({
        id: "research",
        encryption: "enabled",
        payload_key: K32_A,
        peers: [{ principal_id: "jc", stack_id: "jc/host" }] as never,
      }),
    ]);
    const p = map.get("jc");
    expect(p?.net).toBe("research");
    expect(p?.mode).toBe("enabled");
    expect(p?.key?.kid).toBe("research/k1");
  });

  test("encryption off / unset → principal omitted (cleartext, as today)", () => {
    const map = buildSealPolicyByPrincipal([
      network({ id: "n1", peers: [{ principal_id: "a", stack_id: "a/h" }] as never }),
      network({
        id: "n2",
        encryption: "off",
        peers: [{ principal_id: "b", stack_id: "b/h" }] as never,
      }),
    ]);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(false);
  });

  test("enabled but no payload_key → policy present with mode but no key (→ warn+cleartext)", () => {
    const map = buildSealPolicyByPrincipal([
      network({
        id: "research",
        encryption: "required",
        peers: [{ principal_id: "jc", stack_id: "jc/host" }] as never,
      }),
    ]);
    const p = map.get("jc");
    expect(p?.mode).toBe("required");
    expect(p?.key).toBeUndefined();
  });

  test("a principal on two networks resolves to the first declaring one", () => {
    const map = buildSealPolicyByPrincipal([
      network({
        id: "first",
        encryption: "enabled",
        payload_key: K32_A,
        peers: [{ principal_id: "jc", stack_id: "jc/host" }] as never,
      }),
      network({
        id: "second",
        encryption: "enabled",
        payload_key: K32_B,
        peers: [{ principal_id: "jc", stack_id: "jc/host2" }] as never,
      }),
    ]);
    expect(map.get("jc")?.net).toBe("first");
  });

  // cortex#1246 — self-addressed federated Offer seal.
  test("ownPrincipal mapped to its sole encryption-enabled network (self-addressed Offer seals)", () => {
    const map = buildSealPolicyByPrincipal(
      [
        network({
          id: "research",
          encryption: "required",
          payload_key: K32_A,
          peers: [{ principal_id: "jc", stack_id: "jc/host" }] as never,
        }),
      ],
      "andreas",
    );
    const own = map.get("andreas");
    expect(own?.net).toBe("research");
    expect(own?.key?.kid).toBe("research/k1");
  });

  test("ownPrincipal NOT mapped under multiple encryption-enabled networks (ambiguous → unsealed + warn-once at publish)", () => {
    const map = buildSealPolicyByPrincipal(
      [
        network({ id: "research", encryption: "required", payload_key: K32_A }),
        network({ id: "lab", encryption: "enabled", payload_key: K32_B }),
      ],
      "andreas",
    );
    expect(map.has("andreas")).toBe(false);
  });

  test("ownPrincipal NOT mapped when no encryption-enabled network", () => {
    const map = buildSealPolicyByPrincipal(
      [network({ id: "research", encryption: "off", payload_key: K32_A })],
      "andreas",
    );
    expect(map.has("andreas")).toBe(false);
  });

  test("ownPrincipal omitted when it already names a peer (peer mapping wins)", () => {
    const map = buildSealPolicyByPrincipal(
      [
        network({
          id: "research",
          encryption: "enabled",
          payload_key: K32_A,
          peers: [{ principal_id: "andreas", stack_id: "andreas/h" }] as never,
        }),
      ],
      "andreas",
    );
    // Single mapping, from the peers[] pass (idempotent — not double-set).
    expect(map.get("andreas")?.net).toBe("research");
  });
});

describe("countEncryptionEnabledNetworks", () => {
  test("counts enabled/required, ignores off/unset", () => {
    expect(
      countEncryptionEnabledNetworks([
        network({ id: "a", encryption: "required" }),
        network({ id: "b", encryption: "enabled" }),
        network({ id: "c", encryption: "off" }),
        network({ id: "d" }), // unset
      ]),
    ).toBe(2);
  });
});
