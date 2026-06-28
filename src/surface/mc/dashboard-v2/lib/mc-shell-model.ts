/**
 * MC-D2 (cortex#1289) — pure model for the constellation skin's **shell chrome**:
 * the command-bar breadcrumb + posture, and the altitude-rail selection.
 *
 * The shell chrome is navigation scaffolding for the MC Network view. This module
 * owns the small amount of LOGIC behind it — altitude levels, the you-are-here
 * selection, the breadcrumb derivation, and per-network posture — so the React
 * components stay thin and the behaviour is unit-testable without a DOM.
 *
 * ## Posture term = admin / member (the deprecated label is forbidden)
 *
 * Posture is the stance a principal holds toward a *given* network — **admin**
 * (you govern it: own the hub + admission gate, hold the roster) or **member**
 * (an admitted sovereign peer). It is **per-network, not global** (CONTEXT.md
 * §"Network posture (admin vs member)"). The constellation mockup's legacy
 * on-screen label is renamed to **admin** here; the deprecated network-posture
 * word is reserved for the MC authorization-role tier + the NSC account-tree
 * root, never the network posture (CONTEXT.md).
 *
 * Admin posture is derived exactly as the Pier queue derives it (MC-B1): a
 * network is admin-posture iff its admin-authoritative (`complete`) admission-rows
 * read succeeded. We reuse `isAdminPosture` so the two surfaces can never drift.
 *
 * ## D2 scope — networks ↔ network works; deeper levels are scaffolding
 *
 * The altitude rail names five levels (NETWORKS → NETWORK → STACK → ASSISTANT →
 * SESSION). D2 wires the top two against real data (drill into a joined network,
 * ascend to the 10k-ft root); STACK/ASSISTANT/SESSION are honest `future` stubs
 * D3+ will deepen as it re-skins the canvas. No fabricated drill state.
 *
 * ## Sovereignty boundary — SESSION granularity is LOCAL-ONLY (extends ADR-0005)
 *
 * The SESSION level applies ONLY to the principal's OWN (local) stacks. Across
 * the federation boundary a peer principal's stacks expose AGGREGATED metadata at
 * best (presence, capability catalog, health, counts like "N active sessions") —
 * never individual sessions or interiors. So for a federated peer the deepest
 * reachable level is STACK/ASSISTANT (aggregate); SESSION is unreachable by
 * construction. The boundary is a feature, not a gap. D2 keeps STACK/ASSISTANT/
 * SESSION as inert `future` stubs (no peer-session drill is implied); the real
 * drill-depth enforcement lands in D3/D4, which MUST honour this rule. When D3+
 * adds the federated-vs-local coordinate to the selection, gate SESSION on it.
 */

import type { NetworkMembershipDTO } from "../hooks/use-networks";
import { isAdminPosture } from "./pier-queue-adapter";

/** The five altitude levels — the primary navigation gesture (10k ft → session). */
export type AltitudeLevel =
  | "networks"
  | "network"
  | "stack"
  | "assistant"
  | "session";

/** Ordered altitude levels, highest (10k ft) → deepest. */
export const ALTITUDE_LEVELS: readonly AltitudeLevel[] = [
  "networks",
  "network",
  "stack",
  "assistant",
  "session",
] as const;

/** Display metadata for one altitude rail stop. */
export interface AltitudeStopMeta {
  level: AltitudeLevel;
  /** Mono, uppercase label rendered on the rail. */
  label: string;
  /** Optional altitude annotation (only the 10k-ft NETWORKS root carries one). */
  altLabel?: string;
}

/** Per-level display metadata (label + the NETWORKS altitude annotation). */
export const ALTITUDE_META: Record<AltitudeLevel, AltitudeStopMeta> = {
  networks: { level: "networks", label: "NETWORKS", altLabel: "10k ft" },
  network: { level: "network", label: "NETWORK" },
  stack: { level: "stack", label: "STACK" },
  assistant: { level: "assistant", label: "ASSISTANT" },
  session: { level: "session", label: "SESSION" },
};

/**
 * The current you-are-here selection. D2 wires `networks` ↔ `network`; the
 * deeper levels carry no extra coordinates yet (D3+ adds stack/assistant/session
 * ids as it deepens the drill).
 */
export interface AltitudeSelection {
  level: AltitudeLevel;
  /** The drilled-into network id, or `null` at the networks (10k-ft) root. */
  networkId: string | null;
}

/** The 10k-ft root — the networks level with no network selected. */
export const ROOT_SELECTION: AltitudeSelection = {
  level: "networks",
  networkId: null,
};

/** Network posture toward a given network — per-network, never global. */
export type NetworkPosture = "admin" | "member";

/**
 * Per-network posture: `admin` iff the admin-authoritative (`complete`) admission
 * roster read succeeded (reuses MC-B1's `isAdminPosture`, so the Pier queue and
 * the command-bar pill can never disagree). Every other read scope/status is
 * `member` — fail-closed: we never claim admin authority we can't prove.
 */
export function networkPosture(net: NetworkMembershipDTO): NetworkPosture {
  return isAdminPosture(net) ? "admin" : "member";
}

/**
 * The posture of the currently-selected network, or `null` at the root.
 *
 * Posture is per-network, so at the 10k-ft networks root (no single network
 * selected) there is no single posture to report — `null` (the command bar then
 * shows no pill, an honest placeholder, rather than fabricating one). When a
 * selected network id is no longer in the data (it dropped out), also `null`.
 */
export function selectedNetworkPosture(
  networks: readonly NetworkMembershipDTO[],
  selection: AltitudeSelection,
): NetworkPosture | null {
  if (selection.networkId === null) return null;
  const net = networks.find((n) => n.network_id === selection.networkId);
  return net ? networkPosture(net) : null;
}

/** One you-are-here breadcrumb segment (clickable to navigate back to it). */
export interface BreadcrumbSegment {
  /** The text shown for this segment. */
  label: string;
  /** The altitude level this segment navigates to when clicked. */
  level: AltitudeLevel;
  /** The network this segment scopes to (`null` for the root segment). */
  networkId: string | null;
}

/**
 * Build the you-are-here breadcrumb from the current selection. The root
 * (`NETWORK·OF·NETWORKS`) is always present; a drilled-into network appends a
 * second segment. Deeper levels append further segments in D3+.
 */
export function buildBreadcrumb(
  selection: AltitudeSelection,
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [
    { label: "NETWORK·OF·NETWORKS", level: "networks", networkId: null },
  ];
  if (selection.networkId !== null) {
    segments.push({
      label: selection.networkId,
      level: "network",
      networkId: selection.networkId,
    });
  }
  return segments;
}

/** Drill into a specific network (networks → network). */
export function drillToNetwork(networkId: string): AltitudeSelection {
  return { level: "network", networkId };
}

/** Ascend back to the 10k-ft networks root. */
export function ascendToRoot(): AltitudeSelection {
  return ROOT_SELECTION;
}

/**
 * Resolve a breadcrumb-segment click into the next selection. The root segment
 * ascends to the 10k-ft view; a network segment re-selects that network.
 */
export function navigateToSegment(
  segment: BreadcrumbSegment,
): AltitudeSelection {
  if (segment.networkId === null) return ascendToRoot();
  return drillToNetwork(segment.networkId);
}

/** Reachability of a rail stop for the current data + selection. */
export type StopReachability = "current" | "reachable" | "future";

/**
 * Classify a rail stop:
 *   - `current`   — the active level (lit on the rail);
 *   - `reachable` — navigable now with the data on hand;
 *   - `future`    — a deeper level D3+ will wire (a disabled stub today).
 *
 * `networks` is always reachable (the root you can always return to). `network`
 * is reachable iff ≥1 network is joined (otherwise there is nothing to drill
 * into — an honest `future` stub). `stack`/`assistant`/`session` are `future` in
 * D2 regardless of data.
 *
 * Forward rule for D3/D4 (the sovereignty boundary above): `session` is
 * reachable ONLY in a local/own-stack context. For a federated peer the deepest
 * reachable level is `stack`/`assistant` (aggregate) — `session` stays `future`
 * there by construction. D2 reaches none of these three, so it cannot
 * contradict the rule; D3/D4 must enforce it when they wire the deep drill.
 */
export function stopReachability(
  level: AltitudeLevel,
  selection: AltitudeSelection,
  networkCount: number,
): StopReachability {
  if (level === selection.level) return "current";
  if (level === "networks") return "reachable";
  if (level === "network") return networkCount > 0 ? "reachable" : "future";
  return "future";
}
