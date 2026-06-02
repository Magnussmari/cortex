/**
 * G-1113.C.7 — fetch the per-repository Git projection for the Repositories
 * panel. Only fetches when `enabled` (software mode on + panel visible).
 * Best-effort: a failure yields an empty list, not an error surface.
 */
import { useEffect, useState } from "react";
import { getJson } from "../lib/api";
import type { RepositoryView } from "../../api/git-repos";

interface RepositoriesResponse {
  repositories: RepositoryView[];
}

export function useRepositories(enabled: boolean): {
  repositories: RepositoryView[];
  loaded: boolean;
} {
  const [repositories, setRepositories] = useState<RepositoryView[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getJson<RepositoriesResponse>("/api/git/repositories");
        if (!cancelled) {
          setRepositories(res.repositories ?? []);
          setLoaded(true);
        }
      } catch (_err) {
        // Best-effort: the panel shows an empty state rather than an error.
        if (!cancelled) {
          setRepositories([]);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { repositories, loaded };
}
