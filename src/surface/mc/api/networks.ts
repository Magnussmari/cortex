/**
 * MC-A1 (cortex#1275) — `GET /api/networks` (networks-as-first-class data source).
 *
 * Serves each JOINED network as a first-class **trust group** with its ADMITTED
 * roster, reconciled against observed presence into a per-member **membership
 * verdict**. This is the Network view's admission-layer feed, the sibling of the
 * transport-layer reconciliation MC already does (U2.3/U3.3 via signal).
 *
 * ## Source of truth = admission rows (ADR-0018 Q3), NOT the capability roster
 *
 * Membership is read from the **admission rows** via `resolveAdmittedRoster`
 * (`src/bus/agent-network/admission-read.ts`), keyed on `AdmissionStatus`. We
 * deliberately do NOT use the registry's `GET /networks/{id}/roster`
 * (`resolveNetworkRoster`, #1086): that route's `members[]` is still
 * **capability-derived** (registry `src/services/network-registry/src/types.ts`
 * `NetworkRoster`), and conflating capability with membership is the exact bug
 * ADR-0018 Q3 forbids. Capabilities never enter this handler.
 *
 * ## Authoritative vs self-scoped reads (registry-side Q3 prerequisite)
 *
 * Today a non-admin member can authoritatively read only its OWN admission rows
 * (member PoP read). The FULL admitted roster (admin-list) is admin-gated, and a
 * Q3-correct member-accessible *peer* roster read is a registry-side
 * prerequisite that has not yet landed. The admission read carries this through
 * as `roster.authoritative`: when the roster is NOT authoritative (a self-only
 * read), the handler SUPPRESSES anomaly detection — a present non-admitted
 * principal is not flagged `present-but-unadmitted`, because admission simply
 * isn't knowable from a self-only read (avoids a false-anomaly storm over
 * legitimately-admitted peers we can't yet enumerate).
 *
 * ## Dependency direction (surface must not import the bus)
 *
 * Like `/api/agents`, the server depends only on the minimal {@link NetworksView}
 * interface declared here; `cortex.ts` adapts the concrete admission-rows
 * provider + `policy.federated.networks` to it at boot. The MC surface imports
 * only the result TYPE from the admission-read lib (type-only), never the bus.
 *
 * ## Graceful, never-5xx
 *
 *   - `view === null` (no registry/federation) → `{networks:[]}`. "No networks"
 *     is the correct rendering, not an error.
 *   - admission read failure (unreachable / unauthorized / not_configured) → the
 *     network still renders (self-only membership, status surfaced). Never a 5xx.
 *
 * ## No signal dependency
 *
 * The CORE membership verdict is admission ⋈ presence only. Signal enriches the
 * TRANSPORT layer (the existing overlay), never membership; no signal import.
 */

import type { AgentPresenceView } from "./agents";
import type { ResolveAdmittedRosterResult } from "../../../bus/agent-network/admission-read";
import type { PeerAcceptance } from "../../../bus/agent-network/peer-acceptance";
import type {
  EncryptionMode,
  NetworkConfidentialityPosture,
} from "../../../common/crypto/network-encryption-policy";
import {
  reconcileNetworkMembership,
  derivePresentStacksByPrincipal,
  foreignPresentPrincipals,
  type MembershipVerdict,
} from "./networks-membership";

export type { MembershipVerdict } from "./networks-membership";
export type { PeerAcceptance } from "../../../bus/agent-network/peer-acceptance";

/** One joined network's static identity (from `policy.federated.networks[]`). */
export interface JoinedNetworkInfo {
  /** Network id (`policy.federated.networks[].id`). */
  networkId: string;
  /** The network's leaf-node connection id (`.leaf_node`). */
  leafNode: string;
  /**
   * MC-A3 (cortex#1277, ADR-0019/0018) — the network's TRUTHFUL confidentiality
   * posture, derived from config (`encryption` mode + `payload_key` presence +
   * `payload_key_id`). `cortex.ts` supplies it via `confidentialityPosture(n)`;
   * tests supply a stub. The handler maps it to the snake_case wire DTO.
   */
  confidentiality: NetworkConfidentialityPosture;
}

/**
 * The minimal read-only contract the MC server depends on to serve
 * `/api/networks`. `cortex.ts` supplies a live implementation built from
 * `policy.federated.{networks,registry}` + the admission-rows provider; tests
 * supply a stub. The surface layer never imports the bus.
 */
export interface NetworksView {
  /** The serving (local) principal — itself an admitted member of each joined network. */
  localPrincipal: string;
  /** The joined networks (config order). */
  networks(): JoinedNetworkInfo[];
  /**
   * Resolve a network's ADMITTED/PENDING roster from the **admission rows**
   * (ADR-0018 Q3). Wraps `resolveAdmittedRoster` — never throws.
   */
  resolveAdmittedRoster(networkId: string): Promise<ResolveAdmittedRosterResult>;
  /**
   * MC-A2 (cortex#1276) — the SECOND trust layer: does THIS principal *accept*
   * `memberPrincipal` on `networkId`? Derived from `policy.offerings[]`
   * accept-policy (`network:<id>` = whole roster, `principals:[…]` = named).
   * Synchronous + pure (a distilled summary queried per member). OPTIONAL: a
   * view that omits it (older wiring / a test stub) leaves acceptance at the
   * handler default — `self` for the serving principal, `not-accepted`
   * otherwise (default-deny). `cortex.ts` supplies the live resolver.
   */
  acceptsPeer?(networkId: string, memberPrincipal: string): PeerAcceptance;
}

/** Provenance/availability of a network's admission-rows read. */
export type RosterStatus =
  | "ok" // rows read (see `roster_scope` for complete vs self)
  | "unreachable" // registry unreachable
  | "unauthorized" // caller not authorized for this read
  | "not_configured"; // no registry / admission read configured

/** Whether the roster reflects the COMPLETE network or only the serving stack's row. */
export type RosterScope = "complete" | "self";

/** ADR-0019 per-network encryption mode, mirrored from config (wire DTO). */
export type { EncryptionMode };

/**
 * MC-A3 (cortex#1277) — a network's confidentiality posture, snake_case for the
 * `/api/networks` wire DTO. `mode` and `key_present` are reported INDEPENDENTLY:
 * a network configured `enabled`/`required` with `key_present: false` is NOT
 * actually sealing (cleartext-with-warning, ADR-0019 §5) and must never be badged
 * "encrypted". The wire-side mirror of {@link NetworkConfidentialityPosture}.
 *
 * **Consumer contract:** a consumer MUST combine `mode` AND `key_present` to
 * judge whether traffic is actually sealed — `mode` alone over-claims (a
 * keyless `enabled`/`required` network publishes cleartext). The canonical
 * derivation is `confidentialityBadge` in `network-membership-adapter.ts`; new
 * consumers should reuse it rather than re-deriving from `mode`.
 */
export interface NetworkConfidentialityDTO {
  /** Configured mode (default `off`). */
  mode: EncryptionMode;
  /** Whether the per-network key `K` is actually held (the honesty hinge). */
  key_present: boolean;
  /** Active key-id / rotation epoch when a key is held; else `null`. */
  key_id: string | null;
}

/** One reconciled roster member, snake_case for the DTO. */
export interface MembershipMemberDTO {
  principal: string;
  verdict: MembershipVerdict;
  present_stacks: string[];
  /**
   * MC-A2 (cortex#1276) — the SECOND trust layer: does THIS principal accept
   * this member? `self` for the serving principal; `accepted-network` (whole
   * roster trusted) / `accepted-named` (named in an offering) when accepted;
   * `not-accepted` under default-deny. Membership (`verdict`) is admission;
   * acceptance is THIS stack's independent accept-policy choice — orthogonal.
   */
  accepts: PeerAcceptance;
}

/** One network's membership view in the `GET /api/networks` response. */
export interface NetworkMembershipDTO {
  network_id: string;
  leaf_node: string;
  /** Availability of the admission-rows read this membership was reconciled against. */
  roster_status: RosterStatus;
  /**
   * `complete` (admin-authoritative roster) vs `self` (only the serving stack's
   * own admission row is known — peer membership not yet enumerable; anomaly
   * detection suppressed). `null` when the read failed.
   */
  roster_scope: RosterScope | null;
  /**
   * MC-A3 (cortex#1277, ADR-0019/0018) — the network's read-only confidentiality
   * posture. Always present; the surface badges it honestly (never fakes
   * "encrypted" for a configured-but-keyless network).
   */
  confidentiality: NetworkConfidentialityDTO;
  /** Admitted roster reconciled ⋈ presence into per-member verdicts. */
  members: MembershipMemberDTO[];
}

/** `GET /api/networks` response body. */
export interface ListNetworksResponse {
  networks: NetworkMembershipDTO[];
}

/** Map a `resolveAdmittedRoster` failure to a {@link RosterStatus}. */
function failureStatus(
  reason: "unreachable" | "unauthorized" | "not_configured",
): RosterStatus {
  return reason;
}

/**
 * Handle `GET /api/networks`.
 *
 * `view === null` → empty list (no federation / no registry — graceful). Else,
 * for each joined network: resolve its admitted roster from the admission rows,
 * inject the serving principal (a joined stack is itself a member), reconcile
 * against presence, and — ONLY for authoritative (complete) rosters — attach
 * federation-wide anomalies (foreign principals present but admitted to NONE of
 * the joined networks' COMPLETE rosters).
 *
 * Async because the admission read is async.
 */
export async function handleListNetworks(
  view: NetworksView | null,
  presence: AgentPresenceView | null,
): Promise<Response> {
  try {
    if (view === null) {
      return Response.json({ networks: [] } satisfies ListNetworksResponse);
    }

    const records = presence ? presence.getAgents() : [];
    const presentStacksByPrincipal = derivePresentStacksByPrincipal(
      records,
      view.localPrincipal,
    );

    const joined = view.networks();

    // Resolve every roster first so the anomaly candidates can be computed
    // against the union of admitted principals across all AUTHORITATIVE networks
    // (a self-only read contributes no completeness, so it can't authorize an
    // anomaly verdict).
    const resolved = await Promise.all(
      joined.map(async (n) => ({
        info: n,
        // The `resolveAdmittedRoster` contract is never-throw, but A2's live
        // provider carries transport + crypto: enforce the never-5xx guarantee
        // STRUCTURALLY here so a stray rejection degrades to "unreachable"
        // (the network still renders self-only) rather than rejecting the
        // Promise.all and falling through to the 500 path.
        result: await view.resolveAdmittedRoster(n.networkId).catch(
          (err: unknown): ResolveAdmittedRosterResult => ({
            ok: false,
            reason: "unreachable",
            detail: `admission read threw: ${err instanceof Error ? err.message : String(err)}`,
          }),
        ),
      })),
    );

    // Anomaly candidates only make sense when SOME network gave an authoritative
    // (complete) roster — otherwise we can't tell unadmitted from unknowable.
    const anyAuthoritative = resolved.some(
      (r) => r.result.ok && r.result.roster.authoritative,
    );
    const unionAdmitted = new Set<string>([view.localPrincipal]);
    for (const { result } of resolved) {
      if (result.ok && result.roster.authoritative) {
        for (const p of result.roster.admitted) unionAdmitted.add(p);
      }
    }
    const globalAnomalies = anyAuthoritative
      ? foreignPresentPrincipals(presentStacksByPrincipal, view.localPrincipal).filter(
          (p) => !unionAdmitted.has(p),
        )
      : [];

    const networks: NetworkMembershipDTO[] = resolved.map(({ info, result }) => {
      // The serving principal is always an admitted member of a network it has
      // joined.
      const admitted = [view.localPrincipal];
      let pending: string[] = [];
      let rosterStatus: RosterStatus;
      let rosterScope: RosterScope | null;

      if (result.ok) {
        for (const p of result.roster.admitted) admitted.push(p);
        pending = result.roster.pending.filter((p) => p !== view.localPrincipal);
        rosterScope = result.roster.authoritative ? "complete" : "self";
        rosterStatus = "ok";
      } else {
        rosterStatus = failureStatus(result.reason);
        rosterScope = null;
      }

      // Attach anomalies ONLY for an authoritative roster — a self-scoped or
      // failed read cannot prove a present peer is unadmitted.
      const authoritative = result.ok && result.roster.authoritative;
      const members = reconcileNetworkMembership({
        admitted,
        presentStacksByPrincipal,
        pending,
        ...(authoritative ? { anomalyCandidates: globalAnomalies } : {}),
      });

      return {
        network_id: info.networkId,
        leaf_node: info.leafNode,
        roster_status: rosterStatus,
        roster_scope: rosterScope,
        // MC-A3 — carry the config-derived confidentiality posture through to the
        // wire DTO (camelCase posture → snake_case DTO). Read-only; the surface
        // badges it honestly. Independent of the roster read above.
        confidentiality: {
          mode: info.confidentiality.mode,
          key_present: info.confidentiality.keyPresent,
          key_id: info.confidentiality.keyId,
        },
        members: members.map((m) => ({
          principal: m.principal,
          verdict: m.verdict,
          present_stacks: m.presentStacks,
          // MC-A2 — the SECOND trust layer (acceptance), orthogonal to the
          // membership verdict above. The view supplies the live resolver; when
          // it's absent (older wiring / test stub) we default-deny honestly
          // (self for the serving principal, not-accepted otherwise).
          accepts:
            view.acceptsPeer !== undefined
              ? view.acceptsPeer(info.networkId, m.principal)
              : m.principal === view.localPrincipal
                ? "self"
                : "not-accepted",
        })),
      };
    });

    return Response.json({ networks } satisfies ListNetworksResponse);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/networks failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return Response.json(
      {
        error: `Failed to list networks: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
