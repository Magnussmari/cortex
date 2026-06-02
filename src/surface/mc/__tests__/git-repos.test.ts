/**
 * G-1113.C.7 — per-repository projection + endpoint.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import {
  upsertRepository,
  upsertBranch,
  upsertPullRequest,
  upsertRelease,
} from "../db/git-objects";
import { getRepositoriesWithGit, handleListRepositories } from "../api/git-repos";
import type { GitRepository, GitBranch, PullRequest, Release } from "../types";

const RID = "github:o/r";
const repo: GitRepository = { id: RID, provider: "github", owner: "o", name: "r", url: "https://github.com/o/r", defaultBranch: "main" };
const branch: GitBranch = { id: `${RID}@main`, repositoryId: RID, name: "main", baseRef: null, headSha: null, provider: "github", externalId: null, url: null };
const pr: PullRequest = { id: `${RID}#1`, workItemId: null, repositoryId: RID, provider: "github", providerNativeType: "pull_request", externalId: "o/r#1", numberOrKey: "1", title: "T", sourceBranch: "feat", targetBranch: "main", url: "https://github.com/o/r/pull/1", state: "open", reviewState: "none" };
const release: Release = { id: `${RID}@v1`, repositoryId: RID, provider: "github", externalId: null, name: "v1.0.0", tagName: "v1.0.0", url: null, state: "published" };

describe("git-repos projection (C.7)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });
  function freshDb() {
    const p = join(tmpdir(), `git-repos-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("groups a repository with its branches, PRs, and releases", () => {
    const db = freshDb();
    upsertRepository(db, repo); upsertBranch(db, branch); upsertPullRequest(db, pr); upsertRelease(db, release);
    const views = getRepositoriesWithGit(db);
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({ repository: repo, branches: [branch], pullRequests: [pr], releases: [release] });
  });

  it("returns an empty list when no repositories are ingested", () => {
    const db = freshDb();
    expect(getRepositoriesWithGit(db)).toEqual([]);
  });

  it("handleListRepositories returns { repositories } JSON", async () => {
    const db = freshDb();
    upsertRepository(db, repo);
    const res = handleListRepositories(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: { repository: GitRepository }[] };
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0]!.repository.id).toBe(RID);
  });
});
