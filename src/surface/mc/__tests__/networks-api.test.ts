/**
 * MC-A1 (cortex#1275) — `handleListNetworks` tests.
 *
 * Drives the handler directly over a stub `NetworksView` + `AgentPresenceView`
 * (the minimal read-only contracts; no bus, no registry, no HTTP). Covers the
 * graceful no-federation path, the admitted ⋈ presence reconciliation, the
 * self-scoped anomaly-suppression (the registry-Q3-prerequisite reality), the
 * authoritative anomaly path, and read-failure degradation (never 5xx).
 */

import { describe, it, expect } from "bun:test";
import {
  handleListNetworks,
  type NetworksView,
  type ListNetworksResponse,
} from "../api/networks";
import type {
  AgentPresenceSnapshotRecord,
  AgentPresenceView,
} from "../api/agents";
import type { ResolveAdmittedRosterResult } from "../../../bus/agent-network/admission-read";

function presenceView(
  records: AgentPresenceSnapshotRecord[],
): AgentPresenceView {
  return { getAgents: () => records };
}

function rec(
  over: Partial<AgentPresenceSnapshotRecord> & { agentId: string },
): AgentPresenceSnapshotRecord {
  const { agentId } = over;
  return {
    key: `andreas/main/${agentId}`,
    origin: "local",
    nkeyPublicKey: `N${agentId}`,
    assistantName: null,
    principal: "andreas",
    stack: "main",
    capabilities: [],
    state: "online",
    lastSeenAt: 1000,
    ...over,
  };
}

function view(
  rosters: Record<string, ResolveAdmittedRosterResult>,
  localPrincipal = "andreas",
): NetworksView {
  return {
    localPrincipal,
    networks: () =>
      Object.keys(rosters).map((networkId) => ({
        networkId,
        leafNode: `${networkId}-leaf`,
      })),
    resolveAdmittedRoster: (networkId) =>
      Promise.resolve(
        rosters[networkId] ?? {
          ok: false,
          reason: "not_configured",
          detail: "no roster",
        },
      ),
  };
}

async function body(res: Response): Promise<ListNetworksResponse> {
  return (await res.json()) as ListNetworksResponse;
}

describe("handleListNetworks — graceful states", () => {
  it("view === null → empty networks list (no federation configured)", async () => {
    const res = await handleListNetworks(null, null);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ networks: [] });
  });

  it("read failure degrades to a self-only membership, never 5xx", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: false,
          reason: "unreachable",
          detail: "registry down",
        },
      }),
      presenceView([rec({ agentId: "luna" })]),
    );
    expect(res.status).toBe(200);
    const out = await body(res);
    const net = out.networks[0]!;
    expect(net.roster_status).toBe("unreachable");
    expect(net.roster_scope).toBeNull();
    // Self is still a member (joined stack) + present.
    expect(net.members).toEqual([
      { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"] },
    ]);
  });
});

describe("handleListNetworks — authoritative reconciliation", () => {
  it("admitted peer present → admitted-present; admitted peer absent → admitted-absent", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: ["jc", "zeta"], pending: [], authoritative: true },
        },
      }),
      presenceView([
        rec({ agentId: "luna" }), // andreas/main present
        rec({
          agentId: "echo",
          origin: { kind: "foreign", principal: "jc", stack: "research" },
        }),
      ]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.roster_scope).toBe("complete");
    const byPrincipal = Object.fromEntries(net.members.map((m) => [m.principal, m.verdict]));
    expect(byPrincipal).toEqual({
      andreas: "admitted-present",
      jc: "admitted-present",
      zeta: "admitted-absent",
    });
  });

  it("present foreign principal admitted to NO network → present-but-unadmitted (anomaly)", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: ["jc"], pending: [], authoritative: true },
        },
      }),
      presenceView([
        rec({ agentId: "luna" }),
        rec({
          agentId: "x",
          origin: { kind: "foreign", principal: "mallory", stack: "s" },
        }),
      ]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.members).toContainEqual({
      principal: "mallory",
      verdict: "present-but-unadmitted",
      present_stacks: ["s"],
    });
  });

  it("pending admission request surfaces as pending", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          roster: { admitted: [], pending: ["newcomer"], authoritative: true },
        },
      }),
      presenceView([rec({ agentId: "luna" })]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.members).toContainEqual({
      principal: "newcomer",
      verdict: "pending",
      present_stacks: [],
    });
  });
});

describe("handleListNetworks — self-scoped read suppresses anomalies (registry-Q3 reality)", () => {
  it("does NOT flag present peers as anomalies when the roster is self-only", async () => {
    const res = await handleListNetworks(
      view({
        "research-collab": {
          ok: true,
          // self-only read: we know we're admitted, but NOT the peer roster.
          roster: { admitted: ["andreas"], pending: [], authoritative: false },
        },
      }),
      presenceView([
        rec({ agentId: "luna" }),
        rec({
          agentId: "echo",
          origin: { kind: "foreign", principal: "jc", stack: "research" },
        }),
      ]),
    );
    const net = (await body(res)).networks[0]!;
    expect(net.roster_scope).toBe("self");
    // jc is present but must NOT be flagged unadmitted — we can't prove it.
    expect(net.members.some((m) => m.verdict === "present-but-unadmitted")).toBe(false);
    expect(net.members.map((m) => m.principal)).toEqual(["andreas"]);
  });
});
