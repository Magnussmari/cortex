/**
 * G-1113.C.6 — first-class PR + branch chips for a task row.
 *
 * Fed by a {@link GitLink} (the task's linked PR + its source/target branches,
 * matched by ref — see api/git-links). The PR chip is state-coloured and links
 * out; review state shows on hover (checks are deferred to C.5b, so the hover
 * surfaces review state only for now). Branch chips show source → target.
 */
import type { GitLink } from "../../api/git-links";

const PR_STATE_KIND: Record<string, string> = {
  open: "pr-open",
  draft: "pr-draft",
  merged: "pr-merged",
  closed: "pr-closed",
};

export interface GitChipsProps {
  link: GitLink;
}

export function GitChips({ link }: GitChipsProps) {
  const { pullRequest: pr, sourceBranch } = link;
  const reviewLabel = pr.reviewState === "none" ? "no review yet" : pr.reviewState.replace(/_/g, " ");
  return (
    <span className="git-chips">
      <a
        className={`git-chip pr ${PR_STATE_KIND[pr.state] ?? "pr-unknown"}`}
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Pull request #${pr.numberOrKey} · ${pr.state} · review: ${reviewLabel}`}
      >
        #{pr.numberOrKey} {pr.state}
      </a>
      <span
        className="git-chip branch"
        title={
          `${pr.sourceBranch} → ${pr.targetBranch}` +
          (sourceBranch?.headSha ? ` · ${sourceBranch.headSha.slice(0, 7)}` : "")
        }
      >
        {pr.sourceBranch} → {pr.targetBranch}
      </span>
    </span>
  );
}
