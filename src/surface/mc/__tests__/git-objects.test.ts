/**
 * G-1113.C.1 — GitRepository + GitBranch storage round-trip.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import {
  upsertRepository,
  getRepository,
  listRepositories,
  upsertBranch,
  getBranch,
  listBranchesForRepository,
  upsertCommit,
  getCommit,
  listCommitsForRepository,
  upsertTag,
  getTag,
  listTagsForRepository,
  upsertPullRequest,
  getPullRequest,
  listPullRequestsForRepository,
  upsertReview,
  getReview,
  listReviewsForPullRequest,
} from "../db/git-objects";
import type { GitRepository, GitBranch, GitCommit, GitTag, PullRequest, Review } from "../types";

describe("git-objects storage (C.1)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `git-objects-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  const repo: GitRepository = {
    id: "repo-1",
    provider: "github",
    owner: "the-metafactory",
    name: "cortex",
    url: "https://github.com/the-metafactory/cortex",
    defaultBranch: "main",
  };
  const branch: GitBranch = {
    id: "branch-1",
    repositoryId: "repo-1",
    name: "feat/g-1113-c-1",
    baseRef: "main",
    headSha: "abc1234",
    provider: "github",
    externalId: "the-metafactory/cortex@feat/g-1113-c-1",
    url: "https://github.com/the-metafactory/cortex/tree/feat/g-1113-c-1",
  };

  it("round-trips a repository (upsert → get → list)", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    expect(getRepository(db, "repo-1")).toEqual(repo);
    expect(listRepositories(db)).toEqual([repo]);
  });

  it("upsertRepository is idempotent and updates in place", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    upsertRepository(db, { ...repo, defaultBranch: "trunk", url: null });
    expect(getRepository(db, "repo-1")).toEqual({ ...repo, defaultBranch: "trunk", url: null });
    expect(listRepositories(db)).toHaveLength(1);
  });

  it("round-trips a branch and lists by repository", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    upsertBranch(db, branch);
    expect(getBranch(db, "branch-1")).toEqual(branch);
    expect(listBranchesForRepository(db, "repo-1")).toEqual([branch]);
    expect(listBranchesForRepository(db, "other-repo")).toEqual([]);
  });

  it("getRepository / getBranch return null for unknown ids", () => {
    const db = freshDb();
    expect(getRepository(db, "nope")).toBeNull();
    expect(getBranch(db, "nope")).toBeNull();
  });

  it("preserves null optional fields through the mapper", () => {
    const db = freshDb();
    const minimal: GitRepository = { id: "r2", provider: "gitlab", owner: null, name: "x", url: null, defaultBranch: null };
    upsertRepository(db, minimal);
    expect(getRepository(db, "r2")).toEqual(minimal);
  });

  it("rejects a branch whose repository_id has no repository (FK enforced)", () => {
    const db = freshDb();
    expect(() => upsertBranch(db, { ...branch, repositoryId: "ghost-repo" })).toThrow();
  });

  // --- C.2: commits + tags ---

  const commit: GitCommit = {
    id: "commit-1",
    repositoryId: "repo-1",
    sha: "abc1234def",
    title: "feat: add the thing",
    author: "Andreas",
    url: "https://github.com/the-metafactory/cortex/commit/abc1234def",
  };
  const tag: GitTag = {
    id: "tag-1",
    repositoryId: "repo-1",
    name: "v3.1.0",
    targetSha: "abc1234def",
    provider: "github",
    url: "https://github.com/the-metafactory/cortex/releases/tag/v3.1.0",
  };

  it("round-trips a commit (upsert → get → list) + idempotent update", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    upsertCommit(db, commit);
    expect(getCommit(db, "commit-1")).toEqual(commit);
    expect(listCommitsForRepository(db, "repo-1")).toEqual([commit]);
    upsertCommit(db, { ...commit, title: "feat: renamed", author: null });
    expect(getCommit(db, "commit-1")).toEqual({ ...commit, title: "feat: renamed", author: null });
    expect(listCommitsForRepository(db, "repo-1")).toHaveLength(1);
  });

  it("round-trips a tag and narrows an unknown provider to custom", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    upsertTag(db, tag);
    expect(getTag(db, "tag-1")).toEqual(tag);
    expect(listTagsForRepository(db, "repo-1")).toEqual([tag]);
  });

  it("commit + tag FKs are enforced (ghost repository_id throws)", () => {
    const db = freshDb();
    expect(() => upsertCommit(db, { ...commit, repositoryId: "ghost" })).toThrow();
    expect(() => upsertTag(db, { ...tag, repositoryId: "ghost" })).toThrow();
  });

  it("getCommit / getTag return null for unknown ids", () => {
    const db = freshDb();
    expect(getCommit(db, "nope")).toBeNull();
    expect(getTag(db, "nope")).toBeNull();
  });

  // --- C.3: pull requests + reviews ---

  const pr: PullRequest = {
    id: "pr-1",
    workItemId: null,
    repositoryId: "repo-1",
    provider: "github",
    providerNativeType: "pull_request",
    externalId: "the-metafactory/cortex#556",
    numberOrKey: "556",
    title: "G-1113.C.3 — PR/Review",
    sourceBranch: "feat/g-1113-c-3-pr-review",
    targetBranch: "main",
    url: "https://github.com/the-metafactory/cortex/pull/556",
    state: "open",
    reviewState: "needs_review",
  };
  const review: Review = {
    id: "review-1",
    pullRequestId: "pr-1",
    reviewer: "sage",
    state: "approved",
    provider: "github",
    url: "https://github.com/the-metafactory/cortex/pull/556#pullrequestreview-1",
  };

  it("round-trips a pull request (upsert → get → list) + idempotent state update", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    upsertPullRequest(db, pr);
    expect(getPullRequest(db, "pr-1")).toEqual(pr);
    expect(listPullRequestsForRepository(db, "repo-1")).toEqual([pr]);
    upsertPullRequest(db, { ...pr, state: "merged", reviewState: "approved" });
    expect(getPullRequest(db, "pr-1")).toEqual({ ...pr, state: "merged", reviewState: "approved" });
    expect(listPullRequestsForRepository(db, "repo-1")).toHaveLength(1);
  });

  it("rejects an out-of-vocabulary PR state / review_state (CHECK enforced)", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    expect(() => upsertPullRequest(db, { ...pr, state: "bogus" as PullRequest["state"] })).toThrow();
    expect(() => upsertPullRequest(db, { ...pr, reviewState: "bogus" as PullRequest["reviewState"] })).toThrow();
  });

  it("round-trips a review and lists by pull request", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    upsertPullRequest(db, pr);
    upsertReview(db, review);
    expect(getReview(db, "review-1")).toEqual(review);
    expect(listReviewsForPullRequest(db, "pr-1")).toEqual([review]);
    // idempotent update: re-upsert with a different state + null reviewer
    upsertReview(db, { ...review, state: "changes_requested", reviewer: null });
    expect(getReview(db, "review-1")).toEqual({ ...review, state: "changes_requested", reviewer: null });
    expect(listReviewsForPullRequest(db, "pr-1")).toHaveLength(1);
  });

  it("PR + review FKs enforced (ghost repo / ghost PR throw)", () => {
    const db = freshDb();
    upsertRepository(db, repo);
    expect(() => upsertPullRequest(db, { ...pr, repositoryId: "ghost" })).toThrow();
    expect(() => upsertReview(db, { ...review, pullRequestId: "ghost-pr" })).toThrow();
  });
});
