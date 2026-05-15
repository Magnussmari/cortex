/**
 * IAW Phase B.1a (cortex#114) — `verifySignedByChain` tests.
 *
 * Nine table-driven cases per Echo's B.1a review minimum baseline:
 *   1. Happy path — single trusted ed25519 stamp
 *   2. Empty chain, `rejectEmpty: true` (default) → empty_chain
 *   3. Empty chain, `rejectEmpty: false` → valid w/ empty skipped
 *   4. Malformed principal (did:key:…) → malformed_principal
 *   5. Well-formed DID, agent not in registry → unknown_agent
 *   6. Agent registered but no nkey_pub → principal_has_no_nkey_pub
 *   7. Signer not in receiver's trust → signer_not_trusted
 *   8. Mixed chain — hub-stamp at 0 (skipped), ed25519 at 1 → valid w/ skipped:[0]
 *   9. Multi-stamp, second rejected → rejectedAt:1, reason carried, skipped:[]
 *
 * Structural checks only at this slice — the cryptographic ed25519 verify
 * lands in B.1c.
 */

import { describe, test, expect } from "bun:test";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import {
  verifySignedByChain,
  type ChainVerificationResult,
} from "../verify-signed-by-chain";
import type { Envelope, SignedBy } from "../myelin/envelope-validator";
import type { Agent } from "../../common/types/cortex-config";

// =============================================================================
// Fixtures
// =============================================================================

// Valid 56-char U-prefixed base32 NKey shapes — same regex as
// StackConfigSchema.nkey_pub / AgentSchema.nkey_pub. The bytes don't
// have to be valid NATS keys for structural-trust tests; only the
// regex shape matters.
const NKEY_LUNA = "U" + "A".repeat(55);
const NKEY_ECHO = "U" + "B".repeat(55);
const NKEY_HOLLY = "U" + "C".repeat(55);

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
    contextDepth: 10,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: {
      operatorRole: {
        features: ["chat", "async", "team"] as const,
        disallowedTools: [],
        bashGuard: true,
      },
      defaultRole: "denied" as const,
      userRoles: [],
    },
  };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function ed25519Stamp(principal: string): SignedBy {
  return {
    method: "ed25519",
    principal,
    // 88-char base64 placeholder — the structural slice doesn't verify
    // signature bytes; B.1c will. Any string of the right rough shape.
    signature: "A".repeat(88),
    at: "2026-05-15T08:00:00.000Z",
  };
}

function hubStamp(principal: string, hub: string): SignedBy {
  return {
    method: "hub-stamp",
    principal,
    stamped_by: hub,
    signature: "B".repeat(88),
    at: "2026-05-15T08:00:00.000Z",
  };
}

function envelopeWithChain(chain: SignedBy[] | SignedBy | undefined): Envelope {
  const base: Envelope = {
    id: "00000000-0000-4000-8000-000000000001",
    source: "metafactory.luna.local",
    type: "test.verify.case",
    timestamp: "2026-05-15T08:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 4,
      frontier_ok: false,
      model_class: "any",
    },
    payload: {},
  };
  if (chain !== undefined) {
    base.signed_by = chain;
  }
  return base;
}

function resolverWith(...agents: Agent[]): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents(agents));
}

// =============================================================================
// Cases
// =============================================================================

describe("verifySignedByChain — happy path + skipped semantics", () => {
  test("[1] single trusted ed25519 stamp → valid with empty skipped", () => {
    // Receiver "luna" trusts sender "echo" with known nkey.
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([ed25519Stamp("did:mf:echo")]);
    const result: ChainVerificationResult = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([]);
    }
  });

  test("[8] mixed chain — hub-stamp at index 0 (skipped), trusted ed25519 at index 1 → valid w/ skipped:[0]", () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([
      hubStamp("did:mf:echo", "did:mf:hub-alpha"),
      ed25519Stamp("did:mf:echo"),
    ]);
    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([0]);
    }
  });
});

describe("verifySignedByChain — empty chain semantics", () => {
  test("[2] empty chain, rejectEmpty defaults to true → empty_chain rejection", () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain(undefined);

    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason.kind).toBe("empty_chain");
      expect(result.skipped).toEqual([]);
    }
  });

  test("[3] empty chain, rejectEmpty explicit false → valid w/ empty skipped", () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain(undefined);

    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
      rejectEmpty: false,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.skipped).toEqual([]);
    }
  });
});

describe("verifySignedByChain — split rejection reasons", () => {
  test("[4] malformed principal (did:key:…) → malformed_principal", () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain([ed25519Stamp("did:key:abc123")]);

    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "malformed_principal",
        principal: "did:key:abc123",
      });
    }
  });

  test("[5] well-formed did:mf but agent not registered → unknown_agent", () => {
    const luna = agentFixture({ id: "luna" });
    const resolver = resolverWith(luna);
    const env = envelopeWithChain([ed25519Stamp("did:mf:nobody")]);

    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "unknown_agent",
        principal: "did:mf:nobody",
        agentId: "nobody",
      });
    }
  });

  test("[6] agent registered but no nkey_pub → principal_has_no_nkey_pub", () => {
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    // echo has no nkey_pub — intentional.
    const echo = agentFixture({ id: "echo", displayName: "Echo" });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([ed25519Stamp("did:mf:echo")]);
    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "principal_has_no_nkey_pub",
        principal: "did:mf:echo",
        agentId: "echo",
      });
    }
  });

  test("[7] signer's NKey known but receiver doesn't trust them → signer_not_trusted", () => {
    // luna does NOT include echo in `trust:`.
    const luna = agentFixture({ id: "luna", trust: [] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([ed25519Stamp("did:mf:echo")]);
    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(0);
      expect(result.reason).toEqual({
        kind: "signer_not_trusted",
        principal: "did:mf:echo",
        agentId: "echo",
      });
    }
  });
});

describe("verifySignedByChain — multi-stamp rejection", () => {
  test("[9] valid stamp at index 0, untrusted stamp at index 1 → rejectedAt:1, skipped:[]", () => {
    // luna trusts echo (NKey present) but not holly. Chain has echo first
    // (accepted), holly second (rejected — signer_not_trusted). Verify
    // that `rejectedAt: 1` carries the per-stamp index, and that the
    // pre-rejection accepts are NOT counted as skips (skips are
    // hub-stamps only).
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const holly = agentFixture({
      id: "holly",
      displayName: "Holly",
      nkey_pub: NKEY_HOLLY,
    });
    const resolver = resolverWith(luna, echo, holly);

    const env = envelopeWithChain([
      ed25519Stamp("did:mf:echo"),
      ed25519Stamp("did:mf:holly"),
    ]);
    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(1);
      expect(result.reason).toEqual({
        kind: "signer_not_trusted",
        principal: "did:mf:holly",
        agentId: "holly",
      });
      expect(result.skipped).toEqual([]);
    }
  });

  test("rejection on stamp 2 with hub-stamp at index 0 → skipped:[0] preserved", () => {
    // Extra coverage on the new `skipped` carry-through behaviour for
    // failure variants: hub-stamp at 0 was skipped before the rejection
    // at index 2 fires, so the failure result must surface skipped:[0].
    const luna = agentFixture({ id: "luna", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: NKEY_ECHO,
    });
    const resolver = resolverWith(luna, echo);

    const env = envelopeWithChain([
      hubStamp("did:mf:echo", "did:mf:hub-alpha"),
      ed25519Stamp("did:mf:echo"),
      ed25519Stamp("did:mf:nobody"),
    ]);
    const result = verifySignedByChain(env, {
      resolver,
      receivingAgentId: "luna",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.rejectedAt).toBe(2);
      expect(result.reason.kind).toBe("unknown_agent");
      expect(result.skipped).toEqual([0]);
    }
  });
});
