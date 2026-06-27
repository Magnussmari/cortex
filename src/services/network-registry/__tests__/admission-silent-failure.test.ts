/**
 * cortex#1263 — the admission-request hook must NOT fail silently.
 *
 * The register handler upserts a PENDING admission_requests row AFTER a
 * successful registration, inside a try/catch that deliberately does NOT reject
 * the registration (that part is correct — the principal record is already
 * committed and the upsert is idempotent). The bug: when the upsert threw, the
 * failure was swallowed entirely — the principal landed in `principals` with NO
 * PENDING row, the admin saw nothing to admit, and the registrant believed they
 * were queued (confirmed live: `chuvala`).
 *
 * The fix keeps NOT rejecting the registration but makes the failure VISIBLE:
 *   1. a loud, structured `system.error` log line (greppable token +
 *      principal_id / peer_pubkey / network_id / scope / error context);
 *   2. a non-fatal `admission_request: "failed"` + `warning` flag on the
 *      register RESPONSE body (additive, back-compat) so the registering cortex
 *      can tell its principal "registered, but your admission request didn't
 *      land — re-register to retry" (re-register self-heals, upsert idempotent).
 *
 * A successful upsert leaves the response unchanged (no warning, no flag).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import app from "../src/index";
import type { Env } from "../src/index";
import {
  makePrincipalKey,
  makeRegistryKey,
  makeSignedRegistration,
  resetStores,
  type PrincipalKey,
} from "./helpers";
import {
  _setIssuanceStoreForTest,
  type IssuanceRequestStore,
} from "../src/store";
import type { AdmissionRequest } from "../src/types";
import { _resetRateLimitBucketsForTest } from "../src/rate-limit";

let env: Env;
let principal: PrincipalKey;

async function post(path: string, body: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/**
 * An issuance store whose `upsertPending` always throws — stands in for the
 * confirmed-live failure mode (principal registered before the admission tables
 * deployed, or any transient DB error). Every other method throws too: this
 * store must never be reached on a path other than the register hook.
 */
function makeFailingIssuanceStore(message: string): IssuanceRequestStore {
  const boom = (): never => {
    throw new Error(message);
  };
  return {
    upsertPending: async () => boom(),
    getIssuanceRequest: async () => boom(),
    listIssuanceRequests: async () => boom(),
    listIssuanceRequestsByPeer: async () => boom(),
    transitionIssuanceRequest: async () => boom(),
  } as unknown as IssuanceRequestStore;
}

type RegisterResponse = {
  payload: unknown;
  issued_at: string;
  registry: string;
  signature: string;
  admission_request?: string;
  warning?: string;
};

beforeEach(async () => {
  resetStores();
  _resetRateLimitBucketsForTest();
  const reg = await makeRegistryKey();
  principal = await makePrincipalKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  };
});

afterEach(() => {
  resetStores();
});

describe("cortex#1263 — admission upsert failure is visible, not silent", () => {
  test("upsert failure → registration still 201, but response carries the warning", async () => {
    _setIssuanceStoreForTest(makeFailingIssuanceStore("simulated DB failure"));

    const res = await post(
      "/principals/chuvala/register",
      await makeSignedRegistration("chuvala", principal, { networkId: "net-a" }),
    );

    // Registration is NOT rejected — the principal record is committed.
    expect(res.status).toBe(201);

    const body = (await res.json()) as RegisterResponse;
    // The signed assertion is intact (back-compat — payload still present/signed).
    expect(body.payload).toBeDefined();
    expect(body.signature).not.toBe("");
    // The non-silent flags are present and explicit.
    expect(body.admission_request).toBe("failed");
    expect(typeof body.warning).toBe("string");
    expect(body.warning).toContain("re-register");
  });

  test("upsert failure → a loud, structured system.error is emitted with context", async () => {
    _setIssuanceStoreForTest(makeFailingIssuanceStore("simulated DB failure"));

    const captured: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      const res = await post(
        "/principals/chuvala/register",
        await makeSignedRegistration("chuvala", principal, { networkId: "net-a" }),
      );
      expect(res.status).toBe(201);
    } finally {
      console.error = original;
    }

    const line = captured.find((l) =>
      l.includes("admission_request_upsert_failed"),
    );
    expect(line).toBeDefined();
    // Greppable monitor token + enough context to diagnose + re-raise.
    expect(line).toContain("system.error");
    expect(line).toContain("principal_id=chuvala");
    expect(line).toContain("network_id=net-a");
    expect(line).toContain("peer_pubkey=");
    expect(line).toContain("requested_scope=");
    expect(line).toContain("simulated DB failure");
  });

  test("successful upsert → response is the plain signed assertion (no warning, no flag)", async () => {
    // Default in-memory issuance store (resetStores left it unset → real store).
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as RegisterResponse;
    expect(body.payload).toBeDefined();
    expect(body.signature).not.toBe("");
    // No warning fields on the happy path.
    expect(body.admission_request).toBeUndefined();
    expect(body.warning).toBeUndefined();
  });

  test("after a successful register, the PENDING row exists (regression anchor)", async () => {
    const res = await post(
      "/principals/alice/register",
      await makeSignedRegistration("alice", principal, { networkId: "net-a" }),
    );
    expect(res.status).toBe(201);

    // The real in-memory store now holds the PENDING row the register hook wrote.
    const { getIssuanceStore } = await import("../src/store");
    const rows: AdmissionRequest[] = await getIssuanceStore(env).listIssuanceRequests(
      "PENDING",
    );
    const alice = rows.filter((r) => r.principal_id === "alice");
    expect(alice.length).toBe(1);
    expect(alice[0]!.network_id).toBe("net-a");
  });
});
