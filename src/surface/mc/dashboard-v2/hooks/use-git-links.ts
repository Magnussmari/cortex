/**
 * G-1113.C.6 — batch-fetch task → PR/branch links for the visible task rows.
 *
 * Given the github-sourced refs (`owner/repo#N`) of the visible tasks, fetches
 * `GET /api/git/links?refs=…` once and returns a map keyed by ref. Best-effort:
 * on any failure the map is empty and chips simply don't render (the task table
 * stays fully functional). Re-fetches when the ref set changes.
 */
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { GitLink } from "../../api/git-links";

interface GitLinksResponse {
  links: Record<string, GitLink>;
}

export function useGitLinks(refs: readonly string[]): Record<string, GitLink> {
  const [links, setLinks] = useState<Record<string, GitLink>>({});
  // Stable dependency: the sorted, de-duped ref set as one string.
  const key = Array.from(new Set(refs)).sort().join(",");

  useEffect(() => {
    if (key.length === 0) {
      setLinks({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await getJson<GitLinksResponse>(
          `/api/git/links?refs=${encodeURIComponent(key)}`
        );
        if (!cancelled) setLinks(res.links ?? {});
      } catch (_err) {
        // Best-effort surface: a links fetch failure must not break the task
        // table. Clear the map so stale chips don't linger; no user-facing error.
        if (!cancelled) setLinks({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return links;
}
