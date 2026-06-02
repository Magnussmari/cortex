/**
 * G-1113.B.4 — provider-aware source badge.
 *
 * Renders a small colour-dot + provider label, fed by a task's normalized
 * `SourceRef.provider` (G-1113.B.1/B.2). Today every task reads "GitHub" or
 * "Internal"; the badge is provider-aware so future GitLab / Azure DevOps /
 * Jira / Linear tasks render distinctly without touching call sites.
 */
import type { Provider } from "../../types";

export interface ProviderMeta {
  /** Human label shown in the badge + Sources view. */
  label: string;
}

const PROVIDER_META: Record<Provider, ProviderMeta> = {
  internal: { label: "Internal" },
  github: { label: "GitHub" },
  gitlab: { label: "GitLab" },
  "azure-devops": { label: "Azure DevOps" },
  jira: { label: "Jira" },
  linear: { label: "Linear" },
  bitbucket: { label: "Bitbucket" },
  custom: { label: "Custom" },
};

/** Pure lookup — display metadata for a provider. Total over the Provider union. */
export function providerMeta(provider: Provider): ProviderMeta {
  return PROVIDER_META[provider];
}

export interface ProviderBadgeProps {
  provider: Provider;
}

/**
 * Small provider badge: a per-provider colour dot (the "icon") + the label.
 * Colour comes from `.provider-badge .dot.provider-{name}` in global.css.
 */
export function ProviderBadge({ provider }: ProviderBadgeProps) {
  const meta = providerMeta(provider);
  return (
    <span className="provider-badge" title="Source">
      <span className={`dot provider-${provider}`} aria-hidden="true" />
      <span className="provider-label">{meta.label}</span>
    </span>
  );
}
