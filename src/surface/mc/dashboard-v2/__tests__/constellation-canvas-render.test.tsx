/**
 * MC-D3 (cortex#1290) — render tests for the constellation canvas re-skin's
 * presentational pieces that render WITHOUT the xyflow provider:
 *
 *   - `ConstellationHeader` — the on-canvas `<NETWORK> · admin|member · N stacks`
 *     strip (admin/member vocab; aggregate-only — no session affordance).
 *   - `StackHubCard` — the `● YOU ARE HERE` anchor renders ONLY on the serving
 *     (local) stack, never on a federated peer hub.
 *
 * Both are pure (no hooks / no xyflow `<Handle>`), so they render under
 * `renderToStaticMarkup`. The xyflow-bound canvas + edge label are exercised by
 * the pure adapter/edge-flag tests instead (they can't mount DOM-less).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ConstellationHeader } from "../components/constellation-header";
import { StackHubCard } from "../components/network-nodes";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import type { StackHubNodeData } from "../lib/network-graph-adapter";

function net(over: Partial<NetworkMembershipDTO>): NetworkMembershipDTO {
  return {
    network_id: "meridian",
    leaf_node: "leaf-1",
    roster_status: "ok",
    roster_scope: "complete",
    confidentiality: { mode: "off", key_present: false, key_id: null },
    members: [
      { principal: "andreas", verdict: "admitted-present", present_stacks: ["research"], accepts: "self" },
    ],
    ...over,
  };
}

function hub(over: Partial<StackHubNodeData>): StackHubNodeData {
  return {
    kind: "stack-hub",
    origin: "local",
    servingPrincipal: "andreas",
    principal: "andreas",
    stack: "research",
    agentCount: 2,
    stackColor: "#5cc8ff",
    ...over,
  };
}

describe("ConstellationHeader (MC-D3 on-canvas network header)", () => {
  it("renders nothing for a non-federated stack (no joined networks)", () => {
    expect(renderToStaticMarkup(createElement(ConstellationHeader, { networks: [] }))).toBe("");
  });

  it("an admin-posture network reads `admin` + a present-stack count", () => {
    const html = renderToStaticMarkup(
      createElement(ConstellationHeader, {
        networks: [net({ roster_scope: "complete" })],
      }),
    );
    expect(html).toContain('data-posture="admin"');
    expect(html).toContain(">admin<");
    expect(html).toContain("1 stack");
  });

  it("a self-scoped network reads `member` (never admin)", () => {
    const html = renderToStaticMarkup(
      createElement(ConstellationHeader, {
        networks: [net({ roster_scope: "self" })],
      }),
    );
    expect(html).toContain('data-posture="member"');
    expect(html).toContain(">member<");
    expect(html).not.toContain('data-posture="admin"');
  });

  it("AGGREGATE-ONLY — the header surfaces no session affordance (no peer drill)", () => {
    const html = renderToStaticMarkup(
      createElement(ConstellationHeader, {
        networks: [
          net({
            network_id: "tide",
            roster_scope: "self",
            members: [
              { principal: "jc", verdict: "admitted-present", present_stacks: ["research"], accepts: "accepted-network" },
            ],
          }),
        ],
      }),
    );
    // No session word anywhere in the federated-peer-bearing header markup.
    expect(html.toLowerCase()).not.toContain("session");
  });
});

describe("StackHubCard — ● YOU ARE HERE anchor (MC-D3)", () => {
  it("renders the anchor on the SELF (local-origin) stack hub", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, { data: hub({ origin: "local" }) }),
    );
    expect(html).toContain('data-you-are-here="true"');
    expect(html).toContain("YOU ARE HERE");
  });

  it("does NOT render the anchor on a federated peer hub", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, {
        data: hub({
          origin: { principal: "jc", stack: "research" },
          principal: "jc",
          stack: "research",
        }),
      }),
    );
    expect(html).not.toContain("YOU ARE HERE");
  });

  it("does NOT render the anchor on a same-principal SIBLING hub (only the serving stack)", () => {
    const html = renderToStaticMarkup(
      createElement(StackHubCard, {
        data: hub({
          // A same-principal object origin (DB-read sibling) is local but NOT the
          // serving stack — only the literal local origin earns the anchor.
          origin: { principal: "andreas", stack: "work" },
          stack: "work",
        }),
      }),
    );
    expect(html).not.toContain("YOU ARE HERE");
  });
});
