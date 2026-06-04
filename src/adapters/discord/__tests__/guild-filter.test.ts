/**
 * cortex#704 — Discord adapter cross-stack isolation leak.
 *
 * Background:
 *   The "one bot token per assistant across stacks" model means the same
 *   Discord bot token is configured in N cortex processes (e.g.
 *   meta-factory + halden), each binding a DIFFERENT `guildId`. One token
 *   → N gateway connections → the bot is a member of every guild any of
 *   those processes binds. The discord.js gateway delivers a `messageCreate`
 *   for guild B to the connection in process A as well, because the token
 *   is a member of guild B.
 *
 *   Pre-cortex#704, the `messageCreate` handler had NO `guildId` filter, so
 *   adapter A (bound to guild A) would run a FULL CC session for a message
 *   that arrived in guild B — with process A's config, NATS, and
 *   allowedDirs. That is a hard cross-stack isolation breach (and, as a side
 *   effect, duplicate responses).
 *
 * cortex#704 fix:
 *   A guild filter at the TOP of the handler. If `message.guildId` is set
 *   (a guild/thread message) and it does NOT equal the adapter's configured
 *   `presence.guildId`, the event is dropped before any other check runs.
 *   DMs (no `guildId`) keep their existing path.
 *
 * This suite pins the contract:
 *   1. Two adapters, SAME token, DIFFERENT guildId. A guild-A message
 *      dispatches ONLY on the guild-A adapter; the guild-B adapter ignores it.
 *   2. A DM (no guildId) is still dispatched.
 *   3. A guild message whose guildId matches the adapter's guild dispatches.
 *
 * We never touch a real Discord gateway. The fake client extends
 * EventEmitter so `client.emit("messageCreate", msg)` drives the real
 * handler registered by `attachInboundDispatch()` (matches the
 * start-attach-separation.test.ts pattern). We observe dispatch by counting
 * calls to the stashed `onMessage` callback.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { ChannelType } from "discord.js";
import { DiscordAdapter, type DiscordAdapterInfra } from "../index";
import type { Agent, DiscordPresence } from "../../../common/types/cortex-config";
import type { InboundMessage } from "../../types";

// ---------------------------------------------------------------------------
// Console suppression — adapter logs at construction + on dispatch; noise.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;
let originalError: typeof console.error;
let originalLog: typeof console.log;

beforeEach(() => {
  originalWarn = console.warn;
  originalError = console.error;
  originalLog = console.log;
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  console.log = originalLog;
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const SELF_BOT_ID = "self-bot-id";

/**
 * Minimal fake Client. Inherits EventEmitter so the adapter's
 * `client.on("messageCreate", ...)` registers a real listener that
 * `client.emit("messageCreate", msg)` drives.
 */
class FakeClient extends EventEmitter {
  public user = { id: SELF_BOT_ID };
  isReady() {
    return true;
  }
  channels = { fetch: async () => null };
}

/**
 * Build a fake guild/thread/DM message that:
 *  - passes the @mention check (mentions our self bot),
 *  - is authored by a human (not a bot, not self),
 *  - carries the supplied `guildId` (null ⇒ DM).
 */
function makeMessage(opts: { id: string; guildId: string | null }): unknown {
  const isDM = opts.guildId === null;
  return {
    id: opts.id,
    guildId: opts.guildId,
    content: `<@${SELF_BOT_ID}> ping`,
    createdAt: new Date(),
    author: { id: "human-author", displayName: "Human", bot: false },
    mentions: { has: (u: { id: string }) => u.id === SELF_BOT_ID },
    attachments: new Map(),
    channel: {
      id: isDM ? "dm-channel" : "guild-channel",
      type: isDM ? ChannelType.DM : ChannelType.GuildText,
      name: isDM ? undefined : "general",
    },
  };
}

function makeAdapter(opts: {
  instanceId: string;
  guildId: string;
}): {
  adapter: DiscordAdapter;
  fakeClient: FakeClient;
  dispatched: InboundMessage[];
} {
  const presence: DiscordPresence = {
    enabled: true,
    // SAME token across both adapters — this is the crux of cortex#704.
    token: "shared-bot-token",
    guildId: opts.guildId,
    agentChannelId: "c1",
    logChannelId: "c2",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
    surfaceSubjects: [],
  };
  const agent: Agent = {
    id: "test-agent",
    displayName: "TestAgent",
    persona: "(test)",
    trust: [],
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: opts.instanceId,
    principal: {},
  };
  const adapter = new DiscordAdapter(agent, presence, infra);

  const fakeClient = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = fakeClient;

  const dispatched: InboundMessage[] = [];
  (adapter as unknown as {
    onMessage: (msg: InboundMessage) => Promise<void>;
  }).onMessage = async (msg) => {
    dispatched.push(msg);
  };

  adapter.attachInboundDispatch();

  return { adapter, fakeClient, dispatched };
}

/**
 * Emit a messageCreate and let the handler's async IIFE settle. The handler
 * is `void (async () => {...})()`, so emit returns synchronously; a single
 * macrotask tick lets the (mostly synchronous) gate path resolve.
 */
async function fireMessageCreate(
  fakeClient: FakeClient,
  message: unknown,
): Promise<void> {
  fakeClient.emit("messageCreate", message);
  // Flush microtasks + one macrotask so any awaited fetch/path settles.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. Cross-stack leak: guild-A message dispatches ONLY on the guild-A adapter
// ---------------------------------------------------------------------------

describe("DiscordAdapter: guild filter (cortex#704)", () => {
  const GUILD_A = "1487023327791808592"; // meta-factory
  const GUILD_B = "1512054429023731884"; // halden

  test("same token, different guildId: guild-A message dispatches only on the guild-A adapter", async () => {
    const a = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A });
    const b = makeAdapter({ instanceId: "discord-B", guildId: GUILD_B });

    // One Discord message posted in guild A. Because the token is a member
    // of both guilds, the gateway delivers it to BOTH process connections.
    const msgA = makeMessage({ id: "msg-1", guildId: GUILD_A });
    await fireMessageCreate(a.fakeClient, msgA);
    await fireMessageCreate(b.fakeClient, msgA);

    // The guild-A adapter dispatches; the guild-B adapter drops it as a
    // foreign-guild event — no cross-stack CC session.
    expect(a.dispatched.length).toBe(1);
    expect(b.dispatched.length).toBe(0);
    expect(a.dispatched[0]?.guildId).toBe(GUILD_A);
  });

  test("guild-B message dispatches only on the guild-B adapter (symmetry)", async () => {
    const a = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A });
    const b = makeAdapter({ instanceId: "discord-B", guildId: GUILD_B });

    const msgB = makeMessage({ id: "msg-2", guildId: GUILD_B });
    await fireMessageCreate(a.fakeClient, msgB);
    await fireMessageCreate(b.fakeClient, msgB);

    expect(a.dispatched.length).toBe(0);
    expect(b.dispatched.length).toBe(1);
    expect(b.dispatched[0]?.guildId).toBe(GUILD_B);
  });

  // -------------------------------------------------------------------------
  // 2. DMs (no guildId) are unaffected — they still dispatch.
  // -------------------------------------------------------------------------

  test("DM (no guildId) is still dispatched — filter only gates guild messages", async () => {
    const a = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A });

    const dm = makeMessage({ id: "msg-dm", guildId: null });
    await fireMessageCreate(a.fakeClient, dm);

    expect(a.dispatched.length).toBe(1);
    expect(a.dispatched[0]?.isDM).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. A guild message matching the adapter's own guild dispatches.
  // -------------------------------------------------------------------------

  test("matching-guild message dispatches (positive control)", async () => {
    const a = makeAdapter({ instanceId: "discord-A", guildId: GUILD_A });

    const msg = makeMessage({ id: "msg-own", guildId: GUILD_A });
    await fireMessageCreate(a.fakeClient, msg);

    expect(a.dispatched.length).toBe(1);
    expect(a.dispatched[0]?.guildId).toBe(GUILD_A);
  });
});
