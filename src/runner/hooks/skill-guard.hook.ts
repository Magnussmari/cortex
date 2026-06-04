#!/usr/bin/env bun
/**
 * Cortex Skill Guard — PreToolUse hook for the `Skill` tool (cortex#710,
 * C-701 Part B — TRUST-PATH/security).
 *
 * ## Why a hook (and not a permission rule)
 *
 * The original #706 Part B tried to express per-skill grants with
 * `allowedTools: ["Skill(code-review)"]` + `disallowedTools: ["Skill"]`.
 * That is broken by design (proven in the #706 review):
 *
 *   - Claude Code's `Skill` tool has **no specifier syntax** — there is no
 *     `Skill(<name>)` rule form, so `Skill(code-review)` matches nothing.
 *   - Permission precedence is **deny → ask → allow; deny ALWAYS wins**,
 *     regardless of specificity. So a bare `Skill` deny suppresses the
 *     granted skill too → a granted reviewer gets NO skills at all.
 *
 * The correct mechanism is a **PreToolUse hook** (matcher `Skill`):
 *
 *   - Hooks run **before** permission rules; a blocking hook beats `allow`.
 *   - So the session can broadly **allow** the bare `Skill` tool (the
 *     permission rule is permissive) while THIS hook is the real gate: it
 *     inspects the invoked skill name and DENIES any name ∉ the grant list.
 *
 * Wiring (see `src/runner/session-settings.ts`):
 *   - A session WITH grants registers this hook under `PreToolUse` matcher
 *     `Skill` in the curated `--settings` file, AND broadly allows `Skill`.
 *   - The grant list reaches this hook via the `CORTEX_SKILL_GRANTS` env
 *     var (a JSON array of allowed skill names), set on the child env by
 *     `cc-session.ts` — the same layering as `GROVE_BASH_GUARD`.
 *   - A session with NO grants does NOT register this hook; it keeps the
 *     bare-`Skill` `disallowedTools` deny (default-deny, no Skill tool).
 *
 * ## Deny behaviour
 *
 * On an un-granted skill the hook is **doubly fail-closed**:
 *   1. Emits Claude Code's structured PreToolUse *deny* decision on stdout
 *      ({"hookSpecificOutput":{...,"permissionDecision":"deny",
 *       "permissionDecisionReason":"…"}}) so the reason surfaces to the
 *      agent and the Cortex→Discord relay (mirrors bash-guard.hook.ts).
 *   2. Exits with code **2** — Claude Code treats a PreToolUse hook exit 2
 *      as a hard block. Belt-and-braces: even a CLI that ignored the
 *      structured output would still be blocked by the non-zero exit.
 *
 * ## Fail-closed posture on malformed input / missing grant list
 *
 * If `CORTEX_SKILL_GRANTS` is absent or not a JSON array, the grant list is
 * empty → every skill is denied. A session that wants skills MUST register
 * this hook with a populated grant list; the absence of a grant list never
 * silently allows skills. (A session with no grants doesn't register the
 * hook at all and relies on the `disallowedTools: ["Skill"]` rule instead,
 * so this path is the defence-in-depth backstop.)
 */

interface HookInput {
  session_id?: string;
  tool_name?: string;
  // The `Skill` tool input carries the invoked skill name on `skill`
  // (verified against the codebase's own event-utils.ts, which reads
  // `input.skill` for the "Using skill: …" detail). May arrive as a raw
  // string in degenerate cases; we tolerate both shapes.
  tool_input?: { skill?: unknown } | string;
}

/** The Skill tool's name as Claude Code emits it (seen as both casings). */
const SKILL_TOOL_NAMES = new Set(["Skill", "skill"]);

/**
 * Parse the per-session grant list from `CORTEX_SKILL_GRANTS` (JSON array of
 * skill-name strings). Returns `[]` (deny-all) on absence or malformed input
 * — fail-closed. Exported for unit tests.
 */
export function parseGrantList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    // Malformed grant list — fail closed (deny all). A bad env value must
    // never widen access.
    return [];
  }
}

/**
 * Extract the invoked skill name from a PreToolUse hook input for the
 * `Skill` tool. Returns `null` when the input is not a Skill invocation or
 * carries no usable name. Exported for unit tests.
 */
export function extractSkillName(input: HookInput): string | null {
  if (input.tool_name === undefined || !SKILL_TOOL_NAMES.has(input.tool_name)) {
    return null;
  }
  const ti = input.tool_input;
  if (typeof ti === "string") {
    const trimmed = ti.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (ti && typeof ti === "object" && typeof ti.skill === "string") {
    const trimmed = ti.skill.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Decide allow/deny for a Skill invocation given the grant list. Pure —
 * exported for unit tests. `null` skill name (not a Skill invocation, or no
 * name) is treated as a pass-through allow: this hook only gates Skill, and
 * Claude Code only fires it on the `Skill` matcher, so a `null` here means
 * "not something this hook governs".
 */
export function decideSkill(
  skillName: string | null,
  grants: string[],
): { allow: boolean; reason?: string } {
  if (skillName === null) return { allow: true };
  if (grants.includes(skillName)) return { allow: true };
  return {
    allow: false,
    reason:
      `[Cortex Skill Guard] Blocked skill "${skillName}": not in this ` +
      `session's grant list [${grants.map((g) => `"${g}"`).join(", ")}]. ` +
      `This is a hard security boundary (least-privilege per-skill grants, ` +
      `cortex#701). Ask the principal to grant this skill to the agent's ` +
      `role if it is genuinely needed.`,
  };
}

/** Emit the pass-through decision (mirrors bash-guard.hook.ts). */
function allow(): void {
  console.log(JSON.stringify({ continue: true }));
}

/**
 * Emit Claude Code's structured PreToolUse *deny* decision. The
 * `permissionDecisionReason` surfaces back to the agent + the Cortex→Discord
 * relay (mirrors bash-guard.hook.ts).
 */
function deny(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function readStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  let raw = "";
  const readLoop = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value, { stream: true });
    }
  })();
  await Promise.race([readLoop, new Promise<void>((r) => setTimeout(r, 200))]);
  return raw;
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      // No payload — nothing to gate. Allow (the hook is only registered for
      // the Skill matcher; an empty payload is not a Skill invocation).
      allow();
      return;
    }
    input = JSON.parse(raw) as HookInput;
  } catch {
    // Can't parse the payload. We CANNOT confirm which skill is being
    // invoked, so the only safe posture is to deny — a malformed payload
    // must not slip an un-named skill past the gate. Fail closed.
    const reason =
      "[Cortex Skill Guard] Blocked: could not parse the Skill tool input — " +
      "denying to stay fail-closed.";
    deny(reason);
    process.exit(2);
  }

  const skillName = extractSkillName(input);
  const grants = parseGrantList(process.env.CORTEX_SKILL_GRANTS);
  const decision = decideSkill(skillName, grants);

  if (decision.allow) {
    allow();
    return;
  }

  // Write the deny decision FIRST (surfaces the reason), then exit 2 so the
  // block is enforced even by a CLI that ignores structured hook output.
  deny(decision.reason ?? "[Cortex Skill Guard] Blocked.");
  process.exit(2);
}

main().catch(() => {
  // An unexpected failure in the gate must fail CLOSED, not open: if we
  // can't run the check, deny. Mirrors the malformed-input path above.
  deny(
    "[Cortex Skill Guard] Blocked: internal hook error — denying to stay " +
      "fail-closed.",
  );
  process.exit(2);
});
