/**
 * ADR-0018 PR5b (#1240) — the SEALED secret envelope (the M3 seam).
 *
 * The hub-admin seals a small JSON envelope (not a bare PSK) to the member's
 * pubkey, so the SAME sealed-delivery slot can carry MORE THAN the leaf PSK
 * without a wire/schema change. PR5b populates `leaf_psk` + `leaf_user`. The
 * per-network M3 payload key (#1246, ADR-0019) rides the SAME envelope later as
 * `payload_key` — `cortex network secret add-member` seals both, `rotate` /
 * `revoke-member` cover both, and the member-side decode already tolerates the
 * extra field. That is the "one extra sealed blob via the same path" seam the
 * issue asks PR5b to leave clean.
 *
 * The registry never sees this — it only carries the OPAQUE `crypto_box_seal`
 * ciphertext of the JSON below.
 */

/** Envelope schema version. Bumped only on a breaking shape change. */
export const LEAF_SECRET_ENVELOPE_VERSION = 1;

/**
 * The plaintext sealed to a member's pubkey. JSON, UTF-8, then
 * {@link sealToPrincipal}. Keep it small + flat — `crypto_box_seal` has no size
 * problem here, but the registry bounds the ciphertext (validate.isValidSealedSecret).
 */
export interface LeafSecretEnvelope {
  /** Envelope version (currently {@link LEAF_SECRET_ENVELOPE_VERSION}). */
  v: number;
  /** The per-member leaf PSK (base64url). The transport secret (ADR-0018 Q2). */
  leaf_psk: string;
  /**
   * The userinfo USER paired with `leaf_psk` — matches the hub's
   * `authorization { user, password }` entry. Defaults to the member's
   * principal id at mint time.
   */
  leaf_user: string;
  /**
   * M3 SEAM (#1246 / ADR-0019) — the per-network payload key, sealed alongside
   * the leaf PSK once M3 lands. OPTIONAL + absent in PR5b. Decoders MUST tolerate
   * its presence (and its absence). Its config field lives in M3, NOT here.
   */
  payload_key?: string;
}

/** Encode a {@link LeafSecretEnvelope} to the UTF-8 JSON that gets sealed. */
export function encodeLeafSecretEnvelope(
  fields: Omit<LeafSecretEnvelope, "v"> & { v?: number },
): string {
  const env: LeafSecretEnvelope = {
    v: fields.v ?? LEAF_SECRET_ENVELOPE_VERSION,
    leaf_psk: fields.leaf_psk,
    leaf_user: fields.leaf_user,
    ...(fields.payload_key !== undefined && { payload_key: fields.payload_key }),
  };
  return JSON.stringify(env);
}

/**
 * Decode + validate the UNSEALED plaintext into a {@link LeafSecretEnvelope}.
 * Fails closed on a malformed envelope (the member would otherwise render a leaf
 * with a junk secret). Tolerates the future `payload_key` field. The error
 * message NEVER echoes the plaintext (it may carry secret material).
 */
export function decodeLeafSecretEnvelope(plaintext: string): LeafSecretEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new Error("sealed-leaf-secret: unsealed payload is not valid JSON", { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sealed-leaf-secret: unsealed payload must be a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.leaf_psk !== "string" || p.leaf_psk.length === 0) {
    throw new Error("sealed-leaf-secret: unsealed payload missing leaf_psk");
  }
  if (typeof p.leaf_user !== "string" || p.leaf_user.length === 0) {
    throw new Error("sealed-leaf-secret: unsealed payload missing leaf_user");
  }
  if (p.payload_key !== undefined && typeof p.payload_key !== "string") {
    throw new Error("sealed-leaf-secret: payload_key must be a string when present");
  }
  return {
    v: typeof p.v === "number" ? p.v : LEAF_SECRET_ENVELOPE_VERSION,
    leaf_psk: p.leaf_psk,
    leaf_user: p.leaf_user,
    ...(typeof p.payload_key === "string" && { payload_key: p.payload_key }),
  };
}
