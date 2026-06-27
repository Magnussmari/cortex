/**
 * cortex#1264 — deterministic surface message-builder for content-filter
 * rejections.
 *
 * Separation of concerns (CONTEXT.md → "deterministic surface formatting"):
 *   - The content filter is the CONTROL PLANE. It decides whether to block and
 *     emits a STRUCTURED reason `category` (`src/runner/prompt-filter.ts`,
 *     `FilterReasonCategory`) — structure, not prose.
 *   - This file is the PRESENTATION layer. It turns that category into the
 *     human-facing reply a surface adapter posts. It is a PURE function in
 *     code — never an LLM token, never an inline string scattered through the
 *     control-flow dispatch path.
 *
 * It lives in `src/adapters/` (the surface layer, alongside
 * `envelope-renderer.ts`) because rendering a reply for a chat surface is a
 * dispatch-sink concern: the adapter is the surface that speaks to the human.
 * The dispatch-handler (control flow) only calls this builder and posts the
 * result — it never composes the copy itself.
 *
 * The security block is UNCHANGED — this only improves the *message* (Andreas:
 * descriptive, not removed). The filter still hard-blocks; we just stop
 * replying with an opaque "matched: base64" and instead say, honestly and
 * actionably, why and what to do next.
 *
 * Pure function. No side effects. Same category in → same text out.
 */

import type { FilterReasonCategory } from "../runner/prompt-filter";

/**
 * Render the human-facing reply for a blocked inbound message from its
 * structured filter category.
 *
 * Each line is short, honest about WHY the message was blocked, and ends with
 * a concrete next step. The `encoded-content` line is onboarding-aware: the
 * lead case is a community member pasting a base64 pubkey into a request to a
 * bot (e.g. Pier), which the filter can't read inside and so blocks — leaving
 * onboarding stalled with no guidance. We point them at the real path:
 * register the pubkey with the CLI, then ask in plain text.
 */
export function renderFilterRejection(category: FilterReasonCategory): string {
  switch (category) {
    case "encoded-content":
      return (
        "I can't read encoded content — inbound messages are scanned for " +
        "safety, and an encoded blob (e.g. base64) can't be inspected, so " +
        "it's blocked. If you're trying to onboard, don't paste your pubkey " +
        "to me: register it with the CLI (`cortex provision-stack register`), " +
        "then just tell me your principal / stack name in plain text and " +
        "I'll surface your request."
      );
    case "injection-pattern":
      return (
        "I can't process that message — it matched a prompt-injection safety " +
        "pattern. If this was legitimate, rephrase it in plain, direct " +
        "language (without instructions aimed at the assistant's own " +
        "controls) and send it again."
      );
    case "exfiltration-pattern":
      return (
        "I can't process that message — it matched a data-exfiltration safety " +
        "pattern. Rephrase your request without anything that looks like an " +
        "attempt to read or move credentials, secrets, or environment data."
      );
    case "tool-invocation":
      return (
        "I can't process that message — it looked like a direct attempt to " +
        "invoke tools or commands. Describe what you'd like done in plain " +
        "language and I'll work out how to do it safely."
      );
    case "pii":
      return (
        "I can't process that message — it appeared to contain personal or " +
        "identifying data that's filtered for safety. Remove the sensitive " +
        "details and resend just the request."
      );
    case "unspecified":
      return (
        "I can't process that message — it was blocked by the inbound safety " +
        "filter. Rephrase it in plain, direct language and try again."
      );
  }
}
