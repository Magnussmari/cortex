/**
 * G-1113.B.3 — githubRefToSourceRef: GitHub adapter boundary's normalized
 * SourceRef emitter.
 *
 * `externalId` is the load-bearing invariant: it equals `canonicalRef(ref)`
 * (`owner/repo#N`) — the exact string stored in `source_external_id` and used
 * as the dedup key. `url` is the canonical web URL derived from the ref alone;
 * it intentionally DIVERGES from the stored `source_url` (which is GitHub's
 * `html_url` from the API fetch) for shorthand-imported PRs (kind=auto →
 * canonicalUrl falls back to `/issues/N` while html_url is `/pull/N`). A Phase-C
 * consumer must not assume emitter.url === stored source_url.
 */
import { test, expect } from "bun:test";
import { githubRefToSourceRef } from "../adapters/github";
import { canonicalRef } from "../adapters/github";

test("issue ref → github SourceRef with issue native type", () => {
  expect(githubRefToSourceRef({ owner: "the-metafactory", repo: "cortex", number: 1, kind: "issue" })).toEqual({
    provider: "github",
    externalId: "the-metafactory/cortex#1",
    url: "https://github.com/the-metafactory/cortex/issues/1",
    providerNativeType: "issue",
  });
});

test("pr ref → pull_request native type + /pull/ url", () => {
  expect(githubRefToSourceRef({ owner: "o", repo: "r", number: 2, kind: "pr" })).toEqual({
    provider: "github",
    externalId: "o/r#2",
    url: "https://github.com/o/r/pull/2",
    providerNativeType: "pull_request",
  });
});

test("auto ref → null native type + /issues/ url fallback", () => {
  const ref = githubRefToSourceRef({ owner: "o", repo: "r", number: 3, kind: "auto" });
  expect(ref.providerNativeType).toBeNull();
  expect(ref.url).toBe("https://github.com/o/r/issues/3");
  expect(ref.provider).toBe("github");
});

test("externalId always equals canonicalRef(ref) — the dedup-key invariant", () => {
  for (const kind of ["issue", "pr", "auto"] as const) {
    const r = { owner: "the-metafactory", repo: "cortex", number: 7, kind };
    expect(githubRefToSourceRef(r).externalId).toBe(canonicalRef(r));
  }
});
