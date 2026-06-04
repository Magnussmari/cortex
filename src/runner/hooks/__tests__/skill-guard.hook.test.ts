/**
 * Tests for the Cortex Skill Guard PreToolUse hook (cortex#710, C-701 Part B).
 *
 * Two layers:
 *   - PURE logic (parseGrantList / extractSkillName / decideSkill) — the
 *     name-extraction + allow/deny decision, exercised directly.
 *   - PROCESS behaviour — spawn the hook with a Skill tool-call payload on
 *     stdin and assert the exit code + stdout decision:
 *       * granted skill → exit 0, {"continue":true}
 *       * un-granted skill → exit 2, structured PreToolUse deny
 *       * no/empty grant list → deny (fail-closed)
 *       * malformed payload → deny (fail-closed)
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  parseGrantList,
  extractSkillName,
  decideSkill,
} from "../skill-guard.hook";

const HOOK_PATH = join(import.meta.dir, "..", "skill-guard.hook.ts");

interface RunResult {
  status: number | null;
  stdout: string;
}

/** Run the hook with a tool-call payload on stdin + a grant-list env. */
function runHook(
  payload: Record<string, unknown> | string,
  grants: string | undefined,
): RunResult {
  // Build a clean env: start from process.env, drop any inherited grant var,
  // then apply this test's value (undefined → unset).
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "CORTEX_SKILL_GRANTS") merged[k] = v;
  }
  if (grants !== undefined) merged.CORTEX_SKILL_GRANTS = grants;

  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const result = spawnSync("bun", [HOOK_PATH], {
    encoding: "utf-8",
    input,
    env: merged,
  });
  return { status: result.status, stdout: result.stdout };
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("parseGrantList — fail-closed parsing", () => {
  test("parses a JSON array of skill names", () => {
    expect(parseGrantList('["code-review","art"]')).toEqual(["code-review", "art"]);
  });

  test("undefined env → empty (deny-all)", () => {
    expect(parseGrantList(undefined)).toEqual([]);
  });

  test("empty string → empty (deny-all)", () => {
    expect(parseGrantList("")).toEqual([]);
  });

  test("malformed JSON → empty (deny-all, never widens access)", () => {
    expect(parseGrantList("not json")).toEqual([]);
  });

  test("non-array JSON → empty (deny-all)", () => {
    expect(parseGrantList('{"skill":"code-review"}')).toEqual([]);
    expect(parseGrantList('"code-review"')).toEqual([]);
  });

  test("filters non-string members", () => {
    expect(parseGrantList('["code-review",42,null,"art"]')).toEqual([
      "code-review",
      "art",
    ]);
  });
});

describe("extractSkillName — name extraction from the Skill tool input", () => {
  test("reads tool_input.skill for tool_name 'Skill'", () => {
    expect(
      extractSkillName({ tool_name: "Skill", tool_input: { skill: "code-review" } }),
    ).toBe("code-review");
  });

  test("accepts the lowercase 'skill' tool name", () => {
    expect(
      extractSkillName({ tool_name: "skill", tool_input: { skill: "art" } }),
    ).toBe("art");
  });

  test("tolerates a raw-string tool_input", () => {
    expect(extractSkillName({ tool_name: "Skill", tool_input: "code-review" })).toBe(
      "code-review",
    );
  });

  test("non-Skill tool → null (this hook governs only Skill)", () => {
    expect(
      extractSkillName({ tool_name: "Bash", tool_input: { skill: "code-review" } }),
    ).toBeNull();
  });

  test("missing tool_name → null", () => {
    expect(extractSkillName({ tool_input: { skill: "code-review" } })).toBeNull();
  });

  test("empty / whitespace skill name → null", () => {
    expect(extractSkillName({ tool_name: "Skill", tool_input: { skill: "  " } })).toBeNull();
    expect(extractSkillName({ tool_name: "Skill", tool_input: {} })).toBeNull();
  });
});

describe("decideSkill — allow/deny decision", () => {
  test("granted name → allow", () => {
    expect(decideSkill("code-review", ["code-review"]).allow).toBe(true);
  });

  test("un-granted name → deny with a reason naming the skill + grant list", () => {
    const d = decideSkill("art", ["code-review"]);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("art");
    expect(d.reason).toContain("code-review");
  });

  test("empty grant list → deny everything", () => {
    expect(decideSkill("code-review", []).allow).toBe(false);
  });

  test("null skill name (not a Skill invocation) → allow pass-through", () => {
    expect(decideSkill(null, ["code-review"]).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Process behaviour (the actual hook contract Claude Code sees)
// ---------------------------------------------------------------------------

describe("skill-guard.hook — process behaviour", () => {
  test("granted skill → exit 0, {continue:true}", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      '["code-review"]',
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ continue: true });
  });

  test("un-granted skill → exit 2, structured PreToolUse deny", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "art" } },
      '["code-review"]',
    );
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("art");
  });

  test("no grant-list env → deny (fail-closed)", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      undefined,
    );
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  test("empty grant list → deny (fail-closed)", () => {
    const r = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      "[]",
    );
    expect(r.status).toBe(2);
  });

  test("malformed payload → deny (fail-closed)", () => {
    const r = runHook("not json at all", '["code-review"]');
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  test("exactly one grant → only that skill passes, everything else denied", () => {
    const granted = runHook(
      { tool_name: "Skill", tool_input: { skill: "code-review" } },
      '["code-review"]',
    );
    const other = runHook(
      { tool_name: "Skill", tool_input: { skill: "telos" } },
      '["code-review"]',
    );
    expect(granted.status).toBe(0);
    expect(other.status).toBe(2);
  });
});
