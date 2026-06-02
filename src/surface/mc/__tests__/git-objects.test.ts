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
} from "../db/git-objects";
import type { GitRepository, GitBranch } from "../types";

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
});
