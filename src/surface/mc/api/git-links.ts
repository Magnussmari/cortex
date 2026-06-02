/**
 * G-1113.C.6 — task → Git-model link projection + batch endpoint.
 *
 * The dashboard renders first-class PR + branch chips on task rows. A
 * github-sourced task links to its PR by ref (the task's `source_external_id`
 * equals the PR's `externalId`; `PullRequest.workItemId` is wired in Phase D).
 * This serves a batch lookup so the task table fetches all visible rows' links
 * in one call (no N+1).
 */
import type { Database } from "bun:sqlite";
import type { PullRequest, GitBranch } from "../types";
import { getPullRequestByExternalId, getBranch } from "../db/git-objects";

export interface GitLink {
  pullRequest: PullRequest;
  sourceBranch: GitBranch | null;
  targetBranch: GitBranch | null;
}

/**
 * Bound the batch. Matches the task feed's page size (TASKS_QUERY_LIMIT=500 in
 * db/tasks.ts) so every visible row can resolve its chips — while still capping
 * a pathological query string. (If the page limit grows, raise this with it.)
 */
const MAX_REFS = 500;

/**
 * Resolve each external ref (`owner/repo#N`) to its {@link GitLink}, or omit it
 * when no PR is linked. Branch ids follow the C.5 ingest convention
 * `${repositoryId}@${branchName}`.
 */
export function getGitLinks(db: Database, externalIds: string[]): Record<string, GitLink> {
  const out: Record<string, GitLink> = {};
  const seen = new Set<string>();
  for (const ref of externalIds) {
    if (seen.has(ref) || ref.length === 0) continue;
    seen.add(ref);
    const pr = getPullRequestByExternalId(db, ref);
    if (!pr) continue;
    out[ref] = {
      pullRequest: pr,
      sourceBranch: getBranch(db, `${pr.repositoryId}@${pr.sourceBranch}`),
      targetBranch: getBranch(db, `${pr.repositoryId}@${pr.targetBranch}`),
    };
  }
  return out;
}

/** GET /api/git/links?refs=owner/repo%23N,owner/repo%23M — batch link lookup. */
export function handleListGitLinks(db: Database, url: URL): Response {
  const raw = url.searchParams.get("refs") ?? "";
  const refs = raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .slice(0, MAX_REFS);
  const links = getGitLinks(db, refs);
  return new Response(JSON.stringify({ links }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
