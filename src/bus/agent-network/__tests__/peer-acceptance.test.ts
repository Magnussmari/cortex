/**
 * MC-A2 (cortex#1276) — tests for per-principal acceptance (the second trust
 * layer: admission grants membership, accept-policy chooses whom to trust).
 *
 * Drives `summarizeAcceptancePolicy` + `resolvePeerAcceptance` over plain
 * offering literals — no I/O, no config-load. The load-bearing property:
 * acceptance is DEFAULT-DENY (no offering ⇒ accept nobody), `{kind:'network'}`
 * trusts the whole roster, `{kind:'principals'}` trusts only named peers, and
 * the serving principal is always `self`.
 */

import { describe, it, expect } from "bun:test";
import {
  summarizeAcceptancePolicy,
  resolvePeerAcceptance,
  type PeerAcceptance,
} from "../peer-acceptance";
import type { Offering } from "../../../common/types/offering";

function resolve(
  offerings: Offering[] | undefined,
  networkId: string,
  member: string,
  local = "andreas",
): PeerAcceptance {
  return resolvePeerAcceptance(
    summarizeAcceptancePolicy(offerings),
    networkId,
    member,
    local,
  );
}

describe("resolvePeerAcceptance", () => {
  it("the serving principal is always self", () => {
    expect(resolve(undefined, "research-collab", "andreas")).toBe("self");
  });

  it("default-deny — no offerings ⇒ a peer is not-accepted", () => {
    expect(resolve(undefined, "research-collab", "jc")).toBe("not-accepted");
    expect(resolve([], "research-collab", "jc")).toBe("not-accepted");
  });

  it("{kind:'network'} trusts the WHOLE roster of that network", () => {
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["federated"],
        accept: { kind: "network", network: "research-collab" },
      },
    ];
    expect(resolve(offerings, "research-collab", "jc")).toBe("accepted-network");
    expect(resolve(offerings, "research-collab", "anyone")).toBe("accepted-network");
    // ...but NOT a peer on a DIFFERENT network.
    expect(resolve(offerings, "other-net", "jc")).toBe("not-accepted");
  });

  it("{kind:'principals'} trusts only the NAMED peers", () => {
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["federated"],
        accept: { kind: "principals", principals: ["jc", "zeta"] },
      },
    ];
    expect(resolve(offerings, "research-collab", "jc")).toBe("accepted-named");
    expect(resolve(offerings, "research-collab", "zeta")).toBe("accepted-named");
    expect(resolve(offerings, "research-collab", "mallory")).toBe("not-accepted");
  });

  it("whole-roster acceptance takes precedence over a named match", () => {
    const offerings: Offering[] = [
      {
        capability: "a.b",
        scopes: ["federated"],
        accept: { kind: "network", network: "research-collab" },
      },
      {
        capability: "c.d",
        scopes: ["federated"],
        accept: { kind: "principals", principals: ["jc"] },
      },
    ];
    expect(resolve(offerings, "research-collab", "jc")).toBe("accepted-network");
  });

  it("public {kind:'surface'} offerings never accept a bus peer", () => {
    const offerings: Offering[] = [
      {
        capability: "code-review.typescript",
        scopes: ["public"],
        accept: {
          kind: "surface",
          surface: "github",
          predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
        },
      },
    ];
    expect(resolve(offerings, "research-collab", "jc")).toBe("not-accepted");
  });
});

describe("summarizeAcceptancePolicy", () => {
  it("collects network-wide ids and named principals across offerings", () => {
    const summary = summarizeAcceptancePolicy([
      {
        capability: "a.b",
        scopes: ["federated"],
        accept: { kind: "network", network: "net-1" },
      },
      {
        capability: "c.d",
        scopes: ["federated"],
        accept: { kind: "principals", principals: ["jc", "zeta"] },
      },
      { capability: "e.f", scopes: ["local"] },
    ]);
    expect([...summary.networkWide].sort()).toEqual(["net-1"]);
    expect([...summary.namedPrincipals].sort()).toEqual(["jc", "zeta"]);
  });
});
