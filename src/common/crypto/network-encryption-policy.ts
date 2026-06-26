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
 * **Self-addressed federated subjects (cortex#1246 BLOCKER fix).** A federated
 * *Offer* (and probe-echo Offer) is published on a SELF-addressed subject —
 * `federated.{ownPrincipal}.{ownStack}.tasks.<cap>` (`review-subjects.ts`,
 * `probe-responder.ts`) — so the publish path's `subject.split(".")[1]` is the
 * offerer's OWN principal id, which is never in its own `peers[]`. Keyed by peers
 * alone, that resolves to `undefined` and the Offer would federate in CLEARTEXT,
 * unsealed and unwarned — contradicting the "ALL federated payloads (Direct /
 * Delegate / Offer) sealed" invariant (ADR-0019). To close that, when
 * `ownPrincipalId` is supplied we ALSO map it → its own network's seal policy, so
 * a self-addressed federated egress seals with the network's `K`.
 *
 * **Multi-network ambiguity.** A self-addressed subject does NOT name the
 * network, so when the stack is on MORE THAN ONE encryption-enabled network the
 * correct `K` cannot be resolved from the subject alone. We deliberately leave
 * `ownPrincipalId` UNMAPPED in that case rather than seal with a guessed (wrong)
 * network's key — the publish path warns-once on the resulting cleartext egress
 * so the gap is visible, never silent. Single encryption-enabled network (the
 * metafactory deployment today) is unambiguous and seals correctly. Resolving
 * the network for a self-addressed subject under multi-network federation is a
 * tracked follow-up.
 *
 * Only networks with `encryption` set to `enabled`/`required` produce a sealing
 * entry; `off` (or unset) networks are omitted so the publish path leaves their
 * traffic cleartext exactly as today.
 */
export function buildSealPolicyByPrincipal(
  networks: readonly PolicyFederatedNetwork[],
  ownPrincipalId?: string,
): Map<string, NetworkSealPolicy> {
  const byPrincipal = new Map<string, NetworkSealPolicy>();
  const encryptionEnabled: NetworkSealPolicy[] = [];
  for (const network of networks) {
    const mode = (network.encryption ?? "off");
    if (mode === "off") continue;
    const key = networkKeyFromConfig(network);
    const policy: NetworkSealPolicy = {
      net: network.id,
      mode,
      ...(key !== undefined && { key }),
    };
    encryptionEnabled.push(policy);
    for (const peer of network.peers) {
      if (!byPrincipal.has(peer.principal_id)) {
        byPrincipal.set(peer.principal_id, policy);
      }
    }
  }
  // Self-addressed seal (cortex#1246): map the OWN principal → its network's
  // policy so a federated Offer published on `federated.{ownPrincipal}.…` seals.
  // Only the unambiguous single-encryption-network case resolves here; multiple
  // encryption-enabled networks are left unmapped (never seal with the wrong K —
  // the publish path warns-once on that cleartext egress).
  const soleEncryptionPolicy =
    encryptionEnabled.length === 1 ? encryptionEnabled[0] : undefined;
  if (
    ownPrincipalId !== undefined &&
    soleEncryptionPolicy !== undefined &&
    !byPrincipal.has(ownPrincipalId)
  ) {
    byPrincipal.set(ownPrincipalId, soleEncryptionPolicy);
  }
  return byPrincipal;
}

/**
 * Count the encryption-enabled (`enabled`/`required`) networks in a roster.
 * The publish path uses this to detect the multi-network self-addressed-Offer
 * ambiguity that {@link buildSealPolicyByPrincipal} leaves unmapped, so it can
 * warn-once instead of silently federating an Offer in the clear (cortex#1246).
 */
export function countEncryptionEnabledNetworks(
  networks: readonly PolicyFederatedNetwork[],
): number {
  let n = 0;
  for (const network of networks) {
    if ((network.encryption ?? "off") !== "off") n += 1;
  }
  return n;
}
