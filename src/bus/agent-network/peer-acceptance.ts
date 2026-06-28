/**
 * MC-A2 (cortex#1276) — per-principal **acceptance** resolution for the MC
 * Network view.
 *
 * ## Two-layer trust (CONTEXT.md §"Joining a network")
 *
 * Membership is **two-layered**, and this module is the SECOND layer:
 *
 *   1. **Network membership** — the admin curates the roster (who is ADMITTED).
 *      That is the admission-rows layer (`admission-read.ts` / the live
 *      member-roster provider).
 *   2. **Per-principal acceptance** — even for an admitted peer, THIS principal
 *      independently chooses whom to accept. "Trust is **granted** (admission)
 *      *and* **chosen** (accept-policy), never *minted*."
 *
 * The acceptance choice is expressed by this stack's **capability offerings**
 * (`policy.offerings[]`, the CO-1 model): a federated offering names WHO may
 * dispatch it via its accept-policy —
 *   - `{kind:'network', network:<id>}`  → trust the WHOLE roster of `<id>`;
 *   - `{kind:'principals', principals}` → trust only the NAMED principals.
 * (The same `network:<id>` vs `principals:[…]` accept grammar CONTEXT.md §190
 * describes.) A peer this stack offers NOTHING federated to is **not accepted**
 * — default-deny: an admitted peer you don't accept can sit on the roster while
 * you dispatch it no work.
 *
 * This module distils the offerings ONCE into a {@link AcceptancePolicySummary}
 * and answers, per (network, member), the {@link PeerAcceptance} verdict. Pure:
 * no I/O, no bus, no config-load — the surface depends only on the result type.
 */

import type { Offering } from "../../common/types/offering";

/**
 * Whether — and HOW — this principal accepts a given peer (the second trust
 * layer). Distinct from the membership verdict (admitted/pending/anomaly).
 *
 *   - `self`             — the serving principal itself (always "accepted").
 *   - `accepted-network` — accepted because a federated offering trusts the
 *                          WHOLE roster of this network (`{kind:'network'}`).
 *   - `accepted-named`   — accepted because a federated offering names this
 *                          principal explicitly (`{kind:'principals'}`).
 *   - `not-accepted`     — no federated offering admits this peer (default-deny).
 */
export type PeerAcceptance =
  | "self"
  | "accepted-network"
  | "accepted-named"
  | "not-accepted";

/**
 * The distilled accept-policy of this stack's offerings — computed once, queried
 * per member.
 */
export interface AcceptancePolicySummary {
  /** Network ids this stack trusts WHOLE-ROSTER (a `{kind:'network'}` offering). */
  networkWide: ReadonlySet<string>;
  /** Principals named in any `{kind:'principals'}` federated offering. */
  namedPrincipals: ReadonlySet<string>;
}

/**
 * Distil `policy.offerings[]` into an {@link AcceptancePolicySummary}.
 *
 * Only the federated accept-policies matter for peer acceptance: `{kind:'network'}`
 * contributes its `network` to `networkWide`; `{kind:'principals'}` contributes
 * its names to `namedPrincipals`. Public (`{kind:'surface'}`) offerings admit
 * surface requesters (no bus identity), never bus peers, so they are ignored
 * here. `undefined`/empty offerings ⇒ accept nobody federated (default-deny).
 */
export function summarizeAcceptancePolicy(
  offerings: readonly Offering[] | undefined,
): AcceptancePolicySummary {
  const networkWide = new Set<string>();
  const namedPrincipals = new Set<string>();
  for (const o of offerings ?? []) {
    const accept = o.accept;
    if (accept === undefined) continue;
    if (accept.kind === "network") {
      networkWide.add(accept.network);
    } else if (accept.kind === "principals") {
      for (const p of accept.principals) namedPrincipals.add(p);
    }
    // `{kind:'surface'}` (public) admits surface requesters, not bus peers — skip.
  }
  return { networkWide, namedPrincipals };
}

/**
 * Resolve whether THIS principal accepts `memberPrincipal` on `networkId`.
 *
 * Precedence: self → whole-roster (network) → named principal → default-deny.
 * The serving principal is always `self`; a whole-roster offering for the
 * network accepts every member on it; otherwise an explicit name wins; else
 * `not-accepted`.
 *
 * Pure + total.
 */
export function resolvePeerAcceptance(
  summary: AcceptancePolicySummary,
  networkId: string,
  memberPrincipal: string,
  localPrincipal: string,
): PeerAcceptance {
  if (memberPrincipal === localPrincipal) return "self";
  if (summary.networkWide.has(networkId)) return "accepted-network";
  if (summary.namedPrincipals.has(memberPrincipal)) return "accepted-named";
  return "not-accepted";
}
