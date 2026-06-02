/**
 * G-1113.C.1 — storage for the first-class Git objects (design §3.8/§6).
 *
 * GitRepository + GitBranch persistence: upsert (id is the stable key, so
 * re-ingesting the same object updates in place), get-by-id, and list. Rows are
 * snake_case columns; the mappers project to the camelCase domain types. No
 * provider branching here — the model is provider-neutral (G-1113.B). Ingestion
 * that fills these from the GitHub adapter is C.5; commits/tags/PRs are C.2/C.3.
 */
import type { Database } from "bun:sqlite";
import type {
  GitRepository,
  GitBranch,
  GitCommit,
  GitTag,
  PullRequest,
  PullRequestState,
  PullRequestReviewState,
  Review,
  ReviewState,
} from "../types";
import { isProvider } from "../types";

interface RepoRow {
  id: string;
  provider: string;
  owner: string | null;
  name: string;
  url: string | null;
  default_branch: string | null;
}

interface BranchRow {
  id: string;
  repository_id: string;
  name: string;
  base_ref: string | null;
  head_sha: string | null;
  provider: string;
  external_id: string | null;
  url: string | null;
}

function rowToRepository(r: RepoRow): GitRepository {
  return {
    id: r.id,
    // Read-boundary narrowing: provider has no DB CHECK, so enforce the
    // Provider invariant here (matches db/tasks.ts) rather than blind-casting.
    provider: isProvider(r.provider) ? r.provider : "custom",
    owner: r.owner,
    name: r.name,
    url: r.url,
    defaultBranch: r.default_branch,
  };
}

function rowToBranch(r: BranchRow): GitBranch {
  return {
    id: r.id,
    repositoryId: r.repository_id,
    name: r.name,
    baseRef: r.base_ref,
    headSha: r.head_sha,
    provider: isProvider(r.provider) ? r.provider : "custom",
    externalId: r.external_id,
    url: r.url,
  };
}

/** Insert or update a repository by id (idempotent re-ingestion). */
export function upsertRepository(db: Database, repo: GitRepository): void {
  db.query(
    `INSERT INTO git_repositories (id, provider, owner, name, url, default_branch)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider,
       owner = excluded.owner,
       name = excluded.name,
       url = excluded.url,
       default_branch = excluded.default_branch,
       updated_at = unixepoch()`
  ).run(repo.id, repo.provider, repo.owner, repo.name, repo.url, repo.defaultBranch);
}

export function getRepository(db: Database, id: string): GitRepository | null {
  const row = db.query(`SELECT * FROM git_repositories WHERE id = ?`).get(id) as RepoRow | null;
  return row ? rowToRepository(row) : null;
}

export function listRepositories(db: Database): GitRepository[] {
  const rows = db.query(`SELECT * FROM git_repositories ORDER BY owner, name`).all() as RepoRow[];
  return rows.map(rowToRepository);
}

/** Insert or update a branch by id (idempotent re-ingestion). */
export function upsertBranch(db: Database, branch: GitBranch): void {
  db.query(
    `INSERT INTO git_branches
       (id, repository_id, name, base_ref, head_sha, provider, external_id, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repository_id = excluded.repository_id,
       name = excluded.name,
       base_ref = excluded.base_ref,
       head_sha = excluded.head_sha,
       provider = excluded.provider,
       external_id = excluded.external_id,
       url = excluded.url,
       updated_at = unixepoch()`
  ).run(
    branch.id,
    branch.repositoryId,
    branch.name,
    branch.baseRef,
    branch.headSha,
    branch.provider,
    branch.externalId,
    branch.url
  );
}

export function getBranch(db: Database, id: string): GitBranch | null {
  const row = db.query(`SELECT * FROM git_branches WHERE id = ?`).get(id) as BranchRow | null;
  return row ? rowToBranch(row) : null;
}

export function listBranchesForRepository(db: Database, repositoryId: string): GitBranch[] {
  const rows = db
    .query(`SELECT * FROM git_branches WHERE repository_id = ? ORDER BY name`)
    .all(repositoryId) as BranchRow[];
  return rows.map(rowToBranch);
}

// --- commits (G-1113.C.2) ---

interface CommitRow {
  id: string;
  repository_id: string;
  sha: string;
  title: string;
  author: string | null;
  url: string | null;
}

function rowToCommit(r: CommitRow): GitCommit {
  return {
    id: r.id,
    repositoryId: r.repository_id,
    sha: r.sha,
    title: r.title,
    author: r.author,
    url: r.url,
  };
}

/** Insert or update a commit by id (idempotent re-ingestion). */
export function upsertCommit(db: Database, commit: GitCommit): void {
  db.query(
    `INSERT INTO git_commits (id, repository_id, sha, title, author, url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repository_id = excluded.repository_id,
       sha = excluded.sha,
       title = excluded.title,
       author = excluded.author,
       url = excluded.url,
       updated_at = unixepoch()`
  ).run(commit.id, commit.repositoryId, commit.sha, commit.title, commit.author, commit.url);
}

export function getCommit(db: Database, id: string): GitCommit | null {
  const row = db.query(`SELECT * FROM git_commits WHERE id = ?`).get(id) as CommitRow | null;
  return row ? rowToCommit(row) : null;
}

export function listCommitsForRepository(db: Database, repositoryId: string): GitCommit[] {
  const rows = db
    .query(`SELECT * FROM git_commits WHERE repository_id = ? ORDER BY sha`)
    .all(repositoryId) as CommitRow[];
  return rows.map(rowToCommit);
}

// --- tags (G-1113.C.2) ---

interface TagRow {
  id: string;
  repository_id: string;
  name: string;
  target_sha: string | null;
  provider: string;
  url: string | null;
}

function rowToTag(r: TagRow): GitTag {
  return {
    id: r.id,
    repositoryId: r.repository_id,
    name: r.name,
    targetSha: r.target_sha,
    provider: isProvider(r.provider) ? r.provider : "custom",
    url: r.url,
  };
}

/** Insert or update a tag by id (idempotent re-ingestion). */
export function upsertTag(db: Database, tag: GitTag): void {
  db.query(
    `INSERT INTO git_tags (id, repository_id, name, target_sha, provider, url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repository_id = excluded.repository_id,
       name = excluded.name,
       target_sha = excluded.target_sha,
       provider = excluded.provider,
       url = excluded.url,
       updated_at = unixepoch()`
  ).run(tag.id, tag.repositoryId, tag.name, tag.targetSha, tag.provider, tag.url);
}

export function getTag(db: Database, id: string): GitTag | null {
  const row = db.query(`SELECT * FROM git_tags WHERE id = ?`).get(id) as TagRow | null;
  return row ? rowToTag(row) : null;
}

export function listTagsForRepository(db: Database, repositoryId: string): GitTag[] {
  const rows = db
    .query(`SELECT * FROM git_tags WHERE repository_id = ? ORDER BY name`)
    .all(repositoryId) as TagRow[];
  return rows.map(rowToTag);
}

// --- pull requests + reviews (G-1113.C.3) ---

interface PullRequestRow {
  id: string;
  work_item_id: string | null;
  repository_id: string;
  provider: string;
  provider_native_type: string;
  external_id: string;
  number_or_key: string;
  title: string;
  source_branch: string;
  target_branch: string;
  url: string;
  state: string;
  review_state: string;
}

function rowToPullRequest(r: PullRequestRow): PullRequest {
  return {
    id: r.id,
    workItemId: r.work_item_id,
    repositoryId: r.repository_id,
    provider: isProvider(r.provider) ? r.provider : "custom",
    providerNativeType: r.provider_native_type,
    externalId: r.external_id,
    numberOrKey: r.number_or_key,
    title: r.title,
    sourceBranch: r.source_branch,
    targetBranch: r.target_branch,
    url: r.url,
    // state / review_state are CHECK-constrained in the schema, so the cast is
    // backed by the DB (unlike provider, which has no CHECK).
    state: r.state as PullRequestState,
    reviewState: r.review_state as PullRequestReviewState,
  };
}

/** Insert or update a pull request by id (idempotent re-ingestion). */
export function upsertPullRequest(db: Database, pr: PullRequest): void {
  db.query(
    `INSERT INTO pull_requests
       (id, work_item_id, repository_id, provider, provider_native_type,
        external_id, number_or_key, title, source_branch, target_branch, url,
        state, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       work_item_id = excluded.work_item_id,
       repository_id = excluded.repository_id,
       provider = excluded.provider,
       provider_native_type = excluded.provider_native_type,
       external_id = excluded.external_id,
       number_or_key = excluded.number_or_key,
       title = excluded.title,
       source_branch = excluded.source_branch,
       target_branch = excluded.target_branch,
       url = excluded.url,
       state = excluded.state,
       review_state = excluded.review_state,
       updated_at = unixepoch()`
  ).run(
    pr.id,
    pr.workItemId,
    pr.repositoryId,
    pr.provider,
    pr.providerNativeType,
    pr.externalId,
    pr.numberOrKey,
    pr.title,
    pr.sourceBranch,
    pr.targetBranch,
    pr.url,
    pr.state,
    pr.reviewState
  );
}

export function getPullRequest(db: Database, id: string): PullRequest | null {
  const row = db.query(`SELECT * FROM pull_requests WHERE id = ?`).get(id) as PullRequestRow | null;
  return row ? rowToPullRequest(row) : null;
}

export function listPullRequestsForRepository(db: Database, repositoryId: string): PullRequest[] {
  const rows = db
    .query(`SELECT * FROM pull_requests WHERE repository_id = ? ORDER BY number_or_key`)
    .all(repositoryId) as PullRequestRow[];
  return rows.map(rowToPullRequest);
}

interface ReviewRow {
  id: string;
  pull_request_id: string;
  reviewer: string | null;
  state: string;
  provider: string;
  url: string | null;
}

function rowToReview(r: ReviewRow): Review {
  return {
    id: r.id,
    pullRequestId: r.pull_request_id,
    reviewer: r.reviewer,
    state: r.state as ReviewState, // CHECK-constrained in the schema
    provider: isProvider(r.provider) ? r.provider : "custom",
    url: r.url,
  };
}

/** Insert or update a review by id (idempotent re-ingestion). */
export function upsertReview(db: Database, review: Review): void {
  db.query(
    `INSERT INTO reviews (id, pull_request_id, reviewer, state, provider, url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pull_request_id = excluded.pull_request_id,
       reviewer = excluded.reviewer,
       state = excluded.state,
       provider = excluded.provider,
       url = excluded.url,
       updated_at = unixepoch()`
  ).run(review.id, review.pullRequestId, review.reviewer, review.state, review.provider, review.url);
}

export function getReview(db: Database, id: string): Review | null {
  const row = db.query(`SELECT * FROM reviews WHERE id = ?`).get(id) as ReviewRow | null;
  return row ? rowToReview(row) : null;
}

export function listReviewsForPullRequest(db: Database, pullRequestId: string): Review[] {
  const rows = db
    .query(`SELECT * FROM reviews WHERE pull_request_id = ? ORDER BY id`)
    .all(pullRequestId) as ReviewRow[];
  return rows.map(rowToReview);
}
