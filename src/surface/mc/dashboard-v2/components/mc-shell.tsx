/**
 * MC-D2 (cortex#1289) — the constellation skin's **shell chrome** composer.
 *
 * Frames the MC Network view with the command bar (top) + altitude rail (left),
 * with the existing view body as `children` in the content area. The whole shell
 * — chrome AND the pane it frames — is wrapped in a single `.mc-skin` container
 * so D1's OKLCH tokens + JetBrains/Inter fonts apply here and ONLY here: this is
 * how the skin adopts pane-by-pane, with zero blast radius on the dashboard's
 * other tabs (which never carry `.mc-skin`).
 *
 * Additive + non-regressive: the existing Network body renders unchanged as
 * `children`; the chrome mounts around it. D3 re-skins the canvas itself next.
 *
 * The selection state is owned by the caller (the Network view) and threaded in;
 * this component is presentation + a thin click→selection mapping over the pure
 * `mc-shell-model`.
 */

import type { ReactNode } from "react";
import { McCommandBar } from "./mc-command-bar";
import { McAltitudeRail } from "./mc-altitude-rail";
import {
  buildBreadcrumb,
  drillToNetwork,
  navigateToSegment,
  ascendToRoot,
  selectedNetworkPosture,
  type AltitudeSelection,
} from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import "./mc-shell.css";

export interface McShellProps {
  /** The serving (local) principal; `null` until a local agent is observed. */
  principal: string | null;
  /** Joined networks (drives the breadcrumb, posture, count, and drill list). */
  networks: readonly NetworkMembershipDTO[];
  /** The current you-are-here selection (owned by the caller). */
  selection: AltitudeSelection;
  /** Report a new selection from a chrome navigation gesture. */
  onSelectionChange: (next: AltitudeSelection) => void;
  /** The framed pane (the existing Network view body). */
  children: ReactNode;
}

export function McShell({
  principal,
  networks,
  selection,
  onSelectionChange,
  children,
}: McShellProps) {
  const breadcrumb = buildBreadcrumb(selection);
  const posture = selectedNetworkPosture(networks, selection);

  return (
    <div className="mc-skin mc-shell">
      <McCommandBar
        principal={principal}
        breadcrumb={breadcrumb}
        posture={posture}
        networkCount={networks.length}
        onNavigate={(seg) => onSelectionChange(navigateToSegment(seg))}
      />
      <div className="mc-shell-body">
        <McAltitudeRail
          selection={selection}
          networks={networks}
          onAscendRoot={() => onSelectionChange(ascendToRoot())}
          onDrillNetwork={(id) => onSelectionChange(drillToNetwork(id))}
        />
        <div className="mc-shell-content">{children}</div>
      </div>
    </div>
  );
}
