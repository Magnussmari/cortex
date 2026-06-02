/**
 * G-1113.B.4 — Sources config view.
 *
 * Lists the work-item providers Mission Control knows about and their state.
 * Today only GitHub + Internal are wired (the `tasks.source_system` CHECK
 * allows `github`/`internal`); the rest are declared in the {@link Provider}
 * union and render as "available" so the path to adding one is visible. When a
 * provider gets a real adapter (B.3+ pattern) it moves to "active".
 */
import { PROVIDERS, type Provider } from "../../types";
import { ProviderBadge } from "./provider-badge";

/** Providers with a wired adapter / accepted by the task source CHECK today. */
export const ACTIVE_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(["github", "internal"]);

export function sourceState(provider: Provider): "active" | "available" {
  return ACTIVE_PROVIDERS.has(provider) ? "active" : "available";
}

export function SourcesView() {
  return (
    <section className="scaffold-section sources-view" aria-label="Configured sources">
      <h2>Sources</h2>
      <p className="dim">
        Providers Mission Control can normalize tasks from. Only <strong>active</strong>{" "}
        providers are wired today; <strong>available</strong> ones are declared and
        gain an adapter as work lands.
      </p>
      <ul className="sources-list">
        {PROVIDERS.map((provider) => {
          const state = sourceState(provider);
          return (
            <li key={provider} className={`source-row source-${state}`}>
              <ProviderBadge provider={provider} />
              <span className={`source-state state-${state}`}>{state}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
