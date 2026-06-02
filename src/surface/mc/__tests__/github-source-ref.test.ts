/**
 * G-1113.B.3 — githubRefToSourceRef: GitHub adapter boundary's normalized
 * SourceRef emitter. externalId/url must match the canonical strings stored in
 * source_external_id / source_url (dedup-key consistency).
 */
import { test, expect } from "bun:test";
import { githubRefToSourceRef } from "../adapters/github";

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
