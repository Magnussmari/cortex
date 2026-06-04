/**
 * G-1100.B / IAW Phase A.2/A.5: Myelin envelope validator.
 *
 * Validates inbound envelopes against the vendored myelin schema. The
 * schema is copied verbatim from `~/Developer/myelin/schemas/envelope.schema.json`
 * pinned at commit b69c877 (myelin main, post-myelin#113 namespace `{stack}`
 * grammar + myelin#115 shared subjects-derivation surface, on top of the
 * 4578ae1 baseline — F-021 task envelope + MY-400 chain-of-stamps + F-15
 * economics + F-5 sovereignty + F-10 bidding + F-11 capability discovery +
 * F-019/F-020 task subjects).
 *
 * Per docs/design-collaboration-surface.md §9 coupling rules (as refreshed
 * in this PR), the *schema* travels with cortex by value — never imported
 * at runtime — so a myelin outage cannot wedge cortex's validator. The
 * pure-string subject-grammar primitives at `@the-metafactory/myelin/subjects`
 * (myelin#115) carry zero transitive dependencies (no envelope schema, no
 * Ajv, no NATS) and were explicitly designed for ecosystem consumers like
 * cortex to import — §9 now permits this category of import. As a result
 * `deriveNatsSubject` and `validateSubjectEnvelopeAlignment` are thin
 * shims over those primitives instead of cortex-side ports, closing the
 * grammar-extension fan-out problem (every consumer re-porting on each
 * spec bump) at the source. Behavior-pinning tests in
 * `__tests__/envelope-validator.test.ts` lock cortex's expected alignment
 * semantics so any future myelin behavior drift (case-folding, partial
 * matching, etc.) fails fast at vendor-bump time.
 *
 * To upgrade the schema: copy the file, update the `SCHEMA_SOURCE_COMMIT`
 * constant, bump the `@the-metafactory/myelin` pin in package.json to match,
 * extend the vendored types below, run the tests, ship a PR. There is no
 * auto-sync.
 *
 * **IAW Phase A.5 bump (from commit 4578ae1 → b69c877):**
 *
 * - Schema unchanged on the wire — myelin#113/#115 added subject-grammar
 *   surface area without altering envelope JSON Schema.
 * - `deriveNatsSubject(envelope, stack?)` now accepts an optional `stack`
 *   segment, emitting the 6-segment `{prefix}.{principal}.{stack}.{type}` form
 *   when supplied (myelin#113 — IAW Phase A.5). Omitting `stack` preserves
 *   the legacy 5-segment shape; subscribers default-derive missing stack
 *   to `default` per `specs/namespace.md` § Backward compatibility.
 * - Cortex's previous IAW A.3 ports of `deriveNatsSubject` and
 *   `validateSubjectEnvelopeAlignment` (5-segment only) are deleted in
 *   favour of shims around `@the-metafactory/myelin/subjects`.
 *
 * **IAW Phase A.2 baseline (96b14ea → 4578ae1):**
 *
 *   - `signed_by` accepts a single stamp OR a chain (`SignedBy[]`) per
 *     myelin#31. `getSignedByChain()` normalises both shapes into an array.
 *   - `requirements`, `sovereignty_required`, `deadline`,
 *     `distribution_mode`, `target_assistant` per F-021 (the field was
 *     `target_principal` at the A.2 baseline; renamed R13 / myelin#184).
 *   - `economics` upgraded to F-15 typed shape (`budget` / `actual` /
 *     `wallet` / `billing_ref` / `currency`), still optional and not
 *     security-bearing per myelin architecture.md §5.2.
 *   - Stamps may carry an optional semantic `role` (`origin` / `transit` /
 *     `accountability` / `sovereignty` / `notary`) per myelin#31.
 */

// The myelin schema declares draft 2020-12 ($schema), so use Ajv's
// 2020-12 build rather than the default draft-07 entry point.
import Ajv2020, { type ValidateFunction, type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  deriveSubject,
  subjectPrefixAligns,
} from "@the-metafactory/myelin/subjects";
import schema from "./vendor/envelope.schema.json" with { type: "json" };

/**
 * Pin so future maintainers know which myelin commit the schema was lifted from.
 *
 * Upstream issue/PR numbering note: myelin#160 is the design issue for the
 * envelope `originator` field; myelin#161 is the merged PR. The vendored
 * schema's description string preserves the `myelin#160:` reference
 * verbatim (faithful vendoring of upstream wording); all cortex code +
 * comments + tests use `myelin#161` to point at the merge that landed the
 * feature — they're the same change, different ticket facets.
 */
export const SCHEMA_SOURCE_COMMIT = "f5ec8658030e2fc185f123b06d8bf94d9f74cd84";

/**
 * Hand-typed Envelope shape matching the JSON Schema. We hand-write rather
 * than codegen because (a) the schema is small and stable, (b) the manual
 * type doubles as documentation for callers, (c) avoiding a build step keeps
 * the import-safe / zero-side-effect property of this module.
 */
export interface Envelope {
  /** UUID v4 — unique per envelope. */
  id: string;
  /** `{principal}.{stack}.{assistant}` — exactly 3 dotted segments (myelin#185 breaking cut). */
  source: string;
  /** `domain.entity.action` — what kind of signal this is. */
  type: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** UUID v4 — links related envelopes across a workflow. Optional. */
  correlation_id?: string;
  /** The message's passport. Sovereignty travels with the envelope. */
  sovereignty: {
    classification: "local" | "federated" | "public";
    /** ISO 3166-1 alpha-2 country code (e.g. "NZ", "DE"). */
    data_residency: string;
    /** Maximum number of hops the envelope may traverse. ≥ 0. */
    max_hop: number;
    /** Whether the envelope's payload may be processed by frontier models. */
    frontier_ok: boolean;
    /** Constraint on which model class may process the payload. */
    model_class: "local-only" | "frontier" | "any";
  };
  /**
   * F-15 economics block — token budget, actual usage, billing attribution.
   * Mutable annotation field; intermediaries may aggregate. Per myelin
   * `architecture.md` §5.2 this field MUST NOT inform security or trust
   * decisions — surface it for observability and cost accounting only.
   */
  economics?: Economics;
  /** Forward-compatible metadata. Optional. */
  extensions?: Record<string, unknown>;
  /** Arbitrary signal content. */
  payload: Record<string, unknown>;
  /**
   * Identity attestation — proves who sent this envelope. Optional in the
   * schema (envelopes predate MY-400 identity layer).
   *
   * **Wire shapes accepted (myelin#31 chain-of-stamps):**
   *   - Single stamp object (legacy back-compat shim, single signer).
   *   - Array of stamps (canonical post-#31 chain form). Each stamp signs
   *     the canonical bytes of the envelope *including the prior chain* —
   *     tampering with any earlier stamp invalidates every subsequent
   *     stamp's signature.
   *
   * Cortex callers that want a uniform view should use
   * {@link getSignedByChain} to normalise both shapes to `SignedBy[]`.
   *
   * IAW Phase A.2: `signed_by` is **surfaced but not yet consumed for
   * trust decisions** — that wiring lands in IAW Phase B (cortex#102).
   */
  signed_by?: SignedBy | SignedBy[];
  /**
   * F-021 — capability tags the task needs. Matched against AGENT_CAPABILITIES
   * (myelin#11). Empty array = no filter. Pattern parallels DID_RE: no
   * trailing or consecutive hyphens.
   */
  requirements?: string[];
  /**
   * F-021 — minimum agent sovereignty mode required to ack the task.
   *
   * | mode | semantics |
   * |---|---|
   * | `open` | ack all |
   * | `selective` | evaluate-and-may-nak |
   * | `strict` | explicit capability + sovereignty match |
   * | `bidding` | F-10 broadcast bid-request, collect signed responses, select winner |
   */
  sovereignty_required?: SovereigntyRequirement;
  /** F-021 — ISO-8601 absolute soft deadline. Informs nak `not-now` decisions. */
  deadline?: string;
  /**
   * F-021 — principal-facing routing semantics. Vocabulary migration
   * 2026-05 R11 renamed `broadcast` → `offer` on the wire; the transition
   * schema accepts both. New publishers emit `offer`.
   *
   * | mode | semantics |
   * |---|---|
   * | `offer` | competing consumers — first ack wins (R11 canonical) |
   * | `broadcast` | deprecated alias of `offer` (accepted on read) |
   * | `direct` | named recipient — requires `target_assistant` |
   * | `delegate` | outcome handoff (multi-step orchestration) — requires `target_assistant` |
   */
  distribution_mode?: DistributionMode;
  /**
   * F-021 — required when `distribution_mode` is `direct` or `delegate`.
   * DID of the receiving assistant (`did:mf:<name>`). Vocabulary migration
   * 2026-05 R13 (breaking cut myelin#184) renamed from `target_principal`;
   * the deprecated key was dropped from the wire — envelopes carrying it
   * are rejected by the schema. Resolve via {@link getTargetAssistant}.
   */
  target_assistant?: string;
  /**
   * myelin#161 — policy-level actor identity, separate from the
   * cryptographic `signed_by[]` chain. The chain proves WHO signed; the
   * originator names WHO the signer claims to be acting on behalf of.
   *
   * `originator` IS covered by the envelope signature (a signable field —
   * see myelin canonicalize SIGNABLE_FIELDS). Tampering with `originator`
   * invalidates every subsequent stamp.
   *
   * Cortex callers should resolve the policy actor via the upstream
   * `getActorPrincipal(envelope)` helper rather than reading this field
   * directly — that helper falls back to `signed_by[0].identity` for
   * legacy envelopes that pre-date myelin#161.
   */
  originator?: Originator;
}

/**
 * myelin#161 — policy-attribution claim that travels next to the
 * `signed_by[]` chain. The signer commits to the attribution claim by
 * including the field in the canonical signature input.
 */
export interface Originator {
  /**
   * DID of the actor whose capabilities this envelope asserts.
   * Vocabulary migration 2026-05 R2 — canonical key is `identity`;
   * the transition schema accepts `principal` too. Readers should use
   * {@link getActorPrincipal} which dual-reads.
   */
  identity?: string;
  /**
   * @deprecated Renamed to `identity` (vocabulary migration 2026-05, R2).
   * Pre-migration envelopes carry this key; accepted on read through the
   * transition window. Removed in the breaking major.
   */
  principal?: string;
  /**
   * How the signer learned the originator identity:
   *   - `adapter-resolved` — adapter (Discord/Slack/Mattermost/HTTP/cc-events)
   *     mapped a non-myelin identifier (platform id, OS user) to a myelin
   *     principal at sign time.
   *   - `federated` — the originator claim was relayed from another
   *     principal; the chain proves the cross-principal hop.
   *   - `delegated` — the signer holds delegation credentials for the
   *     originator (service principal acting on behalf of a principal).
   */
  attribution: AttributionMode;
}

/** myelin#161 — see {@link Originator}. */
export type AttributionMode = "adapter-resolved" | "federated" | "delegated";

/**
 * Discriminated stamp shape — one entry in an envelope's `signed_by` chain.
 * `method` selects which fields are present:
 *   - `"ed25519"` — bare per-bot signature; intra-org trust.
 *   - `"hub-stamp"` — federation hub re-signature for cross-org trust.
 *
 * Optional `role` (myelin#31) is the semantic position of the stamp in the
 * chain (`origin` / `transit` / `accountability` / `sovereignty` / `notary`).
 * Consumers that need role-aware predicates MUST handle the undefined case
 * — pre-#31 stamps and the legacy shim do not carry a role.
 */
export type SignedBy = SignedByEd25519 | SignedByHubStamp;

/**
 * Bare ed25519 signature — the principal signs the envelope directly.
 * Used for intra-org traffic where every bot's `did:mf:*` principal is
 * trusted and key material is held locally.
 */
export interface SignedByEd25519 {
  method: "ed25519";
  /**
   * Stamp DID — `did:mf:<name>` per myelin convention. Vocabulary
   * migration 2026-05 R2 (breaking cut myelin#182): canonical key is
   * `identity`; the deprecated `principal` key was dropped from the wire
   * — stamps carrying it are rejected by the schema.
   */
  identity?: string;
  /** Base64-encoded ed25519 signature (88+ chars). */
  signature: string;
  /** ISO-8601 timestamp the signature was produced. */
  at: string;
  /** Optional semantic role of this stamp in the chain (myelin#31). */
  role?: StampRole;
}

/**
 * Hub-stamped signature — a federation hub re-signs after verifying the
 * principal's bare signature. Used for cross-org traffic where the
 * receiver trusts the hub but not necessarily the originating bot.
 */
export interface SignedByHubStamp {
  method: "hub-stamp";
  /**
   * Originating identity — `did:mf:<name>`. Vocabulary migration 2026-05
   * R2 (breaking cut myelin#182): canonical key is `identity`; the
   * deprecated `principal` key was dropped from the wire — stamps
   * carrying it are rejected by the schema.
   */
  identity?: string;
  /** Hub identity that re-signed — `did:mf:<hub-name>`. */
  stamped_by: string;
  /** Base64-encoded ed25519 signature from the hub. */
  signature: string;
  /** ISO-8601 timestamp the hub signed. */
  at: string;
  /** Optional semantic role of this stamp in the chain (myelin#31). */
  role?: StampRole;
}

/**
 * Semantic position of a stamp inside a chain (myelin#31). Roles describe
 * what the stamp ATTESTS, not what the principal IS. Optional for
 * back-compat — pre-#31 stamps do not carry a role.
 */
export type StampRole =
  | "origin"
  | "transit"
  | "accountability"
  | "sovereignty"
  | "notary";

/**
 * F-021 — `sovereignty_required` enum. Determines how aggressively
 * candidates may decline a task before nakking.
 */
export type SovereigntyRequirement =
  | "open"
  | "selective"
  | "strict"
  | "bidding";

/**
 * F-021 — `distribution_mode` enum. Vocabulary migration 2026-05 R11
 * renamed `broadcast` → `offer` on the wire; the transition schema
 * accepts both. Emitters publish `offer`; readers tolerate `broadcast`
 * for JetStream replay of pre-migration envelopes.
 */
export type DistributionMode = "broadcast" | "offer" | "direct" | "delegate";

/**
 * F-15 economics — token budget, actual usage, billing attribution.
 *
 * Per myelin `architecture.md` §5.2, this is a **mutable annotation field**
 * sitting intentionally outside the L4 signature so intermediaries can
 * accumulate cost without invalidating attestations. It MUST NOT inform
 * security or trust decisions — surface it for observability only.
 */
export interface Economics {
  /** Publisher-set constraints on resource usage. */
  budget?: EconomicsBudget;
  /** Actual usage populated by executor; aggregated by hubs in delegate chains. */
  actual?: EconomicsActual;
  /** DID of principal receiving/paying for this work. */
  wallet?: string;
  /** External invoice or tracking reference. */
  billing_ref?: string;
  /** ISO 4217 currency code when not USD. */
  currency?: string;
  /** Forward-compatible — schema allows additional properties. */
  [key: string]: unknown;
}

export interface EconomicsBudget {
  /** Maximum total tokens (input + output) permitted. */
  max_tokens?: number;
  /** Maximum cost in USD. */
  max_cost_usd?: number;
  [key: string]: unknown;
}

export interface EconomicsActual {
  /** LLM input tokens consumed. */
  input_tokens?: number;
  /** LLM output tokens generated. */
  output_tokens?: number;
  /** Convenience total — may equal input + output, may not (delegate aggregation). */
  total_tokens?: number;
  /** Lowercase model identifier (e.g. `claude-sonnet-4`, `gpt-4o`). */
  model?: string;
  /** Execution duration in milliseconds. */
  duration_ms?: number;
  /** Computed cost in USD. */
  cost_usd?: number;
  [key: string]: unknown;
}

export type ValidationResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; errors: ErrorObject[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled: ValidateFunction = ajv.compile(schema as object);

/**
 * Validate an unknown value against the myelin envelope schema. On success,
 * returns the value typed as `Envelope` (no defensive copy — the value
 * is the same reference). On failure, returns the Ajv error array.
 *
 * Pure function. Safe to call from any context. Compiled validator is
 * created once at module load.
 */
export function validateEnvelope(value: unknown): ValidationResult {
  if (compiled(value)) {
    return { ok: true, envelope: value as Envelope };
  }
  return { ok: false, errors: compiled.errors ?? [] };
}

/**
 * Convenience for callers that just want a typed envelope or `null` (and
 * are willing to swallow the error detail). For loggable callers, prefer
 * `validateEnvelope` so you can surface the specific failure path.
 */
export function tryParseEnvelope(value: unknown): Envelope | null {
  const result = validateEnvelope(value);
  return result.ok ? result.envelope : null;
}

/**
 * Normalise `envelope.signed_by` into a stamp chain (myelin#31).
 *
 * The wire format accepts two shapes — a single stamp object (legacy
 * back-compat shim) or an array of stamps (canonical post-#31 form). This
 * helper coerces both into `SignedBy[]` without mutating the input. An
 * unsigned envelope returns `[]`.
 *
 * IAW Phase A.2: this is the **surfacing** primitive. Trust-decision
 * wiring (verify signatures, walk roles, enforce sovereignty against the
 * chain) is IAW Phase B (cortex#102). Today, the chain is exposed so
 * downstream consumers can log it, count hops, and start building Phase B
 * fixtures against real shapes.
 *
 * Pure function. No side effects. Safe to call from any context.
 */
export function getSignedByChain(envelope: Envelope): SignedBy[] {
  const value = envelope.signed_by;
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Return the principal of the LAST stamp in the chain, or `undefined` for
 * unsigned envelopes. The last stamp is the most recent attestor — the
 * entity that actually published the envelope on this hop.
 *
 * Surfacing primitive — paired with {@link getSignedByChain}. Not yet
 * consumed for trust decisions in cortex (Phase B / cortex#102 territory).
 */
export function getLastStampPrincipal(envelope: Envelope): string | undefined {
  const chain = getSignedByChain(envelope);
  if (chain.length === 0) return undefined;
  const last = chain[chain.length - 1];
  if (!last) return undefined;
  // R11 (vocabulary migration 2026-05, post-myelin#184): stamps emit
  // `identity` only — the `?? principal` fallback that handled pre-cut
  // peers is retired per docs/migrations/0002-vocabulary-finish-2026-05.md
  // §PR-R11. JetStream-replayed pre-migration stamps are rejected upstream
  // by the envelope validator (the `principal` key is now `additionalProperties: false`).
  return last.identity;
}

/**
 * Resolve the policy-attribution principal for an envelope (myelin#161 /
 * cortex#346). Returns the DID string the policy engine should resolve.
 *
 * Precedence (delegates to myelin's `getActorPrincipal` semantics — kept
 * vendored here so cortex's `Envelope` type can be passed directly without
 * a cross-package cast):
 *
 *   1. `envelope.originator?.identity` — explicit policy-attribution
 *      claim, covered by the envelope signature (`originator` is in
 *      myelin's SIGNABLE_FIELDS post-#161, so tampering invalidates the
 *      chain). Still dual-reads the deprecated `principal` key during
 *      the R2 transition window (myelin canonicalizes either form).
 *   2. `envelope.signed_by[0]?.identity` — first stamp in the chain.
 *      Legacy-compat fallback for pre-#161 envelopes that never set an
 *      `originator`. The `principal` key was retired from stamps in
 *      myelin#184 (R11), so this reads `identity` only.
 *   3. `undefined` — unsigned envelope with no originator block. Callers
 *      decide the fallback (e.g. `payload.agent_id` in the dispatch
 *      listener path).
 *
 * Pure function. No side effects.
 *
 * **Drift guard.** This is a vendored mirror of upstream:
 *   {@link import("@the-metafactory/myelin").getActorPrincipal}
 *   (definition at `node_modules/@the-metafactory/myelin/src/envelope.ts`).
 * `SCHEMA_SOURCE_COMMIT` one screen above will surface a vendored-schema
 * bump in code review; the three local-precedence tests in
 * `__tests__/envelope-validator.test.ts` lock cortex's contract.
 * **There is no upstream-parity contract test in this PR** — adding one
 * is filed as a follow-up (blocked by a pre-existing upstream strict-null
 * gap at `myelin/src/envelope.ts:527` unrelated to cortex#346; surfaces
 * only when cortex's tsc walks myelin's `/envelope` subpath, which the
 * runtime contract test would require).
 * If you update this function, update myelin's `getActorPrincipal` too:
 * the two implementations must agree on precedence, and nothing in CI
 * will catch them if they diverge until that follow-up lands.
 */
export function getActorPrincipal(envelope: Envelope): string | undefined {
  // R11 (vocabulary migration 2026-05, post-myelin#184): stamps emit
  // `identity` only — the signed_by-side `?? principal` fallback has
  // been dropped per docs/migrations/0002-vocabulary-finish-2026-05.md
  // §PR-R11. The originator-side dual-read remains: myelin's R2
  // transition is still active for the originator block, so we accept
  // either `originator.identity` (canonical) or `originator.principal`
  // (deprecated) until the originator R2 lockstep PR.
  if (envelope.originator) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const orig = envelope.originator.identity ?? envelope.originator.principal;
    if (orig) return orig;
  }
  const chain = getSignedByChain(envelope);
  const first = chain[0];
  if (!first) return undefined;
  return first.identity;
}

/**
 * Resolve the `target_assistant` of a Direct/Delegate envelope.
 *
 * Vocabulary migration 2026-05 R13 (breaking cut myelin#184): the
 * deprecated `target_principal` key was dropped from the wire — the
 * dual-read fallback has been retired per docs/migrations/
 * 0002-vocabulary-finish-2026-05.md §R10. The schema now rejects any
 * envelope that still carries `target_principal`.
 *
 * Returns `undefined` for envelopes that carry no target (e.g. an
 * Offer dispatch).
 */
export function getTargetAssistant(envelope: Envelope): string | undefined {
  return envelope.target_assistant;
}

/**
 * Resolve the FIRST stamp's DID across the R2 transition window
 * (vocabulary migration 2026-05). Canonical key is `identity`; falls
 * back to the deprecated `principal` for pre-migration / JetStream-
 * replayed stamps. Returns `fallback` when the chain is empty or the
 * first stamp has neither key set.
 *
 * Audit emitters (`createSystemAccessFederationDeniedEvent`,
 * `dispatch-listener` denial paths) use this so the same dual-read
 * lives in one place — the next rename/drop touches one helper rather
 * than every audit call-site.
 */
export function getFirstStampPrincipal(
  envelope: Envelope,
  fallback = "<unverified>",
): string {
  const chain = getSignedByChain(envelope);
  const first = chain[0];
  if (!first) return fallback;
  // R11 (vocabulary migration 2026-05, post-myelin#184): stamps emit
  // `identity` only — the `?? principal` fallback has been dropped.
  return first.identity ?? fallback;
}

/**
 * Sovereignty classification values per the myelin envelope schema. Exported
 * so emit-site helpers (`system-events.ts`, `dispatch-events.ts`,
 * `github-events.ts`, `taps/cc-events/cc-events.ts`) can accept an optional
 * `classification` parameter without redeclaring the enum.
 */
export type Classification = Envelope["sovereignty"]["classification"];

/**
 * IAW Phase A.5 — envelope-bound shim around myelin's pure-string
 * `deriveSubject` primitive (`@the-metafactory/myelin/subjects`,
 * pinned at `SCHEMA_SOURCE_COMMIT` above).
 *
 * Subject prefix mirrors `envelope.sovereignty.classification` per the
 * 1:1 alignment myelin enforces with
 * {@link validateSubjectEnvelopeAlignment}:
 *
 *   - `classification === "local"`     → `local.{principal}.{type}` (legacy)
 *                                      → `local.{principal}.{stack}.{type}` when `stack` supplied (myelin#113)
 *   - `classification === "federated"` → `federated.{network_id}.{type}` / `federated.{network_id}.{stack}.{type}`
 *   - `classification === "public"`    → `public.{type}` (no org, no stack — public is global)
 *
 * For `local.*` the `{principal}` segment is the first dotted segment of
 * `envelope.source` (the same value cortex's MyelinRuntime captures from the
 * boot-resolved `principal.id` at startup, so subject and source stay
 * symmetrical).
 *
 * **cortex#661 — federated subjects are network-scoped, not principal-scoped.**
 * For `federated.*` the SECOND segment is the TARGET `{network_id}`, NOT the
 * source principal. This is the grammar the design (`docs/design-multi-network.md`
 * §3.2) mandates and the side that already routes/subscribes: `selectLink`
 * (`runtime.ts`), the surface-router federation gate `evaluateFederationGate`,
 * and the per-leaf `federated.{network_id}.>` inbound subscriptions all key
 * segment[1] as the network id. Sourcing `{network_id}` from the principal here
 * (the pre-#661 bug) produced subjects that matched no leaf's network id → the
 * publish hit the unknown-network skip and was DROPPED (harmless only while
 * zero-leaf deployments short-circuit before reading segment[1]). The network id
 * is read from `extensions.network_id` — the canonical target-network metadata a
 * federated emit site stamps (e.g. pilot's `buildReviewRequestedEnvelope`). A
 * `federated` envelope that names no network is an EMIT ERROR and throws (see
 * {@link networkIdFromEnvelope}); there is NO silent principal fallback.
 *
 * `{stack}` is the principal's stack identity — supplied by the caller when in
 * stack-aware mode (IAW A.5), omitted in the legacy migration window.
 *
 * Pure function; safe to call from any context.
 */
/**
 * Extract the leading dotted segment from a string. `String.prototype.split`
 * is guaranteed to return ≥1 element, and cortex's incoming `envelope.source`
 * is already schema-validated to match
 * `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,4}$`, so the first segment is always
 * a non-empty string. The explicit invariant check below bridges
 * `noUncheckedIndexedAccess` to that runtime + schema invariant and survives
 * refactoring — if a future change weakens the schema or feeds unvalidated
 * input here, the throw fails fast at the call site instead of silently
 * propagating an empty `org` segment onto the wire (Sage R3 suggestion, PR #151).
 */
function firstSegment(s: string): string {
  const seg = s.split(".")[0];
  if (!seg) {
    throw new Error(
      "invariant: source has no leading segment — schema validation skipped?",
    );
  }
  return seg;
}

/**
 * IAW Phase A.3 follow-up (cortex#130 item 1) — symmetric `{principal}` extractor
 * for the publish-side. Publish derives `{principal}` from `envelope.source`'s
 * leading segment; subscribe substitutes `{principal}` in subject patterns from
 * the boot-resolved `principal.id` at startup (sourced via
 * `MyelinRuntimeOptions.principal`). These two values MUST agree for any
 * envelope this stack emits, or subjects diverge between publish/subscribe.
 *
 * Use {@link principalFromConfig} on the subscribe-side and
 * {@link principalFromEnvelope} on the publish-side. The unit test in
 * `src/bus/myelin/__tests__/runtime-principal-symmetry.test.ts` pins the
 * invariant that for envelopes emitted by this stack's helpers, the two
 * return identical strings.
 */
export function principalFromEnvelope(envelope: Envelope): string {
  return firstSegment(envelope.source);
}

/**
 * Subscribe-side `{principal}` resolver. See {@link principalFromEnvelope}
 * for the symmetric publish-side helper and the invariant they jointly
 * preserve.
 *
 * Falls back to `"default"` when `principalId` is unset — matches the
 * legacy inline expression at runtime.ts subscribe-site.
 */
export function principalFromConfig(principalId: string | undefined): string {
  return principalId ?? "default";
}

/**
 * IAW cortex#661 — federated subjects are NETWORK-scoped: segment[1] is the
 * target `{network_id}`, not the source principal. Extract it from the
 * canonical `extensions.network_id` routing-hint a federated emit site stamps
 * (e.g. pilot's `buildReviewRequestedEnvelope` sets `extensions.network_id`).
 *
 * This is the publish-side counterpart to `selectLink`/`evaluateFederationGate`
 * reading `subject.split(".")[1]` as the network id (design §3.2). Emit and
 * route therefore agree on what a federated subject's network segment is.
 *
 * **Fails loudly** when a `federated` envelope carries no usable
 * `extensions.network_id`: a federated envelope MUST name its target network,
 * or there is no link to route it to. Throwing here surfaces the emit-site bug
 * at the publish call rather than silently falling back to the principal (the
 * pre-#661 behaviour that produced un-routable subjects). Mirrors
 * {@link firstSegment}'s fail-fast invariant posture.
 *
 * `extensions` is the envelope's freeform `Record<string, unknown>` extension
 * point, so `network_id` is `unknown` and the lookup is defensively typed: a
 * missing key, a non-string value, or an empty string all throw.
 */
export function networkIdFromEnvelope(envelope: Envelope): string {
  const raw = envelope.extensions?.network_id;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      `deriveNatsSubject: federated envelope (id=${envelope.id}, type=${envelope.type}) has no extensions.network_id — a federated envelope MUST name its target network. Set extensions.network_id at the emit site (cortex#661).`,
    );
  }
  return raw;
}

export function deriveNatsSubject(envelope: Envelope, stack?: string): string {
  const classification = envelope.sovereignty.classification;
  // cortex#661 — federated subjects key segment[1] on the TARGET network id
  // (from extensions.network_id), NOT the source principal. local.* keeps the
  // principal segment (byte-identical pre/post #661); public.* carries neither.
  const segment1 =
    classification === "federated"
      ? networkIdFromEnvelope(envelope)
      : firstSegment(envelope.source);
  return deriveSubject(classification, segment1, envelope.type, stack);
}

/**
 * IAW Phase A.5 — envelope-bound shim around myelin's pure-string
 * `subjectPrefixAligns` primitive. Pure validator: confirms the leading
 * segment of a NATS subject matches `envelope.sovereignty.classification`.
 *
 * Cortex uses this as a defensive invariant when publishing on a
 * `MyelinRuntime` — a `local.*` subject must NOT carry a `federated` or
 * `public` envelope (and vice-versa). Misalignment is a protocol violation:
 * downstream peers may drop or reject the envelope.
 */
export function validateSubjectEnvelopeAlignment(
  subject: string,
  envelope: Envelope,
): {
  aligned: boolean;
  expected: Classification;
  actual: string;
} {
  return subjectPrefixAligns(subject, envelope.sovereignty.classification);
}
