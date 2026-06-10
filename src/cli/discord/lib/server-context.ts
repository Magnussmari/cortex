/**
 * Server-context resolution — the single place that decides WHICH guild a
 * `discord` command resolves channel/thread names against, and which
 * token / default-channel / cached-channels apply.
 *
 * Two complementary mechanisms layer over the single-guild base config:
 *
 *   1. `-g, --guild <id>`   — overrides the guildId used for NAME resolution.
 *   2. `-s, --server <name>` — selects a named profile from `config.servers`,
 *      layering its guildId (required) plus optional botToken / defaultChannel
 *      / channels over the top-level values.
 *
 * Precedence (highest wins): explicit `--guild` flag  >  `--server` profile
 * >  top-level config. The `--channel` flag (handled by the caller) likewise
 * beats a profile's `defaultChannel`.
 *
 * Back-compat invariant: with neither `--guild` nor `--server`, the resolved
 * context is byte-identical to the top-level config — the legacy single-guild
 * path is untouched.
 *
 * This module is intentionally PURE (no I/O, no process.exit, no network) so
 * the precedence logic is unit-testable in isolation. Callers translate a
 * thrown `ServerContextError` into a CLI error + exit code.
 */

import type { ChannelConfig, DiscordCliConfig, ServerProfile } from "./config";

/** Flags that influence server-context resolution, parsed from argv. */
export interface ServerContextOptions {
  /** Raw `--guild <id>` value, if provided. */
  guild?: string;
  /** Raw `--server <name>` value, if provided. */
  server?: string;
}

/**
 * The effective context a command operates in after layering flags + profile
 * over the base config. `guildId` may still be undefined when nothing supplies
 * one (same as today's "Guild ID required" path) — the caller validates it.
 */
export interface ResolvedServerContext {
  /** Guild ID used for channel/thread NAME resolution (may be undefined). */
  guildId?: string;
  /** Bot token to authenticate API calls (may be undefined). */
  botToken?: string;
  /** Default channel name when none passed on the command line. */
  defaultChannel?: string;
  /**
   * Cached channel name→id map. A cached id is a Discord SNOWFLAKE that is only
   * valid in the guild it was resolved against — see `channelsGuildId`. Callers
   * MUST gate the cached-id short-circuit on `channelsGuildId === guildId`.
   */
  channels?: Record<string, ChannelConfig>;
  /**
   * The guild the `channels` map belongs to (the guild its cached ids were
   * resolved against). When this differs from `guildId` — e.g. a bare `--guild`
   * override, or a `--server` profile that inherited the top-level map — the
   * cached ids are for the WRONG guild and the caller must resolve by NAME in
   * the target guild instead of trusting the cache (#838).
   */
  channelsGuildId?: string;
  /** Name of the profile applied, when `--server` was used. */
  serverName?: string;
}

/** Raised for caller-facing, user-fixable resolution failures. */
export class ServerContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerContextError";
  }
}

/**
 * Resolve the effective server context from base config + flags.
 *
 * @throws ServerContextError when the named profile is unknown, the profile
 *   is missing its required guildId, or `--guild` and `--server` disagree on
 *   the guild.
 */
export function resolveServerContext(
  config: DiscordCliConfig,
  opts: ServerContextOptions
): ResolvedServerContext {
  // Start from the top-level (grove) values — the no-flag path returns these
  // unchanged, preserving byte-identical legacy behaviour.
  let guildId = config.guildId;
  let botToken = config.botToken;
  let defaultChannel = config.defaultChannel;
  let channels = config.channels;
  let serverName: string | undefined;
  // The guild the `channels` map belongs to. It tracks the SOURCE of the map,
  // not the effective guild: it advances to a profile's guild only when that
  // profile supplies its OWN channels map. A bare `--guild` override (Layer 2)
  // moves `guildId` but NOT this, exposing the cache-is-for-the-wrong-guild
  // mismatch the caller gates on (#838).
  let channelsGuildId = config.guildId;

  // ── Layer 1: named server profile ────────────────────────────────────────
  if (opts.server) {
    const profile = config.servers?.[opts.server];
    if (!profile) {
      throw new ServerContextError(
        `Server profile "${opts.server}" not found. ` +
          `Register it with: discord config set-server ${opts.server} <guildId>`
      );
    }
    if (!profile.guildId) {
      throw new ServerContextError(
        `Server profile "${opts.server}" is missing guildId. ` +
          `Set it with: discord config set-server ${opts.server} <guildId>`
      );
    }
    guildId = profile.guildId;
    serverName = opts.server;
    // Optional overrides fall back to the top-level values when absent.
    if (profile.botToken) botToken = profile.botToken;
    if (profile.defaultChannel) defaultChannel = profile.defaultChannel;
    // Only when the profile carries its OWN channels map does that map belong
    // to the profile's guild. If it inherits the top-level map, the map (and
    // its `channelsGuildId`) stay grove's — so the caller won't trust it here.
    if (profile.channels) {
      channels = profile.channels;
      channelsGuildId = profile.guildId;
    }
  }

  // ── Layer 2: explicit --guild flag (highest precedence for guildId) ───────
  if (opts.guild) {
    // A profile + an explicit guild that disagree is almost certainly a
    // principal mistake — fail loudly rather than silently picking one.
    if (serverName && guildId && opts.guild !== guildId) {
      throw new ServerContextError(
        `Conflicting guild: --guild ${opts.guild} but --server "${serverName}" ` +
          `resolves to guild ${guildId}. Pass only one, or make them agree.`
      );
    }
    // Move the effective guild but NOT `channelsGuildId`: a bare `--guild`
    // never re-tags the inherited channels map. If it equals `channelsGuildId`
    // already (matching --server, or --guild == top-level) the cache stays
    // valid; otherwise the caller resolves by name in the target guild.
    guildId = opts.guild;
  }

  return { guildId, botToken, defaultChannel, channels, channelsGuildId, serverName };
}

/**
 * Read a cached channel id from a resolved context, honouring the guild scope
 * of the cache. A cached id is a Discord snowflake valid ONLY in the guild it
 * was resolved against (`channelsGuildId`); when the effective `guildId` differs
 * — a bare `--guild` override, or a `--server` profile that inherited the
 * top-level map — the cache is for the wrong guild and this returns undefined so
 * the caller resolves by NAME in the target guild instead (#838). With no
 * override the two guild ids match and the legacy cached-id fast path is kept.
 *
 * Pure: no I/O. The single source of truth for "is this cached id trustworthy
 * for the guild we're about to post to?".
 */
export function cachedChannelId(
  ctx: ResolvedServerContext,
  channelName: string
): string | undefined {
  if (ctx.channelsGuildId !== ctx.guildId) return undefined;
  return ctx.channels?.[channelName]?.id;
}

/**
 * Cache a freshly-resolved channel id back into config, writing to the active
 * server profile's `channels` map when a `--server` profile is in effect, else
 * to the top-level `channels`. Keeps each guild's name→id cache isolated so a
 * name that exists in two guilds never cross-contaminates.
 *
 * The top-level write is GUARDED on the effective guild actually BEING the
 * top-level guild (`!ctx.guildId || ctx.guildId === config.guildId`). A cached
 * id is a Discord snowflake valid only in its resolving guild, so a bare
 * `--guild <other>` (no profile) must NOT persist a foreign-guild id into the
 * top-level map — that would make a later no-flag post read the wrong id and
 * re-trigger #838 one invocation later. With no per-guild map to own those ids,
 * the right move is to DROP the write (resolve-by-name stays correct anyway).
 *
 * Returns whether anything was written, so the caller can skip a pointless
 * `saveConfig` when the write was dropped. Mutates `config` in place; does NOT
 * persist.
 */
export function cacheChannelId(
  config: DiscordCliConfig,
  ctx: ResolvedServerContext,
  channelName: string,
  channelId: string
): boolean {
  const profile = ctx.serverName ? config.servers?.[ctx.serverName] : undefined;
  if (profile) {
    profile.channels ??= {};
    profile.channels[channelName] = { id: channelId };
    return true;
  }
  // No profile: only the top-level map is a candidate, and only when the
  // effective guild is the top-level guild. A bare `--guild` to a different
  // guild has no map to own its ids — drop the write rather than poison grove.
  if (!ctx.guildId || ctx.guildId === config.guildId) {
    config.channels ??= {};
    config.channels[channelName] = { id: channelId };
    return true;
  }
  return false;
}

/**
 * Register (or update) a named server profile in the config object, mutating
 * and returning it. Pure aside from the in-place mutation — does NOT persist;
 * the caller saves. `guildId` is required; `defaultChannel` is optional. A
 * per-profile token is intentionally NOT settable here so this command never
 * writes a token (token sharing across guilds is the whole point).
 *
 * @throws ServerContextError on an empty name or guildId.
 */
export function registerServerProfile(
  config: DiscordCliConfig,
  name: string,
  guildId: string,
  defaultChannel?: string
): DiscordCliConfig {
  if (!name) throw new ServerContextError("Server profile name is required.");
  if (!guildId) throw new ServerContextError("guildId is required.");

  config.servers ??= {};
  const existing: ServerProfile | undefined = config.servers[name];
  const next: ServerProfile = { ...existing, guildId };
  if (defaultChannel) next.defaultChannel = defaultChannel;
  config.servers[name] = next;
  return config;
}
