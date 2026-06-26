/**
 * ADR-0018 PR5b (#1240) — member-side fetch + unseal of the leaf secret.
 *
 * The plug-and-play half (#1240 locked constraint): `cortex network join`
 * AUTO-fetches the sealed blob from the member PoP-read endpoint
 * (`GET /admission-requests/mine`), decrypts it with the joiner's OWN seed, and
 * renders the leaf — the user never copies/pastes a secret.
 *
 * This module is that primitive, transport-injectable so the join wiring + the
 * tests drive it without a live registry. It:
 *   1. signs a proof-of-possession read claim with the member's seed (the
 *      signature IS the authorization — no admin key),
 *   2. GETs `/admission-requests/mine`,
 *   3. selects the ADMITTED row for the target network that carries a sealed
 *      blob,
 *   4. opens the `crypto_box_seal` with the member's raw ed25519 seed
 *      ({@link openSealed}) and decodes the {@link LeafSecretEnvelope}.
 *
 * Returns the leaf PSK + user (and, once M3 lands, the same call surfaces the
 * payload key from the SAME envelope). Fails SOFT-CLOSED: every failure is a
 * typed `{ ok: false, reason }` so the join can fall through to its existing
 * config/flag/oob behaviour rather than aborting.
 */

import { canonicalJSON } from "./signing";
import { openSealed } from "../crypto/seal-to-principal";
import { decodeLeafSecretEnvelope } from "./sealed-leaf-secret";
import {
  signClaimWithSeed,
  rawEd25519SeedFromNkeySeed,
  type StackIdentityMaterial,
} from "../../bus/stack-provisioning";

/** The minimal admission-row shape the member PoP-read returns. */
interface AdmissionMineRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  network_id: string | null;
  status: string;
  sealed_secret: string | null;
}

/** Injectable fetch (defaults to `globalThis.fetch`) so tests stay hermetic. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface FetchSealedLeafSecretInput {
  /** Registry base URL (e.g. the descriptor host). */
  registryUrl: string;
  /** The network whose leaf PSK we want. */
  networkId: string;
  /** The joining principal id (echoed into the signed claim). */
  principalId: string;
  /** The member's identity material — pubkey + seed (used to sign + unseal). */
  material: StackIdentityMaterial;
  /** Injected transport (tests). Production omits → `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Injected clock (tests). Production omits → `Date`. */
  now?: () => Date;
}

export type FetchSealedLeafSecretResult =
  | { ok: true; leafPsk: string; leafUser: string; payloadKey?: string }
  | { ok: false; reason: string };

/**
 * Fetch + unseal this member's leaf secret for `networkId`. SOFT-CLOSED on every
 * failure path (no throw): the join caller treats `{ ok: false }` as "no sealed
 * secret available — fall through".
 */
export async function fetchSealedLeafSecret(
  input: FetchSealedLeafSecretInput,
): Promise<FetchSealedLeafSecretResult> {
  const fetchImpl: FetchLike = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? (() => new Date());

  // 1. Sign the PoP read claim with the member's own key.
  const claim = {
    principal_id: input.principalId,
    peer_pubkey: input.material.pubkeyB64,
    issued_at: now().toISOString(),
  };
  let header: string;
  try {
    const sig = await signClaimWithSeed(
      input.material.seed,
      new TextEncoder().encode(canonicalJSON(claim)),
    );
    header = JSON.stringify({ claim, signature: sig });
  } catch (err) {
    return { ok: false, reason: `failed to sign PoP read claim: ${errText(err)}` };
  }

  // 2. GET /admission-requests/mine.
  let rows: AdmissionMineRow[];
  try {
    const url = `${input.registryUrl.replace(/\/+$/, "")}/admission-requests/mine`;
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-pop-signed": header },
    });
    if (!resp.ok) {
      return { ok: false, reason: `registry mine-read failed (HTTP ${resp.status.toString()})` };
    }
    rows = (await resp.json()) as AdmissionMineRow[];
  } catch (err) {
    return { ok: false, reason: `registry mine-read errored: ${errText(err)}` };
  }

  // 3. Select the ADMITTED row for this network carrying a sealed blob.
  if (!Array.isArray(rows)) {
    return { ok: false, reason: "registry mine-read returned a non-array body" };
  }
  const row = rows.find(
    (r) => r.network_id === input.networkId && r.status === "ADMITTED" && typeof r.sealed_secret === "string" && r.sealed_secret.length > 0,
  );
  if (!row?.sealed_secret) {
    return {
      ok: false,
      reason: `no admitted+sealed admission row for network "${input.networkId}" (not yet admitted, or no secret delivered)`,
    };
  }

  // 4. Open the sealed box with the member's raw seed + decode the envelope.
  try {
    const rawSeed = rawEd25519SeedFromNkeySeed(input.material.seed);
    const plaintextBytes = await openSealed(row.sealed_secret, rawSeed);
    const env = decodeLeafSecretEnvelope(new TextDecoder().decode(plaintextBytes));
    return {
      ok: true,
      leafPsk: env.leaf_psk,
      leafUser: env.leaf_user,
      ...(env.payload_key !== undefined && { payloadKey: env.payload_key }),
    };
  } catch (err) {
    // Generic — never echo seed/ciphertext/plaintext.
    return { ok: false, reason: `failed to open sealed leaf secret: ${errText(err)}` };
  }
}

/** Error → message, never echoing secret-bearing inputs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
