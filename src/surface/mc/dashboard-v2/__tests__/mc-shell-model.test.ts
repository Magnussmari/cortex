/**
 * MC-D2 (cortex#1289) — shell-chrome pure-model tests.
 *
 * Pins the navigation + posture logic behind the command bar + altitude rail:
 *   - posture derivation (admin iff complete-roster read; member otherwise) and
 *     the load-bearing vocabulary (`admin`/`member`, never the deprecated label);
 *   - per-network posture at the root is `null` (no single posture to report);
 *   - breadcrumb derivation (root always present; network appends a segment);
 *   - drill / ascend / segment navigation;
 *   - rail stop reachability (networks always reachable, network gated on data,
 *     deeper levels are honest `future` stubs).
 */

import { describe, it, expect } from "bun:test";
import type {
  NetworkMembershipDTO,
  MembershipMemberDTO,
} from "../hooks/use-networks";
import {
  ALTITUDE_LEVELS,
  ALTITUDE_META,
  ROOT_SELECTION,
  networkPosture,
  selectedNetworkPosture,
  buildBreadcrumb,
  drillToNetwork,
  ascendToRoot,
  navigateToSegment,
  stopReachability,
  type AltitudeSelection,
} from "../lib/mc-shell-model";

function member(
  over: Partial<MembershipMemberDTO> & { principal: string },
): MembershipMemberDTO {
  return { verdict: "admitted-present", present_stacks: [], accepts: "not-accepted", ...over };
}

function net(
  over: Partial<NetworkMembershipDTO> & { network_id: string },
): NetworkMembershipDTO {
  return {
    leaf_node: `${over.network_id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    members: [],
    confidentiality: { mode: "off", key_present: false, key_id: null },
    ...over,
  };
}

describe("MC-D2 shell model — posture", () => {
  it("admin iff the admin-authoritative (complete) roster read succeeded", () => {
    expect(
      networkPosture(net({ network_id: "meridian", roster_scope: "complete" })),
    ).toBe("admin");
  });

  it("member for a self-scoped read (not authoritative — fail-closed)", () => {
    expect(
      networkPosture(net({ network_id: "tide", roster_scope: "self" })),
    ).toBe("member");
  });

  it("member for any degraded/unauthorized/unreachable read", () => {
    for (const status of ["unreachable", "unauthorized", "not_configured"] as const) {
      expect(
        networkPosture(
          net({ network_id: "x", roster_status: status, roster_scope: null }),
        ),
      ).toBe("member");
    }
  });

  it("never emits the deprecated posture term — only admin/member", () => {
    // Built from fragments so this source file carries no literal deprecated
    // token (the vocabulary gate is grep-based); the guard stays real.
    const FORBIDDEN = ["oper", "ator"].join("");
    const values = [
      networkPosture(net({ network_id: "a", roster_scope: "complete" })),
      networkPosture(net({ network_id: "b", roster_scope: "self" })),
    ];
    expect(values).toEqual(["admin", "member"]);
    expect(values).not.toContain(FORBIDDEN);
  });
});

describe("MC-D2 shell model — selected posture", () => {
  const networks = [
    net({ network_id: "meridian", roster_scope: "complete" }),
    net({ network_id: "tide", roster_scope: "self" }),
  ];

  it("is null at the 10k-ft root (no single network → no single posture)", () => {
    expect(selectedNetworkPosture(networks, ROOT_SELECTION)).toBeNull();
  });

  it("reports the drilled-into network's posture", () => {
    expect(
      selectedNetworkPosture(networks, drillToNetwork("meridian")),
    ).toBe("admin");
    expect(selectedNetworkPosture(networks, drillToNetwork("tide"))).toBe(
      "member",
    );
  });

  it("is null when the selected network is no longer present", () => {
    expect(
      selectedNetworkPosture(networks, drillToNetwork("vanished")),
    ).toBeNull();
  });
});

describe("MC-D2 shell model — breadcrumb", () => {
  it("root selection yields only NETWORK·OF·NETWORKS", () => {
    const crumbs = buildBreadcrumb(ROOT_SELECTION);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      label: "NETWORK·OF·NETWORKS",
      level: "networks",
      networkId: null,
    });
  });

  it("a drilled network appends a second segment", () => {
    const crumbs = buildBreadcrumb(drillToNetwork("meridian"));
    expect(crumbs).toHaveLength(2);
    expect(crumbs[1]).toMatchObject({
      label: "meridian",
      level: "network",
      networkId: "meridian",
    });
  });
});

describe("MC-D2 shell model — navigation", () => {
  it("drillToNetwork sets network level + id", () => {
    expect(drillToNetwork("meridian")).toEqual({
      level: "network",
      networkId: "meridian",
    });
  });

  it("ascendToRoot returns the 10k-ft root", () => {
    expect(ascendToRoot()).toEqual(ROOT_SELECTION);
  });

  it("navigateToSegment ascends on the root segment, drills on a network segment", () => {
    const [root, network] = buildBreadcrumb(drillToNetwork("meridian"));
    expect(navigateToSegment(root!)).toEqual(ROOT_SELECTION);
    expect(navigateToSegment(network!)).toEqual(drillToNetwork("meridian"));
  });
});

describe("MC-D2 shell model — rail stop reachability", () => {
  const root: AltitudeSelection = ROOT_SELECTION;

  it("the current level is `current`", () => {
    expect(stopReachability("networks", root, 2)).toBe("current");
    expect(stopReachability("network", drillToNetwork("meridian"), 2)).toBe(
      "current",
    );
  });

  it("networks is always reachable from a deeper level", () => {
    expect(
      stopReachability("networks", drillToNetwork("meridian"), 2),
    ).toBe("reachable");
  });

  it("network is reachable iff ≥1 network is joined", () => {
    expect(stopReachability("network", root, 2)).toBe("reachable");
    expect(stopReachability("network", root, 0)).toBe("future");
  });

  it("stack/assistant/session are future stubs in D2", () => {
    for (const lvl of ["stack", "assistant", "session"] as const) {
      expect(stopReachability(lvl, root, 9)).toBe("future");
    }
  });
});

describe("MC-D2 shell model — altitude metadata", () => {
  it("names all five levels in 10k-ft → deepest order", () => {
    expect(ALTITUDE_LEVELS).toEqual([
      "networks",
      "network",
      "stack",
      "assistant",
      "session",
    ]);
  });

  it("only the NETWORKS root carries an altitude annotation", () => {
    expect(ALTITUDE_META.networks.altLabel).toBe("10k ft");
    expect(ALTITUDE_META.network.altLabel).toBeUndefined();
  });
});
