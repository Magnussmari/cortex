/**
 * G-1113.C.6 — task→Git-link projection + batch endpoint.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertRepository, upsertBranch, upsertPullRequest } from "../db/git-objects";
import { getGitLinks, handleListGitLinks } from "../api/git-links";
import type { GitRepository, GitBranch, PullRequest } from "../types";

const RID = "github:o/r";
const repo: GitRepository = { id: RID, provider: "github", owner: "o", name: "r", url: "https://github.com/o/r", defaultBranch: null };
const src: GitBranch = { id: `${RID}@feat/x`, repositoryId: RID, name: "feat/x", baseRef: null, headSha: "abc1234", provider: "github", externalId: null, url: "https://github.com/o/r/tree/feat/x" };
const tgt: GitBranch = { id: `${RID}@main`, repositoryId: RID, name: "main", baseRef: null, headSha: null, provider: "github", externalId: null, url: "https://github.com/o/r/tree/main" };
const pr: PullRequest = {
  id: `${RID}#7`, workItemId: null, repositoryId: RID, provider: "github", providerNativeType: "pull_request",
  externalId: "o/r#7", numberOrKey: "7", title: "T", sourceBranch: "feat/x", targetBranch: "main",
  url: "https://github.com/o/r/pull/7", state: "open", reviewState: "none",
};

describe("git-links projection (C.6)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });
  function freshDb() {
    const p = join(tmpdir(), `git-links-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    const db = initDatabase(p);
    upsertRepository(db, repo); upsertBranch(db, src); upsertBranch(db, tgt); upsertPullRequest(db, pr);
    return db;
  }

  it("getGitLinks resolves a ref to its PR + source/target branches", () => {
    const db = freshDb();
    const links = getGitLinks(db, ["o/r#7"]);
    expect(links["o/r#7"]).toEqual({ pullRequest: pr, sourceBranch: src, targetBranch: tgt });
  });

  it("omits refs with no linked PR; dedupes", () => {
    const db = freshDb();
    const links = getGitLinks(db, ["o/r#7", "o/r#999", "o/r#7"]);
    expect(Object.keys(links)).toEqual(["o/r#7"]);
  });

  it("handleListGitLinks returns { links } keyed by ref from ?refs=", async () => {
    const db = freshDb();
    const res = handleListGitLinks(db, new URL("http://x/api/git/links?refs=o%2Fr%237,o%2Fr%23999"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: Record<string, unknown> };
    expect(Object.keys(body.links)).toEqual(["o/r#7"]);
  });

  it("empty/missing refs → empty map", async () => {
    const db = freshDb();
    expect(getGitLinks(db, [])).toEqual({});
    const res = handleListGitLinks(db, new URL("http://x/api/git/links"));
    const body = (await res.json()) as { links: Record<string, unknown> };
    expect(body.links).toEqual({});
  });
});
