/**
 * IAW Phase B.2a (cortex#114) — `BusDispatchListener`.
 *
 * Listens on the local `MyelinRuntime` for inbound `dispatch.task.*`
 * envelopes from peer bots (i.e. envelopes that did NOT originate from
 * this cortex's own publish path). Verifies each envelope's
 * `signed_by[]` chain via `verifySignedByChain` (cryptoVerify-gated by
 * whether the receiving agent has an `nkey_pub` declared), then surfaces
 * the receipt as a `system.bus.peer_dispatch_received` visibility event.
 *
 * **What this slice delivers (B.2a — inbound listener half of B.2):**
 *   - Subscribes via `runtime.onEnvelope` and filters for
 *     `dispatch.task.dispatched` envelopes whose source is a peer (not
 *     our own publish).
 *   - Verifies the chain (structural always; cryptographic when the
 *     receiving agent has an `nkey_pub`).
 *   - Emits a structured `system.bus.peer_dispatch_received` envelope
 *     on every valid arrival — operators see "peer X dispatched a task
 *     to us at <time>" on the dashboard / audit trail.
 *   - Drops invalid envelopes with a stderr log carrying the structured
 *     `ChainRejectionReason` discriminator.
 *
 * **What this slice deliberately doesn't do (deferred to B.2a+ / B.2b):**
 *   - **No DispatchHandler routing.** `DispatchHandler.handleMessage`'s
 *     `InboundMessage` shape is platform-specific (Discord/Mattermost
 *     fields like `channelId`, `authorId`). Mapping a bus envelope onto
 *     that shape is a real adapter — designed alongside Phase C's
 *     PolicyEngine (cortex#107) which natively takes a `Principal`
 *     rather than a platform-user-id. Until that lands, this listener
 *     is a visibility-only surface: cortex *knows* peers are dispatching
 *     to it, but doesn't *act* on those dispatches yet.
 *   - **No outbound peer dispatch.** That's B.2b (tracked at cortex#202)
 *     — the LLM-driven publish side.
 *   - **No Discord trustedBotIds retirement.** The legacy bot-to-bot
 *     Discord @-mention path stays operational until B.2a + B.2b both
 *     land in production and operators flip the deprecation flag.
 *
 * **Cross-references:**
 *   - cortex#114 — IAW Phase B umbrella
 *   - cortex#202 — B.2b outbound side
 *   - cortex#194 (B.1a) — `verifySignedByChain` primitive
 *   - cortex#200 (B.1c) — cryptographic verification
 *   - cortex#195 (B.1b) — `BusPeerHarness` (the publish-and-collect peer
 *     this listener pairs with on outbound dispatches)
 */

import type { Envelope } from "./myelin/envelope-validator";
import type { MyelinRuntime } from "./myelin/runtime";
import type { TrustResolver } from "../common/agents/trust-resolver";
import { verifySignedByChain } from "./verify-signed-by-chain";
import {
  createSystemBusPeerDispatchReceivedEvent,
  type SystemEventSource,
} from "./system-events";

// =============================================================================
// Constructor options
// =============================================================================

export interface BusDispatchListenerOpts {
  /** Runtime to subscribe through. */
  runtime: MyelinRuntime;
  /** Trust resolver for chain verification. */
  resolver: TrustResolver;
  /**
   * Agent id of the receiving side — whose `trust:` list governs which
   * peer signers we admit. Single-agent stacks pass their sole agent's
   * id; multi-agent stacks pass the agent that handles bus-peer routing
   * (typically a designated `peer-router` agent in cortex.yaml).
   */
  receivingAgentId: string;
  /**
   * Operator id (e.g. `andreas`). Threaded into the myelin
   * `PrincipalRegistry` constructed by `verifySignedByChain`'s crypto
   * path. Required even when `cryptoVerify: false` so the listener can
   * flip the flag on later without re-threading.
   */
  operatorId: string;
  /**
   * Source attribution for emitted visibility events. Same shape the
   * runner already builds for `dispatch.task.*` and `system.*` event
   * constructors.
   */
  source: SystemEventSource;
  /**
   * When true, runs the cryptographic verification step in addition to
   * the structural trust check. Default `false` — structural-only at
   * this slice. Operators flip this on once every trusted peer has an
   * `nkey_pub` declared on the agent (B.1c primitives are in place;
   * the missing piece is config-side opt-in).
   */
  cryptoVerify?: boolean;
}

// =============================================================================
// Listener
// =============================================================================

export class BusDispatchListener {
  private readonly runtime: MyelinRuntime;
  private readonly resolver: TrustResolver;
  private readonly receivingAgentId: string;
  private readonly operatorId: string;
  private readonly source: SystemEventSource;
  private readonly cryptoVerify: boolean;

  private registration: { unregister: () => void } | undefined;
  private serial: Promise<void> = Promise.resolve();

  constructor(opts: BusDispatchListenerOpts) {
    this.runtime = opts.runtime;
    this.resolver = opts.resolver;
    this.receivingAgentId = opts.receivingAgentId;
    this.operatorId = opts.operatorId;
    this.source = opts.source;
    this.cryptoVerify = opts.cryptoVerify ?? false;
  }

  /**
   * Register the runtime subscription. Idempotent — calling `start()`
   * twice is a no-op (returns the existing registration). The handler
   * runs every inbound verify inside a serial promise chain so a slow
   * verify on envelope A doesn't let envelope B's processing race
   * ahead — same arrival-order discipline as `BusPeerHarness` (cortex
   * cortex#200 round 1).
   */
  start(): void {
    if (this.registration !== undefined) return;
    this.registration = this.runtime.onEnvelope((envelope) => {
      if (!this.isPeerDispatch(envelope)) return;
      this.serial = this.serial.then(async () => {
        try {
          await this.handleInbound(envelope);
        } catch (err) {
          process.stderr.write(
            `[bus-dispatch-listener:${this.receivingAgentId}] verification ` +
              `threw on envelope ${envelope.id}: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      });
    });
  }

  /**
   * Detach the subscription. Idempotent. In-flight serial verifies
   * complete but their results are no-op'd because the listener no
   * longer cares (the visibility event constructor is a pure builder;
   * nothing downstream observes after stop).
   */
  stop(): void {
    if (this.registration === undefined) return;
    this.registration.unregister();
    this.registration = undefined;
  }

  /**
   * Filter: only `dispatch.task.dispatched` envelopes are interesting,
   * and we deliberately skip our own published envelopes (the runtime's
   * onEnvelope fan-out fires for outbound publishes too).
   *
   * The "own publish" check uses envelope source attribution rather
   * than envelope id — at this slice we don't track our own outbound
   * ids, and `source` is the dotted `{operator}.{agent}.{instance}`
   * shape every cortex publish stamps. A peer's source will name a
   * different operator/agent, so the check is conservative-but-correct.
   */
  private isPeerDispatch(envelope: Envelope): boolean {
    if (envelope.type !== "dispatch.task.dispatched") return false;
    const ourSource = `${this.source.org}.${this.source.agent}.${this.source.instance}`;
    return envelope.source !== ourSource;
  }

  private async handleInbound(envelope: Envelope): Promise<void> {
    const verification = await verifySignedByChain(envelope, {
      resolver: this.resolver,
      receivingAgentId: this.receivingAgentId,
      // Peer dispatches MUST be signed — an unsigned dispatch envelope
      // arriving on the bus is a misconfig we want surfaced.
      rejectEmpty: true,
      cryptoVerify: this.cryptoVerify,
      operatorId: this.operatorId,
    });

    if (!verification.valid) {
      process.stderr.write(
        `[bus-dispatch-listener:${this.receivingAgentId}] dropped peer ` +
          `dispatch envelope ${envelope.id} (correlation_id=` +
          `${envelope.correlation_id ?? "<none>"}): ${verification.reason.kind} ` +
          `at chain index ${verification.rejectedAt}\n`,
      );
      return;
    }

    // Emit visibility — Phase C audit envelopes will consume this on
    // the wire. Today operators see it via the dashboard renderer +
    // any other surface subscribed to `system.bus.*`.
    const visibilityEvent = createSystemBusPeerDispatchReceivedEvent({
      source: this.source,
      peerSource: envelope.source,
      dispatchEnvelopeId: envelope.id,
      ...(envelope.correlation_id !== undefined && {
        correlationId: envelope.correlation_id,
      }),
      receivedAt: new Date(),
    });
    // Fire-and-forget per MyelinRuntime.publish contract — the runtime
    // logs and swallows publish errors internally.
    void this.runtime.publish(visibilityEvent);
  }
}
