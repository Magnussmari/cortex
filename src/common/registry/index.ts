/**
 * Cortex-side network-registry consumers.
 *
 * Public surface for the rest of cortex. Two consumers live here:
 *
 *   - `RegistryClient` (Phase D.4.3) — boot-time, fixed-peer-list polling
 *     cache; consume the reader interface unless wiring lifecycle
 *     (cortex.ts boot/shutdown only).
 *   - `PrincipalPubkeyResolver` (TC-2a, cortex#633) — on-demand,
 *     posture-gated peer-pubkey resolver for the federation crypto-verify
 *     chain (TC-2b/TC-2d). Default-OFF; inert unless `signing: enforce`.
 */

export { RegistryClient } from "./client";
export {
  PrincipalPubkeyResolver,
  resolvePrincipalPubkey,
} from "./resolve-pubkey";
export type {
  PrincipalPubkeyResolverOptions,
  ResolveResult,
} from "./resolve-pubkey";
export type {
  Capability,
  PrincipalRecord,
  RegistryClientOptions,
  RegistryClientReader,
  RegistryPubkeyResponse,
  SignedAssertion,
  StackIdentity,
} from "./types";
