/**
 * G-1113.C.5 — GitHub adapter ingestion: buildGithubPrModel mapping, persist
 * round-trip, PR-state mapping, and fetchPullRequest (fake gh spawn).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import {
  buildGithubPrModel,
  persistGithubPrModel,
  persistGithubRepository,
  githubRepositoryFromRef,
  fetchPullRequest,
  type GitHubPullRequestDetail,
} from "../adapters/github";
import type { GhSpawnFn } from "../adapters/github";
import {
  getRepository,
  getBranch,
  getCommit,
  getPullRequest,
} from "../db/git-objects";

const REF = { owner: "the-metafactory", repo: "cortex", number: 558, kind: "pr" as const };
const DETAIL: GitHubPullRequestDetail = {
  state: "open",
  merged: false,
  draft: false,
  title: "G-1113.C.5 — GitHub adapter ingestion",
  html_url: "https://github.com/the-metafactory/cortex/pull/558",
  number: 558,
  headRef: "feat/g-1113-c-5-github-ingest",
  baseRef: "main",
  headSha: "abcdef1234567890",
};

// Fake gh spawn returning a fixed stdout/exitCode (mirrors task-create-endpoints).
function makeSpawn(exitCode: number, stdout: string, stderr = ""): GhSpawnFn {
  return () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(stdout)); c.close(); },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(stderr)); c.close(); },
    }),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  });
}

describe("github ingest (C.5)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `gh-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("githubRepositoryFromRef maps owner/repo to a github GitRepository", () => {
    expect(githubRepositoryFromRef(REF)).toEqual({
      id: "github:the-metafactory/cortex",
      provider: "github",
      owner: "the-metafactory",
      name: "cortex",
      url: "https://github.com/the-metafactory/cortex",
      defaultBranch: null,
    });
  });

  it("buildGithubPrModel maps PR detail to repo + PR + branches + head commit", () => {
    const m = buildGithubPrModel(REF, DETAIL);
    expect(m.repository.id).toBe("github:the-metafactory/cortex");
    expect(m.pullRequest).toMatchObject({
      id: "github:the-metafactory/cortex#558",
      repositoryId: "github:the-metafactory/cortex",
      providerNativeType: "pull_request",
      numberOrKey: "558",
      sourceBranch: "feat/g-1113-c-5-github-ingest",
      targetBranch: "main",
      state: "open",
      reviewState: "none",
    });
    expect(m.sourceBranch).toMatchObject({ name: "feat/g-1113-c-5-github-ingest", headSha: "abcdef1234567890" });
    expect(m.targetBranch).toMatchObject({ name: "main", headSha: null });
    // commit title falls back to the short SHA (no message in PR detail)
    expect(m.headCommit).toMatchObject({ sha: "abcdef1234567890", title: "abcdef1", author: null });
  });

  it("PR state maps merged > draft > closed > open", () => {
    expect(buildGithubPrModel(REF, { ...DETAIL, merged: true }).pullRequest.state).toBe("merged");
    expect(buildGithubPrModel(REF, { ...DETAIL, draft: true }).pullRequest.state).toBe("draft");
    expect(buildGithubPrModel(REF, { ...DETAIL, state: "closed" }).pullRequest.state).toBe("closed");
    expect(buildGithubPrModel(REF, DETAIL).pullRequest.state).toBe("open");
  });

  it("persistGithubPrModel round-trips repo + branches + commit + PR", () => {
    const db = freshDb();
    const m = buildGithubPrModel(REF, DETAIL);
    persistGithubPrModel(db, m);
    expect(getRepository(db, m.repository.id)).toEqual(m.repository);
    expect(getBranch(db, m.sourceBranch.id)).toEqual(m.sourceBranch);
    expect(getBranch(db, m.targetBranch.id)).toEqual(m.targetBranch);
    expect(getCommit(db, m.headCommit.id)).toEqual(m.headCommit);
    expect(getPullRequest(db, m.pullRequest.id)).toEqual(m.pullRequest);
    // idempotent
    persistGithubPrModel(db, buildGithubPrModel(REF, { ...DETAIL, state: "closed", merged: true }));
    expect(getPullRequest(db, m.pullRequest.id)?.state).toBe("merged");
  });

  it("persistGithubRepository upserts the repository alone", () => {
    const db = freshDb();
    const repo = persistGithubRepository(db, REF);
    expect(getRepository(db, repo.id)).toEqual(repo);
  });

  it("fetchPullRequest parses /pulls JSON into GitHubPullRequestDetail", async () => {
    const ghJson = JSON.stringify({
      state: "open", merged: false, draft: true, title: "T",
      html_url: "https://github.com/o/r/pull/9", number: 9,
      head: { ref: "feat", sha: "deadbeef" }, base: { ref: "main" },
    });
    const res = await fetchPullRequest({ owner: "o", repo: "r", number: 9 }, { spawn: makeSpawn(0, ghJson) });
    expect(res).toEqual({
      state: "open", merged: false, draft: true, title: "T",
      html_url: "https://github.com/o/r/pull/9", number: 9,
      headRef: "feat", baseRef: "main", headSha: "deadbeef",
    });
  });

  it("fetchPullRequest maps a 404 to not_found", async () => {
    const res = await fetchPullRequest({ owner: "o", repo: "r", number: 9 }, { spawn: makeSpawn(1, "", "HTTP 404: Not Found") });
    expect(res).toMatchObject({ kind: "not_found" });
  });
});
