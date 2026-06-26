/**
 * M3 (cortex#1241, ADR-0019) — bridge `policy.federated.networks[]` config to
 * the runtime's encryption decision: build the member's {@link NetworkKeyring}
 * (for unsealing inbound) and the per-target-principal seal policy (for sealing
 * outbound). Pure + side-effect-free so it is fully unit-testable; the runtime
 * wires the result into its publish + receive paths.
 *
 * Decoupled from the crypto core (`payload-encryption.ts`) because it imports the
 * config types; the core stays config-agnostic.
 */

import type { PolicyFederatedNetwork } from "../types/cortex-config";
import {
  NetworkKeyring,
  type EncryptionMode,
  type NetworkKey,
} from "./payload-encryption";

/** Default key id when a network sets `payload_key` but no `payload_key_id`. */
export function defaultKeyId(networkId: string): string {
  return `${networkId}/k1`;
}

/** Decode a network's `payload_key` (base64, 32 bytes) into a {@link NetworkKey},
 *  or `undefined` when the network carries no key. */
export function networkKeyFromConfig(
  network: PolicyFederatedNetwork,
): NetworkKey | undefined {
  if (network.payload_key === undefined) return undefined;
  const key = new Uint8Array(Buffer.from(network.payload_key, "base64"));
  // Schema already refines length === 32; guard defensively without throwing on
  // the hot path (a wrong length here means a schema bypass — skip the key).
  if (key.length !== 32) return undefined;
  const kid = network.payload_key_id ?? defaultKeyId(network.id);
  return { kid, key };
}

/**
 * Build the member's keyring from config: one current key per network that
 * declares a `payload_key`. (Grace-window previous keys arrive via PR5b's
 * delivery channel at runtime; config carries the current key.)
 */
export function buildNetworkKeyring(
  networks: readonly PolicyFederatedNetwork[],
): NetworkKeyring {
  const entries: { net: string; keys: NetworkKey[] }[] = [];
  for (const network of networks) {
    const k = networkKeyFromConfig(network);
    if (k !== undefined) entries.push({ net: network.id, keys: [k] });
  }
  return new NetworkKeyring(entries);
}

/** The seal decision for an outbound federated envelope to a given target. */
export interface NetworkSealPolicy {
  /** Network id — stamped into `extensions.enc.net`. */
  readonly net: string;
  /** Posture: `off` never seals; `enabled`/`required` seal. */
  readonly mode: EncryptionMode;
  /** The current sealing key, or `undefined` when `payload_key` is absent
   *  (mode enabled/required + no key ⇒ loud-but-not-fatal warning, cleartext). */
  readonly key?: NetworkKey;
}

/**
 * Map each peer principal id → the seal policy for the network it lives on, so
 * the publish path resolves "should I seal this `federated.{principal}.…`
 * envelope, and with which network key" from the subject's target-principal
 * segment alone (no per-recipient resolution — that is the whole per-network-key
 * win). A principal listed on more than one network resolves to the FIRST
 * declaring network (deterministic by config order).
 *
 * Only networks with `encryption` set to `enabled`/`required` produce a sealing
 * entry; `off` (or unset) networks are omitted so the publish path leaves their
 * traffic cleartext exactly as today.
 */
export function buildSealPolicyByPrincipal(
  networks: readonly PolicyFederatedNetwork[],
): Map<string, NetworkSealPolicy> {
  const byPrincipal = new Map<string, NetworkSealPolicy>();
  for (const network of networks) {
    const mode = (network.encryption ?? "off");
    if (mode === "off") continue;
    const policy: NetworkSealPolicy = {
      net: network.id,
      mode,
      ...(networkKeyFromConfig(network) !== undefined && {
        key: networkKeyFromConfig(network),
      }),
    };
    for (const peer of network.peers) {
      if (!byPrincipal.has(peer.principal_id)) {
        byPrincipal.set(peer.principal_id, policy);
      }
    }
  }
  return byPrincipal;
}
