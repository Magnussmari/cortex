/**
 * #680 + #681 — Edge-hardening tests: app-layer rate limiting + enumeration
 * policy. Drives the Worker via `app.fetch(request, env)` so the full Hono
 * pipeline (read-limit middleware + register handler + signing) is exercised.
 *
 * Two layers are tested:
 *   1. The in-Worker token-bucket FALLBACK (no native binding in `env`) — this
 *      is what runs under `wrangler dev` and `bun test`.
 *   2. The NATIVE binding path, via a mock `RateLimit` binding injected into
 *      `env` — emulates the Cloudflare `env.RL.limit({ key })` contract.
 *
 * Parity note: the LIMIT VALUES are code constants (RATE_LIMITS) shared by both
 * dev and prod, so testing them once tests both environments.
 */

import { describe, test, expect, beforeEach } from "bun:test";
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
  RATE_LIMITS,
  type RateLimitBinding,
} from "../src/rate-limit";
import type { SignedAssertion, PrincipalRecord } from "../src/types";

let env: Env;
let pKey: PrincipalKey;

beforeEach(async () => {
  resetStores();
  const reg = await makeRegistryKey();
  env = {
    REGISTRY_SIGNING_KEY: reg.signingKey,
    REGISTRY_PUBLIC_KEY: reg.publicKey,
    ENVIRONMENT: "test",
  };
  pKey = await makePrincipalKey();
});

/**
 * Issue a request with an explicit client IP so each test keys its own bucket
 * (the fallback keys on CF-Connecting-IP, falling back to "local").
 */
function reqWith(
  path: string,
  init: RequestInit & { ip?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.ip) headers.set("CF-Connecting-IP", init.ip);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function fetchApp(req: Request): Promise<Response> {
  return app.fetch(req, env);
}

async function postRegister(
  principalId: string,
  body: unknown,
  ip: string,
): Promise<Response> {
  return fetchApp(
    reqWith(`/principals/${principalId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ip,
    }),
  );
}

// ===========================================================================
// #680 — register limit (fallback bucket)
// ===========================================================================

describe("#680 register rate-limit (fallback bucket)", () => {
  test("under the limit proceeds; over the limit returns 429", async () => {
    const ip = "203.0.113.10";
    const limit = RATE_LIMITS.register.limit; // 5

    // First `limit` valid registers of the SAME principal+IP succeed (each is
    // an idempotent re-register of the same pubkey; the rotation guard allows
    // re-registering the same key).
    for (let i = 0; i < limit; i++) {
      const body = await makeSignedRegistration("andreas", pKey);
      const res = await postRegister("andreas", body, ip);
      expect(res.status).toBe(201);
    }

    // The (limit + 1)-th is shed with 429, carrying a Retry-After (the window
    // period) so a well-behaved client backs off instead of hammering.
    const overBody = await makeSignedRegistration("andreas", pKey);
    const over = await postRegister("andreas", overBody, ip);
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBe(String(RATE_LIMITS.register.periodSec));
  });

  test("the limit is keyed by (IP, principal) — a different principal is independent", async () => {
    const ip = "203.0.113.20";
    const limit = RATE_LIMITS.register.limit;

    for (let i = 0; i < limit; i++) {
      const body = await makeSignedRegistration("andreas", pKey);
      const res = await postRegister("andreas", body, ip);
      expect(res.status).toBe(201);
    }
    // andreas is now exhausted on this IP...
    const exhausted = await postRegister(
      "andreas",
      await makeSignedRegistration("andreas", pKey),
      ip,
    );
    expect(exhausted.status).toBe(429);

    // ...but a DIFFERENT principal from the same IP has its own bucket.
    const otherKey = await makePrincipalKey();
    const otherRes = await postRegister(
      "bravo",
      await makeSignedRegistration("bravo", otherKey),
      ip,
    );
    expect(otherRes.status).toBe(201);
  });

  test("429 body is opaque — no internals, no limit values leaked", async () => {
    const ip = "203.0.113.30";
    for (let i = 0; i < RATE_LIMITS.register.limit; i++) {
      await postRegister("andreas", await makeSignedRegistration("andreas", pKey), ip);
    }
    const over = await postRegister(
      "andreas",
      await makeSignedRegistration("andreas", pKey),
      ip,
    );
    expect(over.status).toBe(429);
    const json = (await over.json()) as Record<string, unknown>;
    // Only the opaque error code — nothing about limit/period/key/principal.
    expect(json).toEqual({ error: "rate_limited" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(String(RATE_LIMITS.register.limit));
    expect(serialized).not.toContain("andreas");
    expect(serialized).not.toContain(ip);
  });
});

// ===========================================================================
// #680 — ORDERING: rate-limit BEFORE signature verify
// ===========================================================================

describe("#680 rate-limit precedes signature verify (flood shedding)", () => {
  test("a flood of BAD-signature registers is shed with 429, not 401", async () => {
    const ip = "203.0.113.40";
    const limit = RATE_LIMITS.register.limit;

    // Build a registration whose signature will FAIL (tamper the pubkey so the
    // claim signature no longer matches the declared key). Each of these would
    // cost an Ed25519 verify if it reached the crypto gate.
    async function badSigBody() {
      const wrongKey = await makePrincipalKey();
      // Sign with pKey but DECLARE wrongKey's pubkey → signature_invalid.
      return makeSignedRegistration("andreas", pKey, {
        pubkeyOverride: wrongKey.publicKeyB64,
      });
    }

    // The first `limit` bad-sig attempts reach the verify gate → 401.
    for (let i = 0; i < limit; i++) {
      const res = await postRegister("andreas", await badSigBody(), ip);
      expect(res.status).toBe(401);
    }
    // Once the IP+principal limit is hit, further bad-sig floods are shed at the
    // rate-limit gate (429) BEFORE the expensive Ed25519 verify runs (which
    // would otherwise return 401). This proves the gate runs first.
    const flooded = await postRegister("andreas", await badSigBody(), ip);
    expect(flooded.status).toBe(429);
  });
});

// ===========================================================================
// #680 — read limit on the GET surface (fallback bucket)
// ===========================================================================

describe("#680 read rate-limit on GET endpoints (fallback bucket)", () => {
  test("GET /principals/:id over the read limit returns 429", async () => {
    const ip = "203.0.113.50";
    const limit = RATE_LIMITS.read.limit; // 120

    // Register one principal so the resolve has something to return (this POST
    // uses a different limit/key and doesn't consume the read budget).
    await postRegister("andreas", await makeSignedRegistration("andreas", pKey), "198.51.100.1");

    for (let i = 0; i < limit; i++) {
      const res = await fetchApp(reqWith("/principals/andreas", { ip }));
      expect(res.status).toBe(200);
    }
    const over = await fetchApp(reqWith("/principals/andreas", { ip }));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(over.headers.get("Retry-After")).toBe(String(RATE_LIMITS.read.periodSec));
  });

  test("GET /capabilities and /networks/:id/roster share the IP read budget", async () => {
    const ip = "203.0.113.60";
    const limit = RATE_LIMITS.read.limit;

    // Spend the budget across BOTH list endpoints (the read limit is per-IP,
    // not per-path), proving the enumeration surface as a whole is capped.
    for (let i = 0; i < limit; i++) {
      const path = i % 2 === 0 ? "/capabilities?query=x" : "/networks/n1/roster";
      const res = await fetchApp(reqWith(path, { ip }));
      expect(res.status).toBe(200);
    }
    const over = await fetchApp(reqWith("/capabilities?query=x", { ip }));
    expect(over.status).toBe(429);
  });

  test("health + pubkey probes are NOT read-limited", async () => {
    const ip = "203.0.113.70";
    // Far exceed the read limit on the liveness/pin probes — they must keep
    // answering 200, never 429 (throttling health checks is counterproductive).
    for (let i = 0; i < RATE_LIMITS.read.limit + 5; i++) {
      const h = await fetchApp(reqWith("/api/health", { ip }));
      expect(h.status).toBe(200);
    }
    const pk = await fetchApp(reqWith("/registry/pubkey", { ip }));
    expect(pk.status).toBe(200);
  });
});

// ===========================================================================
// #680 — NATIVE binding path (mocked)
// ===========================================================================

describe("#680 native rate-limit binding path", () => {
  /** A mock binding that allows the first `allowFirst` calls, then denies. */
  function mockBinding(allowFirst: number): RateLimitBinding & { calls: string[] } {
    let n = 0;
    const calls: string[] = [];
    return {
      calls,
      async limit({ key }: { key: string }) {
        calls.push(key);
        return { success: n++ < allowFirst };
      },
    };
  }

  test("when RL_READ is bound, the native binding decides (deny → 429)", async () => {
    const denyAll = mockBinding(0);
    env.RL_READ = denyAll;
    const res = await fetchApp(reqWith("/api/health", { ip: "1.1.1.1" })); // not limited
    expect(res.status).toBe(200);
    // health is not limited, so binding not consulted there; hit a limited path:
    const limited = await fetchApp(reqWith("/capabilities?query=x", { ip: "1.1.1.1" }));
    expect(limited.status).toBe(429);
    expect(denyAll.calls.length).toBe(1);
  });

  test("when RL_REGISTER is bound, register consults it and is keyed by (IP, principal)", async () => {
    const allowAll = mockBinding(1000);
    env.RL_REGISTER = allowAll;
    const res = await postRegister("andreas", await makeSignedRegistration("andreas", pKey), "9.9.9.9");
    expect(res.status).toBe(201);
    expect(allowAll.calls.length).toBe(1);
    // Key folds IP and principal_id.
    expect(allowAll.calls[0]).toContain("9.9.9.9");
    expect(allowAll.calls[0]).toContain("andreas");
  });

  test("native-binding ERROR fails open (request allowed, registry stays up)", async () => {
    env.RL_READ = {
      async limit() {
        throw new Error("binding transient fault");
      },
    };
    await postRegister("andreas", await makeSignedRegistration("andreas", pKey), "198.51.100.9");
    const res = await fetchApp(reqWith("/principals/andreas", { ip: "2.2.2.2" }));
    // Fail-open: the resolve still succeeds despite the limiter throwing.
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// #681 — enumeration / exposure policy
// ===========================================================================

describe("#681 enumeration policy (dev = prod)", () => {
  test("by-id resolve stays PUBLIC (no auth gate) — load-bearing federation primitive", async () => {
    await postRegister(
      "andreas",
      await makeSignedRegistration("andreas", pKey, {
        capabilities: [{ id: "tasks.code-review", networks: ["research-collab"] }],
      }),
      "198.51.100.20",
    );
    // Unauthenticated GET resolves with no credentials at all.
    const res = await fetchApp(reqWith("/principals/andreas", { ip: "5.5.5.5" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as SignedAssertion<PrincipalRecord>;
    expect(json.payload.principal_id).toBe("andreas");
    expect(json.payload.principal_pubkey).toBe(pKey.publicKeyB64);
  });

  test("list endpoints stay functional and return the documented (unchanged) shape", async () => {
    await postRegister(
      "andreas",
      await makeSignedRegistration("andreas", pKey, {
        capabilities: [{ id: "tasks.code-review", networks: ["research-collab"] }],
      }),
      "198.51.100.21",
    );

    // roster: { network_id, members[] } with principal_id + pubkey + capabilities.
    const roster = await fetchApp(reqWith("/networks/research-collab/roster", { ip: "6.6.6.1" }));
    expect(roster.status).toBe(200);
    const rosterJson = (await roster.json()) as SignedAssertion<{
      network_id: string;
      members: Array<{ principal_id: string; principal_pubkey: string; capabilities: string[] }>;
    }>;
    expect(rosterJson.payload.network_id).toBe("research-collab");
    expect(rosterJson.payload.members[0]?.principal_id).toBe("andreas");

    // capabilities: { query, hits[], truncated } — only published public fields.
    const caps = await fetchApp(reqWith("/capabilities?query=code-review", { ip: "6.6.6.2" }));
    expect(caps.status).toBe(200);
    const capsJson = (await caps.json()) as SignedAssertion<{
      hits: Array<{ capability_id: string; principal_id: string }>;
    }>;
    expect(capsJson.payload.hits[0]?.capability_id).toBe("tasks.code-review");
  });
});
