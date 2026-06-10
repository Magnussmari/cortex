/**
 * Unit tests for the multi-server resolution helper.
 *
 * The `discord` CLI was single-guild: one top-level guildId + channels map.
 * `resolveServerContext` layers two complementary overrides over that base —
 * a `--guild <id>` flag and a `--server <name>` named profile — with the
 * precedence `--guild`/`--channel` > `--server` profile > top-level config.
 *
 * These tests pin that precedence and, critically, the back-compat invariant:
 * with no flags the resolved context is identical to the top-level config so
 * the legacy single-guild path is untouched.
 */

import { describe, expect, test } from "bun:test";
import type { DiscordCliConfig } from "../lib/config";
import {
  resolveServerContext,
  registerServerProfile,
  cachedChannelId,
  cacheChannelId,
  ServerContextError,
} from "../lib/server-context";

// Real guild IDs from the deployment: grove (top-level) + halden (profile).
const GROVE_GUILD = "1487023327791808592";
const HALDEN_GUILD = "1512054429023731884";

function baseConfig(): DiscordCliConfig {
  return {
    botToken: "grove-token",
    guildId: GROVE_GUILD,
    defaultChannel: "cortex",
    channels: { cortex: { id: "111" } },
    servers: {
      halden: {
        guildId: HALDEN_GUILD,
        defaultChannel: "general",
        channels: { general: { id: "1512054429480648837" } },
      },
    },
  };
}

describe("resolveServerContext — back-compat (no flags)", () => {
  test("no flags resolves to the top-level config verbatim", () => {
    const config = baseConfig();
    const ctx = resolveServerContext(config, {});
    expect(ctx.guildId).toBe(GROVE_GUILD);
    expect(ctx.botToken).toBe("grove-token");
    expect(ctx.defaultChannel).toBe("cortex");
    expect(ctx.channels).toEqual({ cortex: { id: "111" } });
    expect(ctx.serverName).toBeUndefined();
  });

  test("no flags: channels map is tagged with the effective guild (cache valid)", () => {
    // With no override the channels map belongs to the effective guild, so the
    // caller's cached-id short-circuit stays valid (back-compat #838).
    const ctx = resolveServerContext(baseConfig(), {});
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD);
    expect(ctx.channelsGuildId).toBe(ctx.guildId);
  });

  test("no flags on a minimal config (no servers block) is unchanged", () => {
    const config: DiscordCliConfig = {
      botToken: "t",
      guildId: GROVE_GUILD,
      defaultChannel: "cortex",
    };
    const ctx = resolveServerContext(config, {});
    expect(ctx.guildId).toBe(GROVE_GUILD);
    expect(ctx.botToken).toBe("t");
    expect(ctx.defaultChannel).toBe("cortex");
  });
});

describe("resolveServerContext — --guild flag (ISC-C2/C3)", () => {
  test("--guild overrides guildId for name resolution", () => {
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
  });

  test("--guild keeps the top-level token and channels (token guild-agnostic)", () => {
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(ctx.botToken).toBe("grove-token");
    expect(ctx.channels).toEqual({ cortex: { id: "111" } });
    expect(ctx.serverName).toBeUndefined();
  });

  test("--guild tags the top-level channels map with the top-level guild (#838)", () => {
    // The cached channels map still belongs to the TOP-LEVEL guild, not the
    // override target — channelsGuildId must reflect that so the caller's
    // cached-id short-circuit can tell the map is for the wrong guild.
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD);
    // Effective guild != channels-map guild → the cache must NOT be trusted.
    expect(ctx.channelsGuildId).not.toBe(ctx.guildId);
  });
});

describe("resolveServerContext — --server profile (ISC-C7/C8)", () => {
  test("--server overrides guildId with the profile's guildId", () => {
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.serverName).toBe("halden");
  });

  test("--server uses the profile's defaultChannel and channels", () => {
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(ctx.defaultChannel).toBe("general");
    expect(ctx.channels).toEqual({ general: { id: "1512054429480648837" } });
  });

  test("--server with its own channels tags them with the profile guild (cache valid)", () => {
    // A profile that carries its own channels map: the map belongs to the
    // profile's guild, which IS the effective guild → cache stays trusted.
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.channelsGuildId).toBe(HALDEN_GUILD);
    expect(ctx.channelsGuildId).toBe(ctx.guildId);
  });

  test("--server falls back to top-level token/channel when profile omits them", () => {
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.botToken).toBe("grove-token"); // fell back to top-level
    expect(ctx.defaultChannel).toBe("cortex"); // fell back to top-level
    expect(ctx.channels).toEqual({ cortex: { id: "111" } });
  });

  test("--server WITHOUT channels inherits top-level map tagged with the WRONG guild (#838)", () => {
    // The subtler #838 trap: a profile that omits its channels map inherits the
    // top-level (grove) map, but the effective guild is the profile's. The
    // inherited map belongs to grove, NOT the target — channelsGuildId exposes
    // the mismatch so the caller skips the cache.
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.channels).toEqual({ cortex: { id: "111" } }); // inherited grove map
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD); // …but it's grove's map
    expect(ctx.channelsGuildId).not.toBe(ctx.guildId);
  });

  test("--server uses the profile's own token when present", () => {
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD, botToken: "halden-token" } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(ctx.botToken).toBe("halden-token");
  });
});

describe("resolveServerContext — precedence (ISC-C9)", () => {
  test("--guild beats the --server profile guildId when they agree-or-not", () => {
    const config = baseConfig();
    // profile resolves to HALDEN, but explicit --guild wins for guildId.
    const ctx = resolveServerContext(config, { server: "halden", guild: HALDEN_GUILD });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    // profile's channels/defaultChannel still layered in.
    expect(ctx.defaultChannel).toBe("general");
  });

  test("--guild + matching --server keeps the profile's channels-map guild (cache valid)", () => {
    // When the explicit --guild equals the profile guild, the profile's own
    // channels map is still for the effective guild → cache trusted.
    const ctx = resolveServerContext(baseConfig(), { server: "halden", guild: HALDEN_GUILD });
    expect(ctx.channelsGuildId).toBe(HALDEN_GUILD);
    expect(ctx.channelsGuildId).toBe(ctx.guildId);
  });
});

describe("resolveServerContext — error paths (ISC-C11/C12)", () => {
  test("unknown --server profile throws loudly", () => {
    expect(() => resolveServerContext(baseConfig(), { server: "nope" })).toThrow(
      ServerContextError
    );
  });

  test("profile missing guildId fails loudly", () => {
    const config = baseConfig();
    // Simulate a hand-edited profile with no guildId.
    config.servers = { broken: { guildId: "" } };
    expect(() => resolveServerContext(config, { server: "broken" })).toThrow(
      /missing guildId/
    );
  });

  test("conflicting --guild and --server (different guilds) errors clearly", () => {
    expect(() =>
      resolveServerContext(baseConfig(), { server: "halden", guild: GROVE_GUILD })
    ).toThrow(/Conflicting guild/);
  });

  test("matching --guild and --server (same guild) does NOT error", () => {
    const ctx = resolveServerContext(baseConfig(), {
      server: "halden",
      guild: HALDEN_GUILD,
    });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
  });

  test("error messages never include the bot token", () => {
    try {
      resolveServerContext(baseConfig(), { server: "nope" });
    } catch (err) {
      expect((err as Error).message).not.toContain("grove-token");
    }
  });
});

describe("cachedChannelId — guild-scoped cache gate (#838)", () => {
  test("no override: cached id IS used (back-compat)", () => {
    // cortex exists in the top-level grove map; no flags → effective guild ==
    // channels-map guild → the fast path returns the cached id "111".
    const ctx = resolveServerContext(baseConfig(), {});
    expect(cachedChannelId(ctx, "cortex")).toBe("111");
  });

  test("bare --guild + name in top-level map: cached id is NOT used (the bug)", () => {
    // This is the exact #838 mis-route: `discord post --guild <other> -c cortex`.
    // "cortex" exists in grove's map, but the effective guild is HALDEN — the
    // cached grove id must be skipped so the caller resolves by name in HALDEN.
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(ctx.channels?.cortex?.id).toBe("111"); // the trap id is present…
    expect(cachedChannelId(ctx, "cortex")).toBeUndefined(); // …but NOT returned
  });

  test("--server with its own channels: cached id IS used", () => {
    // halden profile carries its own channels map for its own guild → trusted.
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(cachedChannelId(ctx, "general")).toBe("1512054429480648837");
  });

  test("--server WITHOUT channels (inherits top-level map): cached id is NOT used", () => {
    // The subtler trap: profile inherits grove's map but targets HALDEN.
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(ctx.channels?.cortex?.id).toBe("111");
    expect(cachedChannelId(ctx, "cortex")).toBeUndefined();
  });

  test("--guild equal to the top-level guild: cached id IS used (no real override)", () => {
    // Passing --guild that equals config.guildId is a no-op override — the cache
    // is still for the right guild, so the fast path stays valid.
    const ctx = resolveServerContext(baseConfig(), { guild: GROVE_GUILD });
    expect(cachedChannelId(ctx, "cortex")).toBe("111");
  });

  test("matching --guild + --server: profile cached id IS used", () => {
    const ctx = resolveServerContext(baseConfig(), { server: "halden", guild: HALDEN_GUILD });
    expect(cachedChannelId(ctx, "general")).toBe("1512054429480648837");
  });

  test("unknown channel name returns undefined even when the cache is valid", () => {
    const ctx = resolveServerContext(baseConfig(), {});
    expect(cachedChannelId(ctx, "does-not-exist")).toBeUndefined();
  });
});

describe("cacheChannelId — write-guard against foreign-guild poisoning (#838)", () => {
  const COMMUNITY_GUILD = "1505549701674700991";
  const COMMUNITY_CORTEX_ID = "9999999999999999999";

  test("no flags: writes the resolved id into the top-level map (back-compat)", () => {
    // Fresh config with no channels map yet (first-ever resolution of #cortex).
    const config: DiscordCliConfig = { botToken: "grove-token", guildId: GROVE_GUILD };
    const ctx = resolveServerContext(config, {});
    const wrote = cacheChannelId(config, ctx, "cortex", "111");
    expect(wrote).toBe(true);
    expect(config.channels?.cortex?.id).toBe("111");
  });

  test("--server profile: writes into the PROFILE's channels map, not top-level", () => {
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD } }; // no channels yet
    const ctx = resolveServerContext(config, { server: "halden" });
    const wrote = cacheChannelId(config, ctx, "general", "777");
    expect(wrote).toBe(true);
    expect(config.servers?.halden?.channels?.general?.id).toBe("777");
    // Top-level grove map is left untouched.
    expect(config.channels).toEqual({ cortex: { id: "111" } });
  });

  test("bare --guild to a FOREIGN guild: write is DROPPED, top-level map untouched", () => {
    const config = baseConfig();
    const ctx = resolveServerContext(config, { guild: COMMUNITY_GUILD });
    const wrote = cacheChannelId(config, ctx, "cortex", COMMUNITY_CORTEX_ID);
    expect(wrote).toBe(false);
    // The grove id must survive — the community id must NOT poison the map.
    expect(config.channels?.cortex?.id).toBe("111");
  });

  test("--guild equal to top-level guild: write IS performed (no real override)", () => {
    const config: DiscordCliConfig = { botToken: "grove-token", guildId: GROVE_GUILD };
    const ctx = resolveServerContext(config, { guild: GROVE_GUILD });
    const wrote = cacheChannelId(config, ctx, "cortex", "111");
    expect(wrote).toBe(true);
    expect(config.channels?.cortex?.id).toBe("111");
  });

  // The reviewer's BLOCKER sequence, end-to-end against the pure helpers:
  // post --guild <community> -c cortex  → then a later no-flag post -c cortex.
  test("post --guild <community> then a no-flag post resolves in GROVE, not the cached community id", () => {
    const config = baseConfig();

    // 1) `discord post --guild <community> -c cortex "..."`
    const guildCtx = resolveServerContext(config, { guild: COMMUNITY_GUILD });
    // Read gate already skips the cache (effective guild != channels-map guild).
    expect(cachedChannelId(guildCtx, "cortex")).toBeUndefined();
    // …it resolves COMMUNITY_CORTEX_ID by name and tries to cache it. The
    // write-guard must DROP that write so the top-level map stays grove's.
    const wrote = cacheChannelId(config, guildCtx, "cortex", COMMUNITY_CORTEX_ID);
    expect(wrote).toBe(false);
    expect(config.channels?.cortex?.id).toBe("111"); // grove id intact

    // 2) `discord post -c cortex "..."` (next invocation, NO flags)
    const noFlagCtx = resolveServerContext(config, {});
    // Cache is valid here (grove==grove), and it must return the GROVE id —
    // NOT the community id, which never made it into the map.
    expect(cachedChannelId(noFlagCtx, "cortex")).toBe("111");
    expect(cachedChannelId(noFlagCtx, "cortex")).not.toBe(COMMUNITY_CORTEX_ID);
  });

  test("write-guard holds even with no top-level guildId configured", () => {
    // Defensive: a config that never set guildId. ctx.guildId is undefined →
    // `!ctx.guildId` short-circuits true → top-level write allowed (there is no
    // other guild to confuse it with).
    const config: DiscordCliConfig = { botToken: "t" };
    const ctx = resolveServerContext(config, {});
    const wrote = cacheChannelId(config, ctx, "cortex", "111");
    expect(wrote).toBe(true);
    expect(config.channels?.cortex?.id).toBe("111");
  });
});

describe("registerServerProfile (ISC-C13)", () => {
  test("registers a new profile with guildId only", () => {
    const config: DiscordCliConfig = { botToken: "t", guildId: GROVE_GUILD };
    registerServerProfile(config, "halden", HALDEN_GUILD);
    expect(config.servers?.halden?.guildId).toBe(HALDEN_GUILD);
  });

  test("registers a profile with a default channel", () => {
    const config: DiscordCliConfig = {};
    registerServerProfile(config, "halden", HALDEN_GUILD, "general");
    expect(config.servers?.halden?.defaultChannel).toBe("general");
  });

  test("updating an existing profile preserves its cached channels", () => {
    const config: DiscordCliConfig = {
      servers: { halden: { guildId: "old", channels: { general: { id: "999" } } } },
    };
    registerServerProfile(config, "halden", HALDEN_GUILD);
    expect(config.servers?.halden?.guildId).toBe(HALDEN_GUILD);
    expect(config.servers?.halden?.channels).toEqual({ general: { id: "999" } });
  });

  test("never writes a token onto the profile", () => {
    const config: DiscordCliConfig = {};
    registerServerProfile(config, "halden", HALDEN_GUILD, "general");
    expect(config.servers?.halden?.botToken).toBeUndefined();
  });

  test("empty guildId throws", () => {
    const config: DiscordCliConfig = {};
    expect(() => registerServerProfile(config, "halden", "")).toThrow(ServerContextError);
  });
});
