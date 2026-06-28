/**
 * MC-D2 (cortex#1289) — the constellation skin's **command bar** (64px top chrome).
 *
 * Left → right: the ◎ MISSION CONTROL logo · `PRINCIPAL <name>` · the `ALT`
 * you-are-here breadcrumb (clickable segments) · a right-aligned **posture pill**
 * (`ADMIN` / `MEMBER`) + the joined-network count.
 *
 * Honest placeholders (the skin renders truth, never theater):
 *   - principal unknown (no local agent yet) → an em-dash, not a fabricated name;
 *   - at the 10k-ft root no single network is selected, so there is no single
 *     posture — the pill is absent rather than guessed (`posture === null`).
 *
 * Posture term is `admin` / `member` — the deprecated network-posture label is
 * forbidden (CONTEXT.md §"Network posture (admin vs member)"; the mockup's
 * legacy "YOU …" label renders here as ADMIN).
 *
 * Presentation-only: all logic (breadcrumb, posture) is computed by the pure
 * `mc-shell-model`; this component just paints it and reports clicks.
 */

import type {
  BreadcrumbSegment,
  NetworkPosture,
} from "../lib/mc-shell-model";

export interface McCommandBarProps {
  /** The serving (local) principal; `null` until a local agent is observed. */
  principal: string | null;
  /** The you-are-here breadcrumb (root always present). */
  breadcrumb: readonly BreadcrumbSegment[];
  /** The selected network's posture, or `null` at the root (no pill then). */
  posture: NetworkPosture | null;
  /** Count of joined networks (for the right-aligned `N NETWORKS` readout). */
  networkCount: number;
  /** Navigate to a breadcrumb segment (ascend / re-select). */
  onNavigate: (segment: BreadcrumbSegment) => void;
}

export function McCommandBar({
  principal,
  breadcrumb,
  posture,
  networkCount,
  onNavigate,
}: McCommandBarProps) {
  return (
    <header className="mc-command-bar" aria-label="Mission Control command bar">
      {/* Logo: concentric rings + core (the ◎ MISSION CONTROL mark). */}
      <div className="mc-logo">
        <span className="mc-logo-mark" aria-hidden="true">
          <span className="mc-logo-ring" />
          <span className="mc-logo-core" />
        </span>
        <span className="mc-logo-text">MISSION&nbsp;CONTROL</span>
      </div>

      <span className="mc-cb-divider" aria-hidden="true" />

      {/* Principal. */}
      <div className="mc-cb-principal">
        <span className="mc-cb-key">PRINCIPAL</span>
        <span className="mc-cb-principal-name">
          {principal && principal.length > 0 ? principal : "—"}
        </span>
      </div>

      <span className="mc-cb-divider" aria-hidden="true" />

      {/* You-are-here breadcrumb. */}
      <nav className="mc-breadcrumb" aria-label="You are here">
        <span className="mc-cb-key">ALT</span>
        {breadcrumb.map((seg, i) => (
          <span className="mc-breadcrumb-seg-wrap" key={`${seg.level}:${seg.networkId ?? "root"}`}>
            {i > 0 && <span className="mc-breadcrumb-sep" aria-hidden="true">/</span>}
            <button
              type="button"
              className={
                "mc-breadcrumb-seg" + (i === 0 ? " mc-breadcrumb-seg--root" : "")
              }
              aria-current={i === breadcrumb.length - 1 ? "page" : undefined}
              data-network-id={seg.networkId ?? undefined}
              onClick={() => onNavigate(seg)}
            >
              {seg.label}
            </button>
          </span>
        ))}
      </nav>

      <span className="mc-cb-spacer" />

      {/* Posture pill — only when a single network is selected. */}
      {posture !== null && (
        <span
          className={`mc-posture-pill mc-posture-pill--${posture}`}
          data-posture={posture}
        >
          <span className="mc-posture-dot" aria-hidden="true" />
          {posture === "admin" ? "ADMIN" : "MEMBER"}
        </span>
      )}

      {/* Joined-network count. */}
      <div className="mc-cb-netcount">
        <span className="mc-cb-netcount-n">{networkCount}</span>
        <span className="mc-cb-key">
          {networkCount === 1 ? "NETWORK" : "NETWORKS"}
        </span>
      </div>
    </header>
  );
}
