/**
 * G-1113.C.7 — per-repository panel (software mode). Each repository card
 * groups its pull requests, branches, and releases from the Git model.
 */
import type { RepositoryView } from "../../api/git-repos";

interface ColItem {
  key: string;
  label: string;
  url: string | null;
}

function RepoColumn({ title, items }: { title: string; items: ColItem[] }) {
  return (
    <div className="repo-col">
      <h4>
        {title} <span className="dim">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="dim faint">—</p>
      ) : (
        <ul>
          {items.map((i) => (
            <li key={i.key}>
              {i.url ? (
                <a href={i.url} target="_blank" rel="noopener noreferrer">
                  {i.label}
                </a>
              ) : (
                i.label
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface RepositoriesViewProps {
  repositories: RepositoryView[];
  loaded: boolean;
}

export function RepositoriesView({ repositories, loaded }: RepositoriesViewProps) {
  return (
    <section className="scaffold-section repos-view" aria-label="Repositories">
      <h2>Repositories</h2>
      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : repositories.length === 0 ? (
        <p className="dim">
          No repositories ingested yet — create a task from a GitHub PR to populate the
          software-mode model.
        </p>
      ) : (
        repositories.map(({ repository: r, branches, pullRequests, releases }) => (
          <div key={r.id} className="repo-card">
            <h3>
              {r.owner ? `${r.owner}/${r.name}` : r.name}
              {r.url ? (
                <a className="dim mono repo-link" href={r.url} target="_blank" rel="noopener noreferrer">
                  ↗
                </a>
              ) : null}
            </h3>
            <div className="repo-cols">
              <RepoColumn
                title="Pull requests"
                items={pullRequests.map((p) => ({
                  key: p.id,
                  label: `#${p.numberOrKey} · ${p.state}`,
                  url: p.url,
                }))}
              />
              <RepoColumn
                title="Branches"
                items={branches.map((b) => ({ key: b.id, label: b.name, url: b.url }))}
              />
              <RepoColumn
                title="Releases"
                items={releases.map((rel) => ({
                  key: rel.id,
                  label: `${rel.name} · ${rel.state}`,
                  url: rel.url,
                }))}
              />
            </div>
          </div>
        ))
      )}
    </section>
  );
}
