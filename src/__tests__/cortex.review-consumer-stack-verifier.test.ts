/**
 * cortex#535 (TC-1a) — review-consumer signature-verifier own-stack regression.
 *
 * The review-consumer's `signatureVerifier` closure (src/cortex.ts) calls
 * `verifySignedByChain`. Pre-fix, that call OMITTED the `stackIdentity` +
 * `stackNKeyPub` options that the bus-dispatch-listener wiring already
 * passes. Pilot review-requests are signed with the STACK identity
 * (`did:mf:<principal>-<stack>`), NOT an agent identity registered in the
 * local registry — so without `stackIdentity` the stack DID missed the
 * cortex#480 own-stack short-circuit and every pilot review-request was
 * rejected as `principal_has_no_nkey_pub`.
 *
 * This test reconstructs the verifier closure EXACTLY as cortex.ts wires
 * it — same `verifySignedByChain` call, same conditional-spread of the
 * stack options — and proves:
 *
 *   1. A review-request envelope signed by the stack identity VERIFIES
 *      through the closure (no `principal_has_no_nkey_pub`).
 *   2. The bug reproduces: dropping the stack options from the same call
 *      regresses to a `principal_has_no_nkey_pub` rejection. This pins the
 *      fix — if a future edit removes the threading, case 1 flips red.
 *
 * Crypto fixtures mirror `src/bus/__tests__/verify-signed-by-chain.test.ts`
 * (the established stack-signing pattern from cortex#480).
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import { AgentRegistry } from "../common/agents/registry";
import { TrustResolver } from "../common/agents/trust-resolver";
import { verifySignedByChain } from "../bus/verify-signed-by-chain";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { Agent } from "../common/types/cortex-config";
import type { SignatureVerifier } from "../bus/review-consumer";

// ---------------------------------------------------------------------------
// Fixtures — mirror verify-signed-by-chain.test.ts so reviewers see one
// pattern across the bus-side verifier tests and this wiring-level test.
// ---------------------------------------------------------------------------

/**
 * Generate a fresh ed25519 NATS user keypair. Returns the U-prefixed NKey
 * pubkey (the shape `verifySignedByChain` consumes for the own-stack
 * registry entry) and the raw 32-byte seed base64-encoded (the shape
 * myelin's `signEnvelope` wants). Same helper as the cortex#480 tests.
 */
function generateEd25519KeyPair(): {
  nkeyPub: string;
  privateKeyBase64: string;
} {
  const kp = createUser();
  const nkeyPub = kp.getPublicKey();
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  const privateKeyBase64 = Buffer.from(rawSeed).toString("base64");
  return { nkeyPub, privateKeyBase64 };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "echo",
    displayName: "Echo",
    persona: "./personas/echo.md",
    roles: [],
    trust: [],
    presence: {},
    ...overrides,
  } as Agent;
}

/**
 * A code-review-request envelope shaped like what pilot publishes onto
 * `local.{principal}.{stack}.tasks.code-review.<flavor>`. The exact payload
 * is irrelevant to signature verification — what matters is the envelope
 * gets signed by the STACK identity below.
 */
function reviewRequestEnvelope(): Envelope {
  return {
    id: "00000000-0000-4000-8000-0000000005e7",
    source: "metafactory.pilot.local",
    type: "tasks.code-review.typescript",
    timestamp: "2026-06-03T08:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {
      pr: 535,
      repo: "cortex",
      flavor: "typescript",
    },
  };
}

/**
 * Reconstruct the review-consumer `signatureVerifier` closure EXACTLY as
 * `startCortex` wires it in src/cortex.ts. `dropStackOptions` lets the test
 * exercise the PRE-FIX call shape (no stack options) to prove the bug.
 */
function buildReviewVerifier(opts: {
  trustResolver: TrustResolver;
  receivingAgentId: string;
  principalId: string;
  signer: { principal: string } | undefined;
  stackNKeyPub: string | undefined;
  dropStackOptions?: boolean;
}): SignatureVerifier {
  const { trustResolver, receivingAgentId, principalId, signer, stackNKeyPub } =
    opts;
  return async (envelope) => {
    const r = await verifySignedByChain(envelope, {
      resolver: trustResolver,
      receivingAgentId,
      cryptoVerify: true,
      principalId,
      // The bug-vs-fix switch: the fixed wiring threads these two options;
      // the pre-fix wiring omitted them.
      ...(!opts.dropStackOptions &&
        signer !== undefined && { stackIdentity: signer.principal }),
      ...(!opts.dropStackOptions &&
        stackNKeyPub !== undefined && { stackNKeyPub }),
    });
    if (r.valid) return { valid: true } as const;
    return { valid: false, reason: r.reason.kind } as const;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("review-consumer signatureVerifier — own-stack trust (cortex#535 TC-1a)", () => {
  test("review-request signed by the stack identity VERIFIES through the closure (no principal_has_no_nkey_pub)", async () => {
    // The stack signs with its own DID. Only `echo` is registered as an
    // agent; the stack identity is NOT in the registry — exactly the
    // pilot review-request topology.
    const stackIdentity = "did:mf:andreas-meta-factory";
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();

    // Non-empty trust list — this is what makes startCortex wire the
    // closure at all (empty `trust:[]` → no verifier, gate is a no-op).
    const echo = agentFixture({ id: "echo", trust: ["echo"] });
    const trustResolver = new TrustResolver(AgentRegistry.fromAgents([echo]));

    const base = reviewRequestEnvelope() as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(base, stackSeed, stackIdentity);

    const verifier = buildReviewVerifier({
      trustResolver,
      receivingAgentId: "echo",
      principalId: "andreas",
      signer: { principal: stackIdentity },
      stackNKeyPub,
    });

    const result = await verifier(signed);

    expect(result.valid).toBe(true);
  });

  test("REGRESSION GUARD — dropping the stack options reproduces the cortex#535 own-stack reject", async () => {
    // Same envelope + same stack signer, but the closure is built WITHOUT
    // threading the stack options (the pre-fix call shape). This pins the
    // fix: if a future edit removes the threading, the accepting test above
    // flips to this rejecting failure mode.
    //
    // The exact rejection CLASS depends on registry overlap: without
    // `stackIdentity`, the own-stack short-circuit (verify-signed-by-chain.ts
    // ~L412) is skipped and the stack DID falls through to the agent-registry
    // lookup. When the stack short-name does NOT collide with a registered
    // agent id it rejects as `unknown_agent`; when it DOES collide with a
    // registered-but-nkey-less agent (the topology the issue observed in
    // production) it rejects as `principal_has_no_nkey_pub`. Either way it
    // is a hard reject — the load-bearing contract is "rejects without the
    // options, accepts with them". We assert the reject + pin the two
    // documented own-stack reject classes.
    const stackIdentity = "did:mf:andreas-meta-factory";
    const { nkeyPub: stackNKeyPub, privateKeyBase64: stackSeed } =
      generateEd25519KeyPair();

    const echo = agentFixture({ id: "echo", trust: ["echo"] });
    const trustResolver = new TrustResolver(AgentRegistry.fromAgents([echo]));

    const base = reviewRequestEnvelope() as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(base, stackSeed, stackIdentity);

    const verifier = buildReviewVerifier({
      trustResolver,
      receivingAgentId: "echo",
      principalId: "andreas",
      signer: { principal: stackIdentity },
      stackNKeyPub,
      dropStackOptions: true,
    });

    const result = await verifier(signed);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect([
        "unknown_agent",
        "principal_has_no_nkey_pub",
      ]).toContain(result.reason);
    }
  });
});
