/**
 * G-1113.B.5 — adapter parity at the SourceRef boundary.
 *
 * Every provider — whether it has a real adapter today (github via
 * githubRefToSourceRef, internal via taskRowToSourceRef) or only a declared
 * future one (gitlab / azure-devops / jira / linear / bitbucket / custom) —
 * must produce a value that satisfies {@link isSourceRef}. This pins the
 * contract a future adapter (B.3 pattern) has to meet before it can be wired,
 * and guarantees every member of the Provider union has a representative
 * example.
 */
import { test, expect } from "bun:test";
import { isSourceRef, PROVIDERS, type Provider, type SourceRef } from "../types";
import { githubRefToSourceRef } from "../adapters/github";
import { taskRowToSourceRef } from "../db/tasks";

/** One representative SourceRef per provider — real adapter output where one exists. */
const EXAMPLES: Record<Provider, SourceRef> = {
  // real adapter (B.3)
  github: githubRefToSourceRef({ owner: "the-metafactory", repo: "cortex", number: 543, kind: "issue" }),
  // real shim (B.2) on an internal task row
  internal: taskRowToSourceRef({ source_system: "internal", source_url: null, source_external_id: null }),
  // declared-but-unwired providers — fixtures matching what their adapter would emit
  gitlab: { provider: "gitlab", externalId: "group/proj!42", url: "https://gitlab.example/group/proj/-/merge_requests/42", providerNativeType: "merge_request" },
  "azure-devops": { provider: "azure-devops", externalId: "org/proj/123", url: "https://dev.azure.com/org/proj/_workitems/edit/123", providerNativeType: "work_item" },
  jira: { provider: "jira", externalId: "PROJ-7", url: "https://jira.example/browse/PROJ-7", providerNativeType: "issue" },
  linear: { provider: "linear", externalId: "ENG-99", url: "https://linear.app/team/issue/ENG-99", providerNativeType: "issue" },
  bitbucket: { provider: "bitbucket", externalId: "ws/repo/5", url: "https://bitbucket.org/ws/repo/pull-requests/5", providerNativeType: "pullrequest" },
  custom: { provider: "custom", externalId: "ref-1", url: null, providerNativeType: null },
};

test("every Provider has a parity example", () => {
  for (const p of PROVIDERS) expect(EXAMPLES[p]).toBeDefined();
  expect(Object.keys(EXAMPLES).sort()).toEqual([...PROVIDERS].sort());
});

test("every provider example is a valid SourceRef", () => {
  for (const p of PROVIDERS) {
    const ref = EXAMPLES[p];
    expect(isSourceRef(ref)).toBe(true);
    expect(ref.provider).toBe(p);
  }
});

test("isSourceRef rejects malformed shapes", () => {
  expect(isSourceRef(null)).toBe(false);
  expect(isSourceRef({})).toBe(false);
  expect(isSourceRef({ provider: "svn", externalId: null, url: null, providerNativeType: null })).toBe(false);
  expect(isSourceRef({ provider: "github", externalId: 42, url: null, providerNativeType: null })).toBe(false);
  // providerNativeType is required (string | null) — a missing field is rejected.
  expect(isSourceRef({ provider: "github", externalId: null, url: null })).toBe(false);
});

test("real adapters (github, internal) agree with the boundary contract", () => {
  expect(isSourceRef(EXAMPLES.github)).toBe(true);
  expect(EXAMPLES.github.externalId).toBe("the-metafactory/cortex#543");
  expect(EXAMPLES.internal.provider).toBe("internal");
  expect(EXAMPLES.internal.externalId).toBeNull();
});
