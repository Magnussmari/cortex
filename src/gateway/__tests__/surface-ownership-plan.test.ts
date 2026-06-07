import { describe, expect, test } from "bun:test";
import {
  gatewayAdapterInstanceCollisions,
  planSurfaceOwnership,
} from "../surface-ownership-plan";
import type { Surfaces } from "../../common/types/surfaces";

const SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        token: "discord-token",
        guildId: "111222333444555666",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
    {
      agent: "sage",
      stack: "robin/research",
      binding: {
        token: "discord-token-2",
        guildId: "222333444555666777",
        agentChannelId: "ccc000000000000003",
        logChannelId: "ddd000000000000004",
      },
    },
  ],
  slack: [
    {
      agent: "echo",
      stack: "andreas/meta-factory",
      binding: {
        botToken: "xoxb-aaa",
        appToken: "xapp-bbb",
        workspaceId: "T01234567",
      },
    },
  ],
  mattermost: [
    {
      agent: "nova",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-token",
      },
    },
  ],
};

describe("planSurfaceOwnership", () => {
  test("flag off keeps an inactive plan even when surfaces have bindings", () => {
    const plan = planSurfaceOwnership({
      surfaces: SURFACES,
      gatewayEnabled: false,
      principal: "andreas",
    });

    expect(plan.gatewayEnabled).toBe(false);
    expect(plan.hasSurfaceBindings).toBe(true);
    expect(plan.gatewayStartEligible).toBe(false);
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
    expect(plan.gatewayAdapterInstanceIds).toEqual([]);
    expect(plan.outboundStacks).toEqual([]);
    expect(plan.outboundPrincipalStacks).toEqual([]);
    expect(plan.crossPrincipalBindings).toEqual([]);
  });

  test("flag on with no surfaces keeps a graceful no-start plan", () => {
    const plan = planSurfaceOwnership({
      surfaces: undefined,
      gatewayEnabled: true,
      principal: "andreas",
    });

    expect(plan.gatewayEnabled).toBe(true);
    expect(plan.hasSurfaceBindings).toBe(false);
    expect(plan.gatewayStartEligible).toBe(false);
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
  });

  test("flag on with an empty surfaces map keeps a no-start plan", () => {
    const plan = planSurfaceOwnership({
      surfaces: { discord: [], slack: [], mattermost: [] },
      gatewayEnabled: true,
      principal: "andreas",
    });

    expect(plan.gatewayEnabled).toBe(true);
    expect(plan.hasSurfaceBindings).toBe(false);
    expect(plan.gatewayStartEligible).toBe(false);
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
    expect(plan.gatewayAdapterInstanceIds).toEqual([]);
    expect(plan.outboundStacks).toEqual([]);
    expect(plan.outboundPrincipalStacks).toEqual([]);
  });

  test("flag on with bindings plans suppression, Gateway ids, and outbound subjects", () => {
    const plan = planSurfaceOwnership({
      surfaces: SURFACES,
      gatewayEnabled: true,
      principal: "andreas",
    });

    expect(plan.gatewayStartEligible).toBe(true);
    expect([...plan.ownedSurfaceKeys].sort()).toEqual([
      "discord:luna",
      "discord:sage",
      "mattermost:nova",
      "slack:echo",
    ]);
    expect(plan.gatewayAdapterInstanceIds).toEqual([
      "discord:111222333444555666",
      "discord:222333444555666777",
      "slack:T01234567",
      "mattermost:https://mm.example.com",
    ]);
    expect(plan.outboundStacks).toEqual(["meta-factory", "research", undefined]);
    expect(plan.outboundPrincipalStacks).toEqual([
      { principal: "andreas", stack: "meta-factory" },
      { principal: "robin", stack: "research" },
      { principal: "andreas", stack: undefined },
    ]);
    expect(plan.crossPrincipalBindings).toEqual(["robin/research"]);
  });
});

describe("gatewayAdapterInstanceCollisions", () => {
  test("reports Gateway adapter ids that collide with per-stack adapter ids", () => {
    const collisions = gatewayAdapterInstanceCollisions(
      [
        { instanceId: "discord:111222333444555666" },
        { instanceId: "slack-stack" },
      ],
      [
        { instanceId: "discord:111222333444555666" },
        { instanceId: "slack:T01234567" },
      ],
    );

    expect(collisions).toEqual(["discord:111222333444555666"]);
  });

  test("returns an empty list when instance id sets are disjoint", () => {
    const collisions = gatewayAdapterInstanceCollisions(
      [{ instanceId: "discord-stack" }],
      [{ instanceId: "discord:111222333444555666" }],
    );

    expect(collisions).toEqual([]);
  });
});
