/**
 * TC-2b (cortex#634) — MultiPrincipalIdentityRegistry tests.
 *
 * Covers the spec matrix:
 *
 *   1. Back-compat — single boot principal still resolves as before
 *      (no resolver wired; only the pinned boot entry is available).
 *   2. Multi-principal — register/resolve principals A and B, both
 *      retrievable, no cross-contamination.
 *   3. On-demand resolve populates the map via the resolver; second
 *      lookup is a cache hit (no re-resolve).
 *   4. Posture OFF — peer lookup performs ZERO registry I/O; only the
 *      boot entry is available.
 *   5. Unresolved peer → negative outcome, NOT a throw; the local boot
 *      entry is never overwritten.
 *
 * The on-demand end-to-end test drives a real TC-2a `PrincipalPubkeyResolver`
 * against an EPHEMERAL `Bun.serve({ port: 0 })` registry stub — never a
 * hardcoded port (the #671 de-flake). The remaining tests inject a tiny
 * resolver stub so the cache / posture / negative paths are deterministic
 * and I/O-free.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  MultiPrincipalIdentityRegistry,
  type RegistryResolveOutcome,
} from "../identity-registry";
import { PrincipalPubkeyResolver, type ResolveResult } from "../resolve-pubkey";
import { canonicalJSON } from "../signing";
import type { Identity } from "@the-metafactory/myelin/identity";

// =============================================================================
// Fixtures
// =============================================================================

// A structurally-valid base64 Ed25519 pubkey (44 chars w/ padding).
const PEER_PUBKEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PEER_PUBKEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const BOOT_PUBKEY = "Q0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0M=";

function bootIdentity(principalId: string): Identity {
  return {
    id: `did:mf:${principalId}`,
    display_name: principalId,
    network: principalId,
    public_key: BOOT_PUBKEY,
    type: "agent",
    created_at: new Date(0).toISOString(),
  };
}

/**
 * Minimal resolver stub implementing `Pick<PrincipalPubkeyResolver,
 * "resolve">`. Drives the registry's resolve matrix without any I/O.
 * Counts calls so cache-hit tests can assert no re-resolve.
 */
function makeResolverStub(
  responses: Record<string, ResolveResult>,
  fallback: ResolveResult = { status: "unresolved" },
): { resolve: (id: string) => Promise<ResolveResult>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(id: string): Promise<ResolveResult> {
      calls.push(id);
      return Promise.resolve(responses[id] ?? fallback);
    },
  };
}

// =============================================================================
// 1. Back-compat — single boot principal, no resolver
// =============================================================================

describe("back-compat (single-principal)", () => {
  test("boot principal resolves synchronously and via resolve()", async () => {
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
    });

    const got = reg.get("boot");
    expect(got).toBeDefined();
    expect(got?.provenance).toBe("local-boot");
    expect(got?.identity.public_key).toBe(BOOT_PUBKEY);

    const resolved = await reg.resolve("boot");
    expect(resolved.resolved).toBe(true);
    if (resolved.resolved) {
      expect(resolved.entry.principalId).toBe("boot");
      expect(resolved.entry.provenance).toBe("local-boot");
    }
  });

  test("materialised myelin registry contains exactly the boot identity", () => {
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
    });
    const myelin = reg.toIdentityRegistry();
    expect(myelin.list()).toHaveLength(1);
    expect(myelin.resolve("did:mf:boot")?.public_key).toBe(BOOT_PUBKEY);
  });

  test("unknown peer with no resolver is inert (disabled), no boot mutation", async () => {
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
    });
    const outcome = await reg.resolve("stranger");
    expect(outcome).toEqual({ resolved: false, reason: "disabled" });
    expect(reg.get("stranger")).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});

// =============================================================================
// 2. Multi-principal — A and B, no cross-contamination
// =============================================================================

describe("multi-principal", () => {
  test("resolves A and B; both retrievable; no cross-contamination", async () => {
    const stub = makeResolverStub({
      alice: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
      bob: { status: "resolved", principalPubkey: PEER_PUBKEY_B },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    const a = await reg.resolve("alice");
    const b = await reg.resolve("bob");

    expect(a.resolved).toBe(true);
    expect(b.resolved).toBe(true);
    if (a.resolved) expect(a.entry.identity.public_key).toBe(PEER_PUBKEY_A);
    if (b.resolved) expect(b.entry.identity.public_key).toBe(PEER_PUBKEY_B);

    // No cross-contamination: A's pubkey stays A's, B's stays B's.
    expect(reg.get("alice")?.identity.public_key).toBe(PEER_PUBKEY_A);
    expect(reg.get("bob")?.identity.public_key).toBe(PEER_PUBKEY_B);
    expect(reg.get("alice")?.identity.id).toBe("did:mf:alice");
    expect(reg.get("bob")?.identity.id).toBe("did:mf:bob");
    expect(reg.get("alice")?.provenance).toBe("resolved-registry");

    // Boot + 2 peers materialise into the myelin registry.
    const myelin = reg.toIdentityRegistry();
    expect(myelin.list()).toHaveLength(3);
    expect(myelin.resolve("did:mf:alice")?.public_key).toBe(PEER_PUBKEY_A);
    expect(myelin.resolve("did:mf:bob")?.public_key).toBe(PEER_PUBKEY_B);
    expect(myelin.resolve("did:mf:boot")?.public_key).toBe(BOOT_PUBKEY);
  });

  test("peerNetwork override stamps the resolved Identity.network", async () => {
    const stub = makeResolverStub({
      alice: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
      peerNetwork: () => "shared-net",
    });
    const a = await reg.resolve("alice");
    if (a.resolved) expect(a.entry.identity.network).toBe("shared-net");
    // Default would have been the peer's own id.
    expect(reg.get("alice")?.identity.network).toBe("shared-net");
  });
});

// =============================================================================
// 3. On-demand resolve populates the map; cache hit on second lookup
// =============================================================================

describe("on-demand resolve + cache", () => {
  test("second resolve is a cache hit — resolver not consulted twice", async () => {
    const stub = makeResolverStub({
      alice: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    const first = await reg.resolve("alice");
    expect(first.resolved).toBe(true);
    expect(stub.calls).toEqual(["alice"]);

    // Synchronous get now hits the populated map.
    expect(reg.get("alice")?.identity.public_key).toBe(PEER_PUBKEY_A);

    const second = await reg.resolve("alice");
    expect(second.resolved).toBe(true);
    // Resolver consulted exactly once across both resolves.
    expect(stub.calls).toEqual(["alice"]);
  });

  test("end-to-end through a real resolver + ephemeral registry stub", async () => {
    const kp = await generateKeypair();
    const counter = { principals: 0, pubkey: 0 };
    const stub = startRegistryStub({
      registryPubkey: kp.publicKeyB64,
      sign: (payload) => signAssertion(kp.privateKey, kp.publicKeyB64, payload),
      counter,
    });
    serversToStop.push(stub.stop);

    const resolver = new PrincipalPubkeyResolver({
      enabled: true,
      baseUrl: stub.baseUrl,
      registryPubkey: kp.publicKeyB64,
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver,
    });

    // Miss → on-demand resolve populates the map.
    expect(reg.get("alice")).toBeUndefined();
    const outcome = await reg.resolve("alice");
    expect(outcome.resolved).toBe(true);
    if (outcome.resolved) {
      expect(outcome.entry.provenance).toBe("resolved-registry");
      expect(outcome.entry.identity.id).toBe("did:mf:alice");
    }
    expect(counter.principals).toBe(1);

    // Cache hit: second resolve does not re-fetch the registry.
    await reg.resolve("alice");
    expect(counter.principals).toBe(1);

    // The materialised myelin registry now carries the resolved peer.
    expect(reg.toIdentityRegistry().resolve("did:mf:alice")).not.toBeNull();
  });
});

// =============================================================================
// 4. Posture OFF — zero I/O, only boot entry available
// =============================================================================

describe("posture OFF", () => {
  test("disabled resolver performs ZERO registry I/O", async () => {
    let fetchCalls = 0;
    const resolver = new PrincipalPubkeyResolver({
      enabled: false, // signing !== "enforce"
      baseUrl: "http://127.0.0.1:1", // never reached
      registryPubkey: BOOT_PUBKEY,
      fetch: ((..._args: Parameters<typeof fetch>) => {
        fetchCalls++;
        return Promise.reject(new Error("network must not be touched when OFF"));
      }) as typeof fetch,
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver,
    });

    const outcome = await reg.resolve("alice");
    expect(outcome).toEqual({ resolved: false, reason: "disabled" });
    expect(fetchCalls).toBe(0);

    // Only the boot entry is available.
    expect(reg.get("alice")).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
    expect(reg.get("boot")?.provenance).toBe("local-boot");
  });
});

// =============================================================================
// 5. Unresolved / not_found peer → negative, never a throw; boot untouched
// =============================================================================

describe("negative paths (no throw, boot anchor preserved)", () => {
  test("unresolved peer → reason 'unresolved', not cached, boot intact", async () => {
    const stub = makeResolverStub(
      {},
      { status: "unresolved" }, // every miss is unresolved
    );
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
      logError: () => {}, // negative-path logging is asserted by behaviour, not stderr
    });

    const outcome = await reg.resolve("ghost");
    expect(outcome).toEqual({ resolved: false, reason: "unresolved" });
    // Negative not cached — re-resolve consults the resolver again.
    expect(reg.get("ghost")).toBeUndefined();
    await reg.resolve("ghost");
    expect(stub.calls).toEqual(["ghost", "ghost"]);

    // Boot anchor untouched.
    expect(reg.get("boot")?.identity.public_key).toBe(BOOT_PUBKEY);
    expect(reg.list()).toHaveLength(1);
  });

  test("not_found peer → reason 'not_found', not cached", async () => {
    const stub = makeResolverStub({ ghost: { status: "not_found" } });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
      logError: () => {}, // negative-path logging is asserted by behaviour
    });
    const outcome: RegistryResolveOutcome = await reg.resolve("ghost");
    expect(outcome).toEqual({ resolved: false, reason: "not_found" });
    expect(reg.get("ghost")).toBeUndefined();
  });

  test("resolver returning the boot id does NOT overwrite the boot anchor", async () => {
    // A misbehaving / hostile resolver tries to re-stamp the boot principal
    // with a different pubkey. The pinned boot entry must win.
    const stub = makeResolverStub({
      boot: { status: "resolved", principalPubkey: PEER_PUBKEY_A },
    });
    const reg = new MultiPrincipalIdentityRegistry({
      bootPrincipal: { principalId: "boot", identity: bootIdentity("boot") },
      resolver: stub,
    });

    // get() always returns the pinned boot entry without consulting resolver.
    expect(reg.get("boot")?.identity.public_key).toBe(BOOT_PUBKEY);
    // resolve() returns the pinned entry (cache hit) — resolver never called.
    const outcome = await reg.resolve("boot");
    expect(outcome.resolved).toBe(true);
    if (outcome.resolved) {
      expect(outcome.entry.provenance).toBe("local-boot");
      expect(outcome.entry.identity.public_key).toBe(BOOT_PUBKEY);
    }
    expect(stub.calls).toEqual([]); // boot is a cache hit, no resolver I/O
    expect(reg.list()).toHaveLength(1);
  });
});

// =============================================================================
// Ed25519 sign-side helpers + ephemeral registry stub (mirrors
// resolve-pubkey.test.ts — Bun.serve({ port: 0 }), never a hardcoded port).
// =============================================================================

const serversToStop: (() => void)[] = [];
afterEach(() => {
  while (serversToStop.length > 0) {
    const stop = serversToStop.pop();
    if (stop) stop();
  }
});

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function generateKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKeyB64: string;
}> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return {
    privateKey: kp.privateKey,
    publicKeyB64: bytesToBase64(new Uint8Array(raw)),
  };
}

interface PrincipalPayload {
  principal_id: string;
  principal_pubkey: string;
  stacks: unknown[];
  capabilities: unknown[];
  updated_at: string;
}

async function signAssertion(
  registryPrivateKey: CryptoKey,
  registryPubkey: string,
  payload: PrincipalPayload,
): Promise<unknown> {
  const issued_at = new Date().toISOString();
  const bound = canonicalJSON({ payload, issued_at, registry: registryPubkey });
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    registryPrivateKey,
    new TextEncoder().encode(bound),
  );
  return {
    payload,
    issued_at,
    registry: registryPubkey,
    signature: bytesToBase64(new Uint8Array(sig)),
  };
}

interface RegistryStubOptions {
  registryPubkey: string;
  sign: (payload: PrincipalPayload) => Promise<unknown>;
  counter: { principals: number; pubkey: number };
}

function startRegistryStub(opts: RegistryStubOptions): {
  baseUrl: string;
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0, // ephemeral — OS assigns a free port (#671 de-flake pattern)
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/registry/pubkey") {
        opts.counter.pubkey++;
        return Response.json({
          algorithm: "Ed25519",
          public_key: opts.registryPubkey,
        });
      }
      const match = /^\/principals\/(.+)$/.exec(url.pathname);
      if (match) {
        opts.counter.principals++;
        const principalId = decodeURIComponent(match[1] ?? "");
        const payload: PrincipalPayload = {
          principal_id: principalId,
          principal_pubkey: PEER_PUBKEY_A,
          stacks: [{ stack_id: `${principalId}/laptop` }],
          capabilities: [],
          updated_at: new Date().toISOString(),
        };
        return Response.json(await opts.sign(payload));
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: server.url.toString(),
    stop: () => {
      server.stop(true);
    },
  };
}
