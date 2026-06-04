/**
 * Discord CLI configuration — stored at ~/.config/grove/cli.yaml.
 *
 * Path is intentionally `~/.config/grove/` for byte-identical parity with
 * grove-v2 (plan §1.3 non-goal: behaviour parity). The rename to
 * `~/.config/cortex/cli.yaml` lands at MIG-7 alongside the broader
 * bot.yaml → cortex.yaml move; doing it now would create an intermediate
 * config-fork state for the principal. Tracked at plan §4 MIG-7.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";

export interface ChannelConfig {
  /** Discord channel ID */
  id: string;
}

/**
 * A named server profile — a second (or third, …) guild the same bot is in.
 *
 * Only `guildId` is required: it is the value used for channel/thread NAME
 * resolution within that guild. `botToken`, `defaultChannel`, and `channels`
 * are optional overrides; when absent the top-level (grove) values are used.
 * This lets one token serve every guild the bot has joined while keeping each
 * guild's name→id resolution scoped to the right server.
 */
export interface ServerProfile {
  /** Discord guild/server ID for this profile (required) */
  guildId: string;
  /** Per-profile bot token; falls back to top-level botToken when absent */
  botToken?: string;
  /** Per-profile default channel; falls back to top-level defaultChannel */
  defaultChannel?: string;
  /** Per-profile cached channel name→id map */
  channels?: Record<string, ChannelConfig>;
}

export interface DiscordCliConfig {
  /** Discord bot token */
  botToken?: string;
  /** Discord guild/server ID */
  guildId?: string;
  /** Default channel name to post to */
  defaultChannel?: string;
  /** Named channel configs */
  channels?: Record<string, ChannelConfig>;
  /** Named server profiles for guilds other than the top-level (grove) one */
  servers?: Record<string, ServerProfile>;
}

const CONFIG_PATH = join(process.env.HOME ?? "~", ".config", "grove", "cli.yaml");

export function loadConfig(): DiscordCliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  const text = readFileSync(CONFIG_PATH, "utf-8");
  return (YAML.parse(text) as DiscordCliConfig | undefined) ?? {};
}

export function saveConfig(config: DiscordCliConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, YAML.stringify(config));
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

/**
 * Resolve a channel name to its webhook URL.
 * Falls back to defaultChannel if no name given.
 */
export function resolveChannel(config: DiscordCliConfig, name?: string): { name: string; id?: string } | null {
  const channelName = name ?? config.defaultChannel;
  if (!channelName) return null;

  const ch = config.channels?.[channelName];
  return {
    name: channelName,
    id: ch?.id,
  };
}
