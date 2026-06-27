/**
 * Prompt injection filter for inbound chat messages.
 * Uses @metafactory/content-filter library to scan user prompts before they reach Claude.
 *
 * Implementation note: we use top-level `await import()` rather than `require()`
 * because content-filter embeds its pattern YAML via Bun's `with { type: "text" }`
 * import attribute. Under `require()`, Bun's CJS interop auto-parses the .yaml
 * file to an object (ignoring the attribute), which crashes pattern-matcher's
 * `text.split("\n")` call and fails-closed silently. Dynamic ESM import honors
 * the attribute and loads the yaml as a raw string. See grove#173.
 */

// Pull in the real library types so any upstream API drift is a compile
// error rather than a silent runtime surprise (grove#176 S1).
import type { FilterResult, FileFormat } from "@metafactory/content-filter";

type FilterContentString = (
  content: string,
  filePath: string,
  format: FileFormat,
) => FilterResult;

let filterContentString: FilterContentString | null = null;

// Load @metafactory/content-filter at module init. This is a required security
// control — if the package fails to load we log loudly so principals notice.
// Previously this was silently fail-open (grove#173).
try {
  const mod = await import("@metafactory/content-filter");
  filterContentString = mod.filterContentString;
  console.log(
    "prompt-filter: @metafactory/content-filter loaded — inbound prompts will be scanned",
  );
} catch (err) {
  console.error(
    "prompt-filter: WARN @metafactory/content-filter failed to load — " +
      "inbound prompts are NOT being scanned for prompt injection:",
    err instanceof Error ? err.message : err,
  );
}

/**
 * cortex#1264 — a STABLE, structured reason category for a BLOCKED match.
 *
 * This is the control-plane half of the separation-of-concerns split: the
 * filter (control plane) emits a category — *structure* — and a deterministic
 * surface message-builder (`src/adapters/filter-rejection.ts`, presentation)
 * renders the human-facing text from it. The category is a small closed enum
 * so the surface text is a pure function of it (never an LLM token, never an
 * inline control-flow string). New categories are an additive change here +
 * one new branch in the renderer.
 *
 *  - `encoded-content`   — the message carried encoded bytes (base64, hex,
 *                          unicode-escape, url-encoded, html-entity, split
 *                          across files). The filter can't read inside it, so
 *                          it's blocked. This is the onboarding-stall case:
 *                          a base64 pubkey pasted into a request to Pier.
 *  - `injection-pattern` — matched a prompt-injection pattern.
 *  - `exfiltration-pattern` — matched a data-exfiltration pattern.
 *  - `tool-invocation`   — matched a direct tool/command-invocation pattern.
 *  - `pii`               — matched a PII pattern.
 *  - `unspecified`       — blocked, but no category could be derived.
 */
export type FilterReasonCategory =
  | "encoded-content"
  | "injection-pattern"
  | "exfiltration-pattern"
  | "tool-invocation"
  | "pii"
  | "unspecified";

export interface PromptFilterResult {
  allowed: boolean;
  reason?: string;
  /**
   * Structured reason category for a BLOCKED match (cortex#1264). Present only
   * when `allowed` is false. The deterministic surface renderer maps this to
   * actionable human text; downstream code should branch on `category`, not
   * parse the free-text `reason`.
   */
  category?: FilterReasonCategory;
  score?: number;
}

/**
 * cortex#1264 — derive the stable {@link FilterReasonCategory} from the raw
 * filter signals. Pure + deterministic: same inputs → same category.
 *
 * Inputs are taken from the TOP-LEVEL (raw-text) match signals only:
 *   - `matchCategories` — `PatternMatch.category` values found in the raw text
 *     (`injection` | `exfiltration` | `tool_invocation` | `pii`).
 *   - `hasEncoding` — whether any encoding rule fired (`result.encodings`).
 *
 * Encoded content is reported AS `encoded-content` regardless of what it
 * decodes to: decoded-pattern matches (`result.decoded_matches`) are
 * deliberately NOT consulted here, because to the user the actionable fact is
 * "I can't read encoded content" — the same guidance whether the blob decodes
 * to a pubkey or to an injection string. A genuine plaintext attack (no
 * encoding) still surfaces its true pattern category.
 *
 * Precedence: explicit plaintext pattern categories first (most specific +
 * security-relevant), then encoded-content, then the `unspecified` fallback.
 */
export function deriveReasonCategory(
  matchCategories: readonly string[],
  hasEncoding: boolean,
): FilterReasonCategory {
  if (matchCategories.includes("injection")) return "injection-pattern";
  if (matchCategories.includes("exfiltration")) return "exfiltration-pattern";
  if (matchCategories.includes("tool_invocation")) return "tool-invocation";
  if (matchCategories.includes("pii")) return "pii";
  if (hasEncoding) return "encoded-content";
  return "unspecified";
}

/**
 * cortex#741 — options controlling how `scanPrompt` treats a BLOCKED match.
 */
export interface ScanPromptOptions {
  /**
   * Whether the sender is TRUSTED — the stack's home principal, i.e. the
   * principal `resolvePolicyAccess` marks via `AccessDecision.trusted`. When
   * true, an injection-pattern match on this sender's *direct* chat message is
   * NOT hard-blocked: `scanPrompt` returns `allowed: true` BUT still emits a
   * loud audit line so the match is observable (no silent bypass). When
   * false/omitted, the existing hard block applies.
   *
   * This flag ONLY relaxes the direct home-principal chat path. It is never
   * threaded into the untrusted/indirect content paths (`ContentFilter.hook`,
   * `payload-filter.ts`, file-read scanning), which call the underlying filter
   * directly and remain fully active.
   */
  trusted?: boolean;
}

/**
 * Scan an inbound chat prompt for prompt injection patterns.
 * Returns allowed: true if the prompt is safe, or allowed: false with a reason.
 *
 * If @metafactory/content-filter failed to load at startup, allows the prompt
 * (fail-open). Principals are warned loudly at startup in that case — see the
 * import block above.
 *
 * Format note: we pass "mixed" (free-text) because chat prompts aren't
 * structured. "mixed" format returns HUMAN_REVIEW for clean content and
 * BLOCKED for content matching a block-severity pattern. We only reject on
 * BLOCKED — HUMAN_REVIEW is treated as allowed because there's no principal
 * in the loop on every Discord/Mattermost message.
 *
 * cortex#741 — trust gate: when `opts.trusted` is set, a BLOCKED match is
 * downgraded to allowed-with-audit. The home principal can already command
 * their own agent within its grants, so the injection filter adds no security
 * against them — only false positives on their own infra phrasing (e.g. EX-004
 * firing on "access the environment"). The exemption is keyed off the home
 * principal only (set by `resolvePolicyAccess`), NOT "any recognized principal"
 * — peer / non-home principals keep the hard block.
 */
export function scanPrompt(
  prompt: string,
  source: string,
  opts: ScanPromptOptions = {},
): PromptFilterResult {
  if (!filterContentString) {
    return { allowed: true };
  }

  try {
    const result = filterContentString(
      prompt,
      `inbound-${source}-prompt`,
      "mixed",
    );

    if (result.decision === "BLOCKED") {
      // Surface pattern matches (e.g. "PI-001") and/or encoding hits (e.g. "base64")
      const patternIds = result.matches.map((m) => m.pattern_id).filter(Boolean);
      const encodingTypes = result.encodings.map((e) => e.type).filter(Boolean);
      const reasons = [...patternIds, ...encodingTypes];
      const reasonStr = reasons.length > 0 ? reasons.join(", ") : "unspecified";

      // cortex#1264 — derive the STRUCTURED reason category (control plane).
      // The surface renderer turns this into actionable human text; the
      // free-text `reason` above stays for logs/audit. Encoding hits map to
      // `encoded-content` (the onboarding-stall case: a base64 pubkey).
      const matchCategories = result.matches
        .map((m) => m.category)
        .filter(Boolean);
      const category = deriveReasonCategory(
        matchCategories,
        result.encodings.length > 0,
      );

      // cortex#741 — TRUSTED senders (the home principal) are not hard-blocked,
      // but the match is ALWAYS audited so it stays observable. This is a
      // downgrade, not a silent bypass — keep the log line loud.
      if (opts.trusted) {
        console.log(
          `prompt-filter: AUDIT trusted-sender match NOT blocked (${reasonStr}) ` +
            `source=${source}: ${prompt.slice(0, 100)}`,
        );
        return { allowed: true, score: result.overall_confidence };
      }

      console.log(
        `prompt-filter: prompt blocked by content filter (${reasonStr}): ${prompt.slice(0, 100)}`,
      );
      return {
        allowed: false,
        reason: `Content filter blocked this message (matched: ${reasonStr})`,
        category,
        score: result.overall_confidence,
      };
    }

    return { allowed: true, score: result.overall_confidence };
  } catch (error) {
    // Fail-open on filter errors — don't block legitimate messages
    console.error("prompt-filter: content filter error:", error);
    return { allowed: true };
  }
}
