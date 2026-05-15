/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine tests.
 *
 * Coverage axes:
 *   1. Happy path — principal with a role granting the requested
 *      capability → allow + full effective capability set.
 *   2. Unknown principal → `unknown_principal` reason.
 *   3. Capability not in role grant → `insufficient_role`.
 *   4. Multi-role union — principal with two roles → effective
 *      capabilities = union; intent against either role's
 *      capability succeeds.
 *   5. Empty role list → every capability check fails with
 *      `insufficient_role` (no capability is reachable).
 *   6. Unknown role id silently skipped — principal with one valid
 *      + one unknown role gets only the valid role's grants
 *      (config-validation lives upstream at parse time per the
 *      engine JSDoc).
 *   7. Sovereignty field is a no-op at C.1 (smoke test that an
 *      otherwise-allowed intent isn't rejected on sovereignty
 *      grounds — the discriminator variant exists for forward
 *      compat but the engine doesn't fire it).
 *   8. `principalCount` + `roleCount` smoke — boot-log accessors.
 */

import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "../engine";
import type {
  Intent,
  Principal,
  RoleDefinition,
} from "../types";

// =============================================================================
// Fixtures
// =============================================================================

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "luna",
    home_operator: "andreas",
    home_stack: "andreas/research",
    role: ["operator"],
    trust: [],
    ...overrides,
  };
}

function role(id: string, capabilities: string[]): RoleDefinition {
  return { id, capabilities };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    capability: "code-review.typescript",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "any",
    },
    ...overrides,
  };
}

// =============================================================================
// Cases
// =============================================================================

describe("PolicyEngine — happy path", () => {
  test("principal with a role granting the requested capability → allow", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["code-review.typescript", "deploy.staging"])],
    });

    const result = engine.check(principal({ id: "luna" }), intent());

    expect(result.allow).toBe(true);
    if (result.allow) {
      // Effective set is the role's full capability list, not just
      // the requested capability — downstream callers filter on it.
      expect(new Set(result.capabilities)).toEqual(
        new Set(["code-review.typescript", "deploy.staging"]),
      );
    }
  });
});

describe("PolicyEngine — rejection paths", () => {
  test("unknown principal → unknown_principal reason", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna" })],
      roles: [role("operator", ["code-review.typescript"])],
    });

    const result = engine.check(
      principal({ id: "nobody", role: ["operator"] }),
      intent(),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "unknown_principal",
        principal_id: "nobody",
      });
    }
  });

  test("capability not in role grant → insufficient_role", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["deploy.staging"])],
    });

    const result = engine.check(
      principal({ id: "luna" }),
      intent({ capability: "code-review.typescript" }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "insufficient_role",
        missing_capability: "code-review.typescript",
        principal_id: "luna",
      });
    }
  });

  test("empty role list → insufficient_role on any capability", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: [] })],
      roles: [role("operator", ["code-review.typescript"])],
    });

    const result = engine.check(principal({ id: "luna" }), intent());

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason.kind).toBe("insufficient_role");
    }
  });
});

describe("PolicyEngine — role union semantics", () => {
  test("multi-role principal: effective capabilities = union; intent against either role succeeds", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({ id: "luna", role: ["operator", "code-reviewer"] }),
      ],
      roles: [
        role("operator", ["deploy.staging"]),
        role("code-reviewer", ["code-review.typescript", "code-review.rust"]),
      ],
    });

    // Either capability resolves.
    const deployResult = engine.check(
      principal({ id: "luna" }),
      intent({ capability: "deploy.staging" }),
    );
    const reviewResult = engine.check(
      principal({ id: "luna" }),
      intent({ capability: "code-review.typescript" }),
    );

    expect(deployResult.allow).toBe(true);
    expect(reviewResult.allow).toBe(true);
    if (deployResult.allow) {
      expect(new Set(deployResult.capabilities)).toEqual(
        new Set([
          "deploy.staging",
          "code-review.typescript",
          "code-review.rust",
        ]),
      );
    }
  });

  test("unknown role id silently skipped — only valid roles' grants count", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({ id: "luna", role: ["operator", "ghost-role"] }),
      ],
      // Note: `ghost-role` deliberately NOT in roles list.
      roles: [role("operator", ["deploy.staging"])],
    });

    const result = engine.check(
      principal({ id: "luna" }),
      intent({ capability: "deploy.staging" }),
    );

    expect(result.allow).toBe(true);
    if (result.allow) {
      // ghost-role's capabilities are not in the effective set.
      expect(new Set(result.capabilities)).toEqual(
        new Set(["deploy.staging"]),
      );
    }
  });
});

describe("PolicyEngine — sovereignty (C.1 smoke)", () => {
  test("sovereignty field is part of input shape but doesn't reject at C.1", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["code-review.typescript"])],
    });

    // Federated classification — strongest sovereignty signal cortex
    // emits today. C.1 doesn't reject on this; Phase D will.
    const result = engine.check(
      principal({ id: "luna" }),
      intent({
        sovereignty: {
          classification: "federated",
          data_residency: "US",
          max_hop: 4,
          frontier_ok: true,
          model_class: "frontier",
        },
      }),
    );

    expect(result.allow).toBe(true);
  });
});

describe("PolicyEngine — boot accessors", () => {
  test("principalCount + roleCount reflect constructor opts", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({ id: "luna" }),
        principal({ id: "echo" }),
        principal({ id: "holly" }),
      ],
      roles: [
        role("operator", []),
        role("code-reviewer", []),
      ],
    });

    expect(engine.principalCount).toBe(3);
    expect(engine.roleCount).toBe(2);
  });
});
