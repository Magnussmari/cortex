/**
 * MC-D2 (cortex#1289) — the constellation skin's **altitude rail** (left chrome).
 *
 * The primary navigation gesture: a vertical spine of altitude stops —
 * NETWORKS (10k ft) → NETWORK → STACK → ASSISTANT → SESSION — with the current
 * level lit. D2 wires the top two against real data; the deeper three are honest
 * `future` stubs (dimmed, non-interactive) that D3+ deepens as it re-skins the
 * canvas.
 *
 * The NETWORK stop, when reachable, expands the joined networks as drill targets:
 * click a network → drill in (NETWORKS → NETWORK); the lit NETWORKS stop ascends
 * back to the 10k-ft root. That makes NETWORKS ↔ NETWORK genuinely navigable with
 * the live `/api/networks` data — never a fabricated drill.
 *
 * Presentation-only: reachability + posture are computed by `mc-shell-model`.
 */

import {
  ALTITUDE_LEVELS,
  ALTITUDE_META,
  networkPosture,
  stopReachability,
  type AltitudeSelection,
} from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../hooks/use-networks";

export interface McAltitudeRailProps {
  /** The current you-are-here selection. */
  selection: AltitudeSelection;
  /** Joined networks (drill targets under the NETWORK stop). */
  networks: readonly NetworkMembershipDTO[];
  /** Ascend to the 10k-ft networks root. */
  onAscendRoot: () => void;
  /** Drill into a specific network (networks → network). */
  onDrillNetwork: (networkId: string) => void;
}

export function McAltitudeRail({
  selection,
  networks,
  onAscendRoot,
  onDrillNetwork,
}: McAltitudeRailProps) {
  const networkCount = networks.length;

  return (
    <nav className="mc-altitude-rail" aria-label="Altitude">
      <div className="mc-rail-title">ALTITUDE</div>
      <ol className="mc-rail-stops">
        {ALTITUDE_LEVELS.map((level) => {
          const meta = ALTITUDE_META[level];
          const reach = stopReachability(level, selection, networkCount);
          const isFuture = reach === "future";
          const isCurrent = reach === "current";

          // The NETWORKS stop ascends to root; deeper interactive stops are
          // reached by drilling (the NETWORK stop's children). Only NETWORKS is
          // directly clickable as a stop in D2.
          const onClick =
            level === "networks" && !isCurrent ? onAscendRoot : undefined;

          return (
            <li
              key={level}
              className={
                "mc-rail-stop" +
                (isCurrent ? " mc-rail-stop--current" : "") +
                (isFuture ? " mc-rail-stop--future" : "")
              }
              data-level={level}
              data-reach={reach}
              aria-current={isCurrent ? "step" : undefined}
            >
              <button
                type="button"
                className="mc-rail-stop-btn"
                disabled={onClick === undefined}
                onClick={onClick}
                // A disabled future stub is removed from the tab order, so its
                // explanatory `title` is unreachable to AT — carry the same
                // information on an always-announced `aria-label` instead.
                aria-label={
                  isFuture
                    ? `${meta.label} — future level, arrives with the canvas re-skin`
                    : undefined
                }
                title={
                  isFuture
                    ? `${meta.label} — drill arrives with the canvas re-skin`
                    : undefined
                }
              >
                <span className="mc-rail-dot" aria-hidden="true" />
                <span className="mc-rail-stop-labels">
                  <span className="mc-rail-stop-label">{meta.label}</span>
                  {meta.altLabel && (
                    <span className="mc-rail-stop-alt">{meta.altLabel}</span>
                  )}
                </span>
              </button>

              {/* Drill targets under the NETWORK stop (the working drill). */}
              {level === "network" && networkCount > 0 && (
                <ul className="mc-rail-networks">
                  {networks.map((n) => {
                    const active =
                      selection.networkId === n.network_id;
                    const posture = networkPosture(n);
                    return (
                      <li key={n.network_id} className="mc-rail-network">
                        <button
                          type="button"
                          className={
                            "mc-rail-network-btn" +
                            (active ? " mc-rail-network-btn--active" : "")
                          }
                          data-network-id={n.network_id}
                          data-posture={posture}
                          aria-current={active ? "true" : undefined}
                          onClick={() => onDrillNetwork(n.network_id)}
                        >
                          <span className="mc-rail-network-name">
                            {n.network_id}
                          </span>
                          <span
                            className={`mc-rail-network-posture mc-rail-network-posture--${posture}`}
                          >
                            {posture}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mc-rail-dive" aria-hidden="true">
        ↓<br />
        DIVE
      </div>
    </nav>
  );
}
