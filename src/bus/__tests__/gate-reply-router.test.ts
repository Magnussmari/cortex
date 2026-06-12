/**
 * `gate-reply-router` tests (Bot Packs B-3 / cortex#1021 W-1 — the adapter
 * inbound reply-bridge).
 *
 * Covered (plan W-1 probes):
 *   - matching inbound reply resolves the waiting gate (consumed)
 *   - non-matching inbound (other thread/channel/surface, or no thread) is
 *     NOT consumed — chat dispatch unaffected
 *   - timeout resolves null and deregisters the waiter
 *   - stop() resolves all pending null (drain cannot be held hostage)
 *   - FIFO across multiple gates on one key
 *   - END-TO-END with the real SurfacePrincipalGate: principal reply passes,
 *     impostor reply is ignored (pulse#47), non-principal message consumed by
 *     the open gate does not pass it
 */

import { describe, expect, test } from "bun:test";
import { GateReplyRouter } from "../gate-reply-router";
import {
  SurfacePrincipalGate,
  type GatePromptRenderer,
} from "../surface-principal-gate";
import type { InboundMessage } from "../../adapters/types";

const PRINCIPAL_MM = "mm-principal-123";

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "mattermost",
    instanceId: "mm-1",
    authorId: PRINCIPAL_MM,
    authorName: "JC",
    content: "run it",
    channelId: "c1",
    threadId: "th1",
    attachments: [],
    timestamp: new Date(),
    ...over,
  };
}

function nullRenderer(): GatePromptRenderer {
  return { render: () => undefined };
}

describe("GateReplyRouter", () => {
  test("matching inbound resolves the waiting gate and is consumed", async () => {
    const router = new GateReplyRouter();
    const pending = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 5_000,
    });
    expect(router.pendingCount).toBe(1);
    expect(router.offerInbound(inbound())).toBe(true); // consumed
    const reply = await pending;
    expect(reply).toEqual({ authorId: PRINCIPAL_MM, text: "run it" });
    expect(router.pendingCount).toBe(0);
  });

  test("non-matching inbound is NOT consumed — chat dispatch unaffected", async () => {
    const router = new GateReplyRouter();
    const pending = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 50,
    });
    // Different thread, different channel, different surface, and no thread
    // at all — none of these belong to the open gate.
    expect(router.offerInbound(inbound({ threadId: "other" }))).toBe(false);
    expect(router.offerInbound(inbound({ channelId: "other" }))).toBe(false);
    expect(router.offerInbound(inbound({ platform: "discord" }))).toBe(false);
    const noThread = inbound();
    delete noThread.threadId;
    expect(router.offerInbound(noThread)).toBe(false);
    // The gate is still waiting; it times out to null.
    expect(await pending).toBeNull();
  });

  test("with NO open gate, every offer is a pass-through", () => {
    const router = new GateReplyRouter();
    expect(router.offerInbound(inbound())).toBe(false);
  });

  test("timeout resolves null and deregisters", async () => {
    const router = new GateReplyRouter();
    const reply = await router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 10,
    });
    expect(reply).toBeNull();
    expect(router.pendingCount).toBe(0);
    // After the timeout the late reply is a pass-through, not a consume.
    expect(router.offerInbound(inbound())).toBe(false);
  });

  test("non-positive timeout resolves null immediately", async () => {
    const router = new GateReplyRouter();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1",
        thread: "th1",
        timeoutMs: 0,
      }),
    ).toBeNull();
  });

  test("empty channel/thread keys never wait (gate fail-closes upstream)", async () => {
    const router = new GateReplyRouter();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "",
        thread: "th1",
        timeoutMs: 1_000,
      }),
    ).toBeNull();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1",
        thread: "",
        timeoutMs: 1_000,
      }),
    ).toBeNull();
  });

  test("stop() resolves all pending null and rejects later traffic", async () => {
    const router = new GateReplyRouter();
    const a = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 60_000,
    });
    const b = router.awaitReply({
      surface: "discord",
      channel: "c2",
      thread: "th2",
      timeoutMs: 60_000,
    });
    router.stop();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(router.pendingCount).toBe(0);
    expect(router.offerInbound(inbound())).toBe(false);
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1",
        thread: "th1",
        timeoutMs: 60_000,
      }),
    ).toBeNull();
  });

  test("FIFO across multiple gates on one key", async () => {
    const router = new GateReplyRouter();
    const first = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 5_000,
    });
    const second = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 50,
    });
    expect(router.pendingCount).toBe(2);
    expect(router.offerInbound(inbound({ content: "yes" }))).toBe(true);
    expect((await first)?.text).toBe("yes");
    // The second waiter is untouched and times out on its own.
    expect(await second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real gate + real router (the W-1 bridge, no stubs)
// ---------------------------------------------------------------------------

describe("SurfacePrincipalGate over GateReplyRouter", () => {
  function liveGate(router: GateReplyRouter): SurfacePrincipalGate {
    return new SurfacePrincipalGate({
      principalIdentity: { mattermostId: PRINCIPAL_MM },
      liveSurfaces: new Set(["mattermost"]),
      renderer: nullRenderer(),
      replySource: router,
      timeoutMs: 2_000,
    });
  }

  function resolveGate(gate: SurfacePrincipalGate) {
    return gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run this flow?",
      source: { surface: "mattermost", channel: "c1", thread: "th1", user: "u1" },
    });
  }

  /** Yield until the gate's awaitReply registration lands in the router. */
  async function untilPending(router: GateReplyRouter): Promise<void> {
    for (let i = 0; i < 50 && router.pendingCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(router.pendingCount).toBeGreaterThan(0);
  }

  test("principal reply in the gate thread passes the gate", async () => {
    const router = new GateReplyRouter();
    const gate = liveGate(router);
    const verdictP = resolveGate(gate);
    await untilPending(router);
    expect(router.offerInbound(inbound({ content: "run it" }))).toBe(true);
    const verdict = await verdictP;
    expect(verdict.verdict).toBe("pass");
    expect(verdict.principal).toBe(PRINCIPAL_MM);
  });

  test("impostor 'run it' is consumed by the open gate but never passes it (pulse#47)", async () => {
    const router = new GateReplyRouter();
    const gate = liveGate(router);
    const verdictP = resolveGate(gate);
    await untilPending(router);
    // The impostor's reply IS a gate-thread reply — consumed — but the gate
    // ignores the non-principal author and re-awaits.
    expect(
      router.offerInbound(inbound({ authorId: "impostor", content: "run it" })),
    ).toBe(true);
    await untilPending(router); // gate re-registered
    // Then the principal denies.
    expect(router.offerInbound(inbound({ content: "no" }))).toBe(true);
    const verdict = await verdictP;
    expect(verdict.verdict).toBe("fail");
  });

  test("router.stop() with an open gate fails it closed (drain path)", async () => {
    const router = new GateReplyRouter();
    const gate = liveGate(router);
    const verdictP = resolveGate(gate);
    await untilPending(router);
    router.stop();
    const verdict = await verdictP;
    expect(verdict.verdict).toBe("fail");
  });
});
