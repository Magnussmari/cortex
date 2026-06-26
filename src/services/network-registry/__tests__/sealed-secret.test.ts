/**
 * ADR-0018 PR5b (#1240) — hub-admin sealed-secret delivery + revoke endpoints.
 *
 * Trust-path coverage (the secret-delivery mechanism + the LEAF PSK slot):
 *   sealed-secret write (hub-admin authority, Q5):
 *     - allowlisted hub-admin writes the opaque blob onto an ADMITTED row → 200,
 *       and the member PoP-read (/mine) then serves it
 *     - the admit route mints NOTHING: sealed_secret is null right after admit,
 *       only the hub-admin write populates it (two separable authorities)
 *     - write against a non-ADMITTED (PENDING) row → 409 not_admitted
 *     - write against an unknown request → 404
 *     - forged signature → 401 ; non-allowlisted key → 403 ; no allowlist → 503
 *     - replayed nonce → 409
 *     - request_id path/body mismatch → 400 ; oversized/non-base64 blob → 400
 *     - HUB-admin allowlist is HONOURED over registry-admin (separable): a
 *       registry-admin-only key cannot write when a distinct hub allowlist is set
 *     - collapse case: with only REGISTRY_ADMIN_PUBKEYS set, that key CAN write
 *   rotate:
 *     - a second sealed-secret write REPLACES the blob in place
 *   revoke (Q6):
 *     - hub-admin revoke of an ADMITTED row → 200 REVOKED + sealed_secret cleared,
 *       and the member PoP-read no longer serves the blob
 *     - revoke of a never-admitted (PENDING) row → 409 not_admitted
 *     - revoke is idempotent (second revoke → 200 REVOKED)
 *   secret hygiene:
 *     - the opaque blob is the EXACT bytes written (registry never mutates it)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  randomNonce,
  resetStores,
  makeSignedAdminRead,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey;
let hubAdmin: PrincipalKey;
let principal: PrincipalKey;

// A representative opaque sealed blob — the registry treats it as bytes; we only
// need it to be valid base64 within the size bound. (The real CLI produces a
// libsodium crypto_box_seal; the registry never decodes it.)
const SEALED = btoa("sealed-leaf-psk-opaque-ciphertext-v1");

async function post(path: string, body: unknown, e: Env = env): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    e,
  );
}

async function get(path: string, e: Env = env, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

async function registerPending(principalId: string): Promise<AdmissionRequest> {
  const body = await makeSignedRegistration(principalId, principal, {
    stacks: [{ stack_id: `${principalId}/main`, stack_pubkey: principal.publicKeyB64 }],
    networkId: "metafactory",
  });
  const res = await post(`/principals/${principalId}/register`, body);
  expect(res.status).toBe(201);
  const signedRead = await makeSignedAdminRead(admin);
  const listRes = await get(`/admission-requests?status=PENDING`, env, {
    "x-admin-signed": JSON.stringify(signedRead),
  });
  const list = (await listRes.json()) as AdmissionRequest[];
  const found = list.find((r) => r.principal_id === principalId);
  expect(found).toBeDefined();
  return found!;
}

async function makeAdmitDecision(requestId: string, adminKey: PrincipalKey) {
  const claim = {
    request_id: requestId,
    decision: "admit" as const,
    admin_pubkey: adminKey.publicKeyB64,
    issued_at: new Date().toISOString(),
    nonce: randomNonce(),
  };
  const signature = await signEd25519(adminKey.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

async function admit(requestId: string): Promise<void> {
  const res = await post(`/admission-requests/${requestId}/admit`, await makeAdmitDecision(requestId, admin));
  expect(res.status).toBe(200);
}

async function makeSealedWrite(
  requestId: string,
  signer: PrincipalKey,
  opts: { sealed?: string; issuedAt?: string; nonce?: string; pubkeyOverride?: string } = {},
) {
  const claim = {
    request_id: requestId,
    sealed_secret: opts.sealed ?? SEALED,
    hub_admin_pubkey: opts.pubkeyOverride ?? signer.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

async function makeRevoke(
  requestId: string,
  signer: PrincipalKey,
  opts: { issuedAt?: string; nonce?: string; pubkeyOverride?: string } = {},
) {
  const claim = {
    request_id: requestId,
    hub_admin_pubkey: opts.pubkeyOverride ?? signer.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await signEd25519(signer.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  return { claim, signature };
}

/** Member PoP-read of their own admission rows. Returns the row for the network. */
async function readMine(networkId: string): Promise<AdmissionRequest | undefined> {
  const claim = {
    principal_id: "alice",
    peer_pubkey: principal.publicKeyB64,
    issued_at: new Date().toISOString(),
  };
  const signature = await signEd25519(principal.privateKeyB64, new TextEncoder().encode(canonicalJSON(claim)));
  const res = await get(`/admission-requests/mine`, env, { "x-pop-signed": JSON.stringify({ claim, signature }) });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as AdmissionRequest[];
  return rows.find((r) => r.network_id === networkId);
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  hubAdmin = await makePrincipalKey();
  principal = await makePrincipalKey();
  // Distinct authorities by default: registry-admin admits, hub-admin delivers.
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    REGISTRY_HUB_ADMIN_PUBKEYS: hubAdmin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Sealed-secret write — the secret-delivery mechanism
// =============================================================================

describe("POST /admission-requests/:id/sealed-secret — happy path", () => {
  test("admit mints NOTHING: sealed_secret is null until the hub-admin writes it", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const beforeWrite = await readMine("metafactory");
    expect(beforeWrite?.status).toBe("ADMITTED");
    expect(beforeWrite?.sealed_secret).toBeNull();
  });

  test("hub-admin writes the opaque blob onto an ADMITTED row; /mine serves it verbatim", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);

    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, hubAdmin));
    expect(res.status).toBe(200);
    const updated = (await res.json()) as AdmissionRequest;
    expect(updated.sealed_secret).toBe(SEALED);
    expect(updated.status).toBe("ADMITTED");

    const mine = await readMine("metafactory");
    expect(mine?.sealed_secret).toBe(SEALED); // exact bytes — registry never mutates it
  });

  test("rotate REPLACES the blob in place", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, hubAdmin));
    const next = btoa("rotated-leaf-psk-v2");
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, hubAdmin, { sealed: next }));
    expect(res.status).toBe(200);
    const mine = await readMine("metafactory");
    expect(mine?.sealed_secret).toBe(next);
  });
});

describe("POST /admission-requests/:id/sealed-secret — guards", () => {
  test("write against a PENDING (not-admitted) row → 409 not_admitted", async () => {
    const req = await registerPending("alice");
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, hubAdmin));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("not_admitted");
  });

  test("write against an unknown request → 404", async () => {
    const unknown = "deadbeef".repeat(4); // 32 hex chars, valid grammar, no row
    const res = await post(`/admission-requests/${unknown}/sealed-secret`, await makeSealedWrite(unknown, hubAdmin));
    expect(res.status).toBe(404);
  });

  test("forged signature → 401", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    // Claim declares the hub-admin pubkey but is signed by a different key.
    const attacker = await makePrincipalKey();
    const body = await makeSealedWrite(req.request_id, attacker, { pubkeyOverride: hubAdmin.publicKeyB64 });
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, body);
    expect(res.status).toBe(401);
  });

  test("non-allowlisted hub-admin key → 403", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const stranger = await makePrincipalKey();
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, stranger));
    expect(res.status).toBe(403);
  });

  test("no hub-admin (nor registry-admin) allowlist → 503 fail-closed", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const noAdminEnv: Env = { ...env, REGISTRY_ADMIN_PUBKEYS: "", REGISTRY_HUB_ADMIN_PUBKEYS: "" };
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, hubAdmin), noAdminEnv);
    expect(res.status).toBe(503);
  });

  test("replayed nonce → 409", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const body = await makeSealedWrite(req.request_id, hubAdmin);
    const first = await post(`/admission-requests/${req.request_id}/sealed-secret`, body);
    expect(first.status).toBe(200);
    const replay = await post(`/admission-requests/${req.request_id}/sealed-secret`, body);
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error: string }).error).toBe("nonce_replayed");
  });

  test("request_id body/path mismatch → 400", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const other = "abcd1234".repeat(4);
    const body = await makeSealedWrite(other, hubAdmin); // claim.request_id != path
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, body);
    expect(res.status).toBe(400);
  });

  test("non-base64 / oversized blob → 400", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const bad = await makeSealedWrite(req.request_id, hubAdmin, { sealed: "not valid base64 !!!" });
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, bad);
    expect(res.status).toBe(400);
  });
});

describe("two separable authorities (Q5)", () => {
  test("a registry-admin-only key CANNOT write the sealed secret when a distinct hub allowlist is set", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    // `admin` is on REGISTRY_ADMIN_PUBKEYS but NOT REGISTRY_HUB_ADMIN_PUBKEYS.
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, admin));
    expect(res.status).toBe(403);
  });

  test("collapse case: with only REGISTRY_ADMIN_PUBKEYS set, that key can deliver (hub authority falls back)", async () => {
    const collapsedEnv: Env = { ...env, REGISTRY_HUB_ADMIN_PUBKEYS: "" };
    const req = await registerPending("alice");
    // admit + deliver both by `admin` (one principal = both authorities).
    await post(`/admission-requests/${req.request_id}/admit`, await makeAdmitDecision(req.request_id, admin), collapsedEnv);
    const res = await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, admin), collapsedEnv);
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Revoke — cut the member (Q6)
// =============================================================================

describe("POST /admission-requests/:id/revoke", () => {
  test("hub-admin revoke of an ADMITTED+sealed row → REVOKED + blob cleared; /mine stops serving it", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    await post(`/admission-requests/${req.request_id}/sealed-secret`, await makeSealedWrite(req.request_id, hubAdmin));

    const res = await post(`/admission-requests/${req.request_id}/revoke`, await makeRevoke(req.request_id, hubAdmin));
    expect(res.status).toBe(200);
    const revoked = (await res.json()) as AdmissionRequest;
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.sealed_secret).toBeNull();

    const mine = await readMine("metafactory");
    expect(mine?.status).toBe("REVOKED");
    expect(mine?.sealed_secret).toBeNull();
  });

  test("revoke of a never-admitted (PENDING) row → 409 not_admitted", async () => {
    const req = await registerPending("alice");
    const res = await post(`/admission-requests/${req.request_id}/revoke`, await makeRevoke(req.request_id, hubAdmin));
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("not_admitted");
  });

  test("revoke is idempotent — a second revoke → 200 REVOKED", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const first = await post(`/admission-requests/${req.request_id}/revoke`, await makeRevoke(req.request_id, hubAdmin));
    expect(first.status).toBe(200);
    const second = await post(`/admission-requests/${req.request_id}/revoke`, await makeRevoke(req.request_id, hubAdmin));
    expect(second.status).toBe(200);
    expect((await second.json() as AdmissionRequest).status).toBe("REVOKED");
  });

  test("revoke requires hub-admin authority: a non-allowlisted key → 403", async () => {
    const req = await registerPending("alice");
    await admit(req.request_id);
    const stranger = await makePrincipalKey();
    const res = await post(`/admission-requests/${req.request_id}/revoke`, await makeRevoke(req.request_id, stranger));
    expect(res.status).toBe(403);
  });
});
