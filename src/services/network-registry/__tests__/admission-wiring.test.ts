/**
 * ADR-0018 PR5a — admission-gate wiring tests.
 *
 * Gap A — network_id on the admission request:
 *   - a register carrying `network_id` persists it on the PENDING row
 *   - idempotency is now per-network: the SAME stack requesting TWO networks
 *     creates TWO distinct rows; re-requesting the SAME network is idempotent
 *   - a network-less register still dedupes on (principal, peer)
 *
 * Gap C — member proof-of-possession read (`GET /admission-requests/mine`):
 *   - a member who signs with their REGISTERED key reads ONLY their own rows
 *   - the response carries a `sealed_secret` slot (null in PR5a)
 *   - a wrong-key signature → 401; a missing header → 400 (no metadata leak)
 *   - rows are scoped to the proven pubkey — never another member's queue
 */

import { describe, test, expect, beforeEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  makeSignedAdminRead,
  makeSignedAdminDecision,
  randomNonce,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import { canonicalJSON, signEd25519 } from "../src/signing";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let admin: PrincipalKey;
let principal: PrincipalKey;

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

async function get(path: string, headers: Record<string, string> = {}, e: Env = env): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers }), e);
}

/** Admin-list PENDING admission requests (helper for Gap-A assertions). */
async function listPending(): Promise<AdmissionRequest[]> {
  const read = await makeSignedAdminRead(admin);
  const res = await get("/admission-requests?status=PENDING", {
    "x-admin-signed": JSON.stringify(read),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AdmissionRequest[];
}

/**
 * Build a member proof-of-possession read for `GET /admission-requests/mine`.
 * Signed with the member's REGISTERED key (the signature IS the authorization).
 */
async function makeSignedMineRead(
  principalId: string,
  memberKey: PrincipalKey,
  opts: { peerPubkeyOverride?: string; signWith?: PrincipalKey; issuedAt?: string } = {},
): Promise<{ claim: { principal_id: string; peer_pubkey: string; issued_at: string }; signature: string }> {
  const claim = {
    principal_id: principalId,
    peer_pubkey: opts.peerPubkeyOverride ?? memberKey.publicKeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
  };
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signer = opts.signWith ?? memberKey;
  const signature = await signEd25519(signer.privateKeyB64, message);
  return { claim, signature };
}

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  admin = await makePrincipalKey();
  principal = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64,
    ENVIRONMENT: "test",
  };
});

// =============================================================================
// Gap A — network_id persisted + per-network idempotency
// =============================================================================

describe("ADR-0018 Gap-A — network_id on the admission request", () => {
  test("a register naming a network persists network_id on the PENDING row", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    expect(res.status).toBe(201);

    const pending = await listPending();
    const alice = pending.filter((r) => r.principal_id === "alice");
    expect(alice.length).toBe(1);
    expect(alice[0]!.network_id).toBe("net-a");
  });

  test("the same stack requesting TWO networks creates TWO distinct rows", async () => {
    await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-b" }),
    );

    const pending = await listPending();
    const alice = pending.filter((r) => r.principal_id === "alice");
    expect(alice.length).toBe(2);
    expect(alice.map((r) => r.network_id).sort()).toEqual(["net-a", "net-b"]);
    // Distinct request_ids — the second network did not collide with the first.
    expect(new Set(alice.map((r) => r.request_id)).size).toBe(2);
  });

  test("re-requesting the SAME network is idempotent (same request_id)", async () => {
    const r1 = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    expect(r1.status).toBe(201);
    const first = (await listPending()).find((r) => r.principal_id === "alice" && r.network_id === "net-a");
    expect(first).toBeDefined();

    const r2 = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    expect(r2.status).toBe(201);

    const aliceNetA = (await listPending()).filter(
      (r) => r.principal_id === "alice" && r.network_id === "net-a",
    );
    expect(aliceNetA.length).toBe(1);
    expect(aliceNetA[0]!.request_id).toBe(first!.request_id);
  });

  test("a network-less register still dedupes on (principal, peer)", async () => {
    await post("/principals/alice/register", await makeSignedRegistration("alice", principal));
    await post("/principals/alice/register", await makeSignedRegistration("alice", principal));

    const alice = (await listPending()).filter((r) => r.principal_id === "alice");
    expect(alice.length).toBe(1);
    expect(alice[0]!.network_id).toBeNull();
  });

  test("a malformed network_id is rejected (signed claim, 400)", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "Bad_Network" }),
    );
    expect(res.status).toBe(400);
  });
});

// =============================================================================
// Gap C — member proof-of-possession read endpoint
// =============================================================================

describe("ADR-0018 Gap-C — GET /admission-requests/mine (member PoP read)", () => {
  test("a member signing with their registered key reads their own rows", async () => {
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-a" }),
    );

    const read = await makeSignedMineRead("carol", principal);
    const res = await get("/admission-requests/mine", { "x-pop-signed": JSON.stringify(read) });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as (AdmissionRequest & { sealed_secret: string | null })[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.principal_id).toBe("carol");
    expect(rows[0]!.peer_pubkey).toBe(principal.publicKeyB64);
    expect(rows[0]!.status).toBe("PENDING");
    // PR5a — the sealed_secret slot is present but empty (PR5b populates it).
    expect(rows[0]!).toHaveProperty("sealed_secret");
    expect(rows[0]!.sealed_secret).toBeNull();
  });

  test("reflects status across networks after an admit", async () => {
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-a" }),
    );
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-b" }),
    );
    // Admit the net-a request.
    const pending = (await listPending()).filter((r) => r.principal_id === "carol");
    const netA = pending.find((r) => r.network_id === "net-a")!;
    const decision = await makeSignedAdminDecision(netA.request_id, "admit", admin);
    await post(`/admission-requests/${netA.request_id}/admit`, decision);

    const read = await makeSignedMineRead("carol", principal);
    const res = await get("/admission-requests/mine", { "x-pop-signed": JSON.stringify(read) });
    const rows = (await res.json()) as AdmissionRequest[];
    expect(rows.length).toBe(2);
    const byNet = new Map(rows.map((r) => [r.network_id, r.status]));
    expect(byNet.get("net-a")).toBe("ADMITTED");
    expect(byNet.get("net-b")).toBe("PENDING");
  });

  test("returns ONLY the caller's own rows, never another member's", async () => {
    const other = await makePrincipalKey();
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-a" }),
    );
    await post(
      "/principals/dave/register",
      await makeSignedRegistration("dave", other, { networkId: "net-a" }),
    );

    const read = await makeSignedMineRead("carol", principal);
    const res = await get("/admission-requests/mine", { "x-pop-signed": JSON.stringify(read) });
    const rows = (await res.json()) as AdmissionRequest[];
    expect(rows.every((r) => r.peer_pubkey === principal.publicKeyB64)).toBe(true);
    expect(rows.some((r) => r.principal_id === "dave")).toBe(false);
  });

  test("a signature from the WRONG key → 401 (signature IS the authorization)", async () => {
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-a" }),
    );
    const attacker = await makePrincipalKey();
    // Claims carol's registered pubkey but signs with the attacker's key.
    const forged = await makeSignedMineRead("carol", principal, { signWith: attacker });
    const res = await get("/admission-requests/mine", { "x-pop-signed": JSON.stringify(forged) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  test("a missing x-pop-signed header → 400 (no metadata leak)", async () => {
    const res = await get("/admission-requests/mine");
    expect(res.status).toBe(400);
  });

  test("a malformed x-pop-signed header → 400", async () => {
    const res = await get("/admission-requests/mine", { "x-pop-signed": "{not json" });
    expect(res.status).toBe(400);
  });

  test("an out-of-skew read token → 400", async () => {
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-a" }),
    );
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stale = await makeSignedMineRead("carol", principal, { issuedAt: old });
    const res = await get("/admission-requests/mine", { "x-pop-signed": JSON.stringify(stale) });
    expect(res.status).toBe(400);
  });

  test("requires no admin key — works with no allowlist configured", async () => {
    // The member PoP read is NOT an admin path: it must function even when the
    // registry has no admin allowlist (the signature is the only authority).
    const reg = await makeRegistryKey();
    const noAdmin: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
    await post(
      "/principals/carol/register",
      await makeSignedRegistration("carol", principal, { networkId: "net-a" }),
      noAdmin,
    );
    const read = await makeSignedMineRead("carol", principal);
    const res = await get(
      "/admission-requests/mine",
      { "x-pop-signed": JSON.stringify(read) },
      noAdmin,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as AdmissionRequest[];
    expect(rows.length).toBe(1);
  });

  test("'mine' is not swallowed by the :request_id param route", async () => {
    // A bare GET /admission-requests/mine must hit the PoP route (400 missing
    // header), NOT the admin :request_id route (which would 400 invalid_request_id
    // or, with a valid-looking id, require an admin header).
    const res = await get("/admission-requests/mine");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("x-pop-signed header required");
  });
});
