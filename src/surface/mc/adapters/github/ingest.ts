/**
 * G-1113.C.5 — GitHub adapter ingestion: map GitHub data onto the C.1–C.4 model
 * and persist it. Pure builders + thin persist helpers over `db/git-objects`.
 *
 * Scope (Moderate, per the C.5 decision): from the github-task-create path we
 * can faithfully populate GitRepository (from the ref), and — for PR refs, via
 * the `/pulls/:number` fetch — PullRequest + source/target GitBranch + head
 * GitCommit. Checks/deployments/releases (and fuller commit history) have no
 * data source from this path and are deferred to C.5b (#571).
 */
import type { Database } from "bun:sqlite";
import type { GitHubRef } from "./ref";
import type { GitHubPullRequestDetail } from "./fetch";
import type {
  GitRepository,
  GitBranch,
  GitCommit,
  PullRequest,
  PullRequestState,
} from "../../types";
import {
  upsertRepository,
  upsertBranch,
  upsertCommit,
  upsertPullRequest,
} from "../../db/git-objects";

const PROVIDER = "github" as const;

/** Stable, provider-namespaced repository id (`github:owner/name`). */
function repoId(owner: string, name: string): string {
  return `github:${owner}/${name}`;
}
function repoWebUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}`;
}

export function githubRepositoryFromRef(ref: GitHubRef): GitRepository {
  return {
    id: repoId(ref.owner, ref.repo),
    provider: PROVIDER,
    owner: ref.owner,
    name: ref.repo,
    url: repoWebUrl(ref.owner, ref.repo),
    defaultBranch: null,
  };
}

function prState(detail: GitHubPullRequestDetail): PullRequestState {
  if (detail.merged) return "merged";
  if (detail.draft) return "draft";
  if (detail.state === "closed") return "closed";
  return "open";
}

export interface GithubPrModel {
  repository: GitRepository;
  pullRequest: PullRequest;
  sourceBranch: GitBranch;
  targetBranch: GitBranch;
  headCommit: GitCommit;
}

/** Build the full PR-side model from a parsed ref + the `/pulls` detail. */
export function buildGithubPrModel(ref: GitHubRef, detail: GitHubPullRequestDetail): GithubPrModel {
  const rid = repoId(ref.owner, ref.repo);
  const web = repoWebUrl(ref.owner, ref.repo);
  const mkBranch = (name: string, headSha: string | null): GitBranch => ({
    id: `${rid}@${name}`,
    repositoryId: rid,
    name,
    baseRef: null,
    headSha,
    provider: PROVIDER,
    externalId: null,
    url: `${web}/tree/${name}`,
  });
  return {
    repository: githubRepositoryFromRef(ref),
    sourceBranch: mkBranch(detail.headRef, detail.headSha),
    targetBranch: mkBranch(detail.baseRef, null),
    headCommit: {
      id: `${rid}@${detail.headSha}`,
      repositoryId: rid,
      sha: detail.headSha,
      // PR detail carries the SHA but not the commit message; the short SHA is
      // an honest fallback label (the real message arrives via push events,
      // C.5b #571) — never fabricate a title.
      title: detail.headSha.slice(0, 7),
      author: null,
      url: `${web}/commit/${detail.headSha}`,
    },
    pullRequest: {
      id: `${rid}#${detail.number}`,
      workItemId: null,
      repositoryId: rid,
      provider: PROVIDER,
      providerNativeType: "pull_request",
      externalId: `${ref.owner}/${ref.repo}#${detail.number}`,
      numberOrKey: String(detail.number),
      title: detail.title,
      sourceBranch: detail.headRef,
      targetBranch: detail.baseRef,
      url: detail.html_url,
      state: prState(detail),
      // Reviews aren't in the PR detail; reviewState stays "none" until review
      // ingestion lands (C.5b).
      reviewState: "none",
    },
  };
}

/**
 * Persist the PR model. Repository first (FK target), then branches/commit/PR
 * (all FK → repository ON DELETE RESTRICT). Idempotent (all upserts by id).
 */
export function persistGithubPrModel(db: Database, model: GithubPrModel): void {
  upsertRepository(db, model.repository);
  upsertBranch(db, model.sourceBranch);
  upsertBranch(db, model.targetBranch);
  upsertCommit(db, model.headCommit);
  upsertPullRequest(db, model.pullRequest);
}

/** Persist just the repository (for issue-type tasks — no PR detail). */
export function persistGithubRepository(db: Database, ref: GitHubRef): GitRepository {
  const repo = githubRepositoryFromRef(ref);
  upsertRepository(db, repo);
  return repo;
}
