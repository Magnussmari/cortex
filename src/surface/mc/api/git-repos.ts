/**
 * G-1113.C.7 — per-repository projection + endpoint for the Repositories panel.
 *
 * Groups the software-mode Git model (C.1–C.4) by repository: each repo with
 * its branches, pull requests, and releases. Read-only; reuses the git-objects
 * list queries.
 */
import type { Database } from "bun:sqlite";
import type { GitRepository, GitBranch, PullRequest, Release } from "../types";
import {
  listRepositories,
  listBranchesForRepository,
  listPullRequestsForRepository,
  listReleasesForRepository,
} from "../db/git-objects";

export interface RepositoryView {
  repository: GitRepository;
  branches: GitBranch[];
  pullRequests: PullRequest[];
  releases: Release[];
}

export function getRepositoriesWithGit(db: Database): RepositoryView[] {
  return listRepositories(db).map((repository) => ({
    repository,
    branches: listBranchesForRepository(db, repository.id),
    pullRequests: listPullRequestsForRepository(db, repository.id),
    releases: listReleasesForRepository(db, repository.id),
  }));
}

/** GET /api/git/repositories — repos grouped with their branches/PRs/releases. */
export function handleListRepositories(db: Database): Response {
  return new Response(JSON.stringify({ repositories: getRepositoriesWithGit(db) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
