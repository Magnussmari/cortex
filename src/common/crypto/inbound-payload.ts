/**
 * M3 (cortex#1241, ADR-0019 §7 transition window) — the receive-side primitive
 * that turns a (possibly-sealed) inbound federated envelope into a cleartext one,
 * applying the per-network transition-window posture.
 *
 * **Verify-before-decrypt is the CALLER's responsibility.** This helper must be
 * invoked only AFTER `verifySignedByChain` has accepted the envelope — the
 * `signed_by` chain covers the ciphertext (encrypt-then-sign), so verification
 * runs on the sealed form and decryption follows. Calling this before verify
 * would decrypt unverified bytes (the cryptographic-doom anti-pattern).
 *
 * Transition window (ADR-0019 §7 / design §7):
 *   - `enabled` — ACCEPT BOTH: a cleartext-but-signed inbound passes through; a
 *     sealed inbound is opened. A sealed envelope whose key is unavailable, or
 *     that fails to open, is rejected (loud) — never silently dropped-as-cleartext.
 *   - `required` — cleartext federated inbound is REJECTED; only sealed is accepted.
 *   - `off` — accept both; open a sealed envelope opportunistically if a key is held.
 */

import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  NetworkKeyUnavailableError,
  NetworkKeyring,
  isSealedPayload,
  openPayload,
  type EncryptionMode,
} from "./payload-encryption";

/** Outcome of {@link openInboundEnvelope}. */
export type InboundOpenOutcome =
  | {
      /** Envelope arrived cleartext and is accepted (transition / off). */
      status: "cleartext";
      envelope: Envelope;
    }
  | {
      /** Envelope arrived sealed and was successfully decrypted. */
      status: "opened";
      envelope: Envelope;
    }
  | {
      /** Envelope is rejected; `reason` says why. The (still-sealed or cleartext)
       *  envelope is returned for audit/logging, never for processing. */
      status: "rejected";
      reason: InboundRejectReason;
      envelope: Envelope;
    };

export type InboundRejectReason =
  /** `required` network received an unsealed federated payload. */
  | "cleartext_in_required"
  /** Sealed, but the local keyring lacks the named network key. */
  | "key_unavailable"
  /** Sealed, key held, but AEAD open failed (wrong key / tamper / header lift). */
  | "open_failed";

/** Resolve a (possibly-sealed) inbound federated envelope under a network's
 *  transition-window posture. See file header. */
export async function openInboundEnvelope(
  envelope: Envelope,
  keyring: NetworkKeyring,
  opts: { mode: EncryptionMode },
): Promise<InboundOpenOutcome> {
  if (!isSealedPayload(envelope)) {
    if (opts.mode === "required") {
      // A `required` network must not accept cleartext federated payloads
      // (ADR-0019 §7 / Q6 secure default). Reject loudly.
      return { status: "rejected", reason: "cleartext_in_required", envelope };
    }
    // Transition window (`enabled`) / `off`: cleartext-but-signed is accepted.
    return { status: "cleartext", envelope };
  }

  // Sealed inbound — open it.
  try {
    const opened = await openPayload(envelope, keyring);
    return { status: "opened", envelope: opened };
  } catch (err) {
    if (err instanceof NetworkKeyUnavailableError) {
      return { status: "rejected", reason: "key_unavailable", envelope };
    }
    return { status: "rejected", reason: "open_failed", envelope };
  }
}
