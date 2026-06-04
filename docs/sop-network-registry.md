# SOP — Network Registry (cross-principal trust anchor)

**Status:** active (TC-2 / Trust & Confidentiality track — #632 / #633 / #635)
**Owner:** principal
**Audience:** anyone provisioning or operating the cortex-network-registry, or wiring a cortex stack to consume `federated.*` traffic

---

## What is the network-registry?

The **network-registry** (`src/services/network-registry/`) is a Cloudflare Worker that serves as the **shared pubkey directory** for the IAW federation. It is the cross-principal trust anchor: when cortex stack A receives a `federated.{principal}.{stack}` envelope signed by a peer principal B, A resolves B's signing pubkey from the registry to verify the `signed_by[]` stamp. Without the registry, A has no way to learn B's key — peers can only verify each other if every key is hand-pinned in `policy.federated.networks[].peers[]`.

The registry is **different** from the [stack NKey](./sop-stack-identity.md):

| Thing | Purpose | Who holds it | Scope |
|---|---|---|---|
| **Stack NKey** ([sop-stack-identity](./sop-stack-identity.md)) | Per-stack signing key; signs every outbound envelope | each cortex stack (seed at `stack.nkey_seed_path`) | one stack's identity |
| **Registry signing key** (`REGISTRY_SIGNING_KEY`) | Signs the registry's GET assertions so peers trust the directory | the registry Worker (CF secret) | the whole federation's trust anchor |
| **Principal pubkey record** (in the registry) | The *public* half of a stack NKey, published so peers can resolve it | the registry's store, written by `register` | one principal's resolvable identity |

Put simply: the stack NKey is a **signing key**; the registry is the **directory** that lets every peer resolve every *other* peer's public key. The registry never holds any stack's secret seed — it stores only published pubkeys, and signs its answers with its own separate key.

The registry's wire contract (per `src/services/network-registry/src/index.ts` + `README.md`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/principals/{principal_id}/register` | A principal publishes a signed assertion of their pubkey (proof-of-possession) |
| `GET` | `/principals/{principal_id}` | A peer resolves a principal's current pubkey, wrapped in a registry `SignedAssertion` |
| `GET` | `/registry/pubkey` | Returns the registry's own Ed25519 pubkey — **pin this** |
| `GET` | `/networks/{network_id}/roster` | Who has announced into a network |
| `GET` | `/capabilities?query=<substring>` | Capability search |
| `GET` | `/api/health` | Liveness probe |

---

## The registry's own keypair

Every GET response is wrapped in a `SignedAssertion<T>` (`src/services/network-registry/src/types.ts`):

```jsonc
{
  "payload":    { "principal_id": "...", "principal_pubkey": "...", "stacks": [...], "capabilities": [...], "updated_at": "..." },
  "issued_at":  "2026-06-04T00:00:00.000Z",
  "registry":   "<base64 Ed25519 — the registry's own pubkey>",
  "signature":  "<base64 Ed25519 over canonicalJSON({ payload, issued_at, registry })>"
}
```

The registry signs that bound triple with `REGISTRY_SIGNING_KEY` (`signAssertion` in `routes/principals.ts`). A consuming cortex verifies the signature against the registry pubkey it **pinned** at config time before it will cache any `principal_pubkey`. That pinned value is `policy.federated.registry.pubkey` (see [§5](#5-wire-a-cortex-to-use-the-registry)).

**Where the registry key lives:** as a Cloudflare Worker secret named `REGISTRY_SIGNING_KEY`, set via `wrangler secret put` (`wrangler.toml` header + `Env.REGISTRY_SIGNING_KEY` in `src/index.ts`). It is never on the principal's disk and never in `cortex.yaml`. The matching public key is exposed at `GET /registry/pubkey` so principals can fetch it to pin.

**Where the pubkey comes from:** the Worker derives the public key from `REGISTRY_SIGNING_KEY` at boot (`ensurePublicKey` → `pubkeyFromPkcs8` in `src/index.ts`), unless `REGISTRY_PUBLIC_KEY` is set explicitly. Principals obtain it by querying `GET /registry/pubkey`, which returns `{ "algorithm": "Ed25519", "public_key": "<base64>" }`.

> **⚠️ Not yet implemented — registry-keypair provisioning command.** There is **no** CLI or script in the repo that *generates* the registry's keypair. `wrangler.toml` and `README.md` instruct the principal to `wrangler secret put REGISTRY_SIGNING_KEY` and paste a base64-encoded Ed25519 private key, but neither supplies the generation command. **You must generate it by hand, out-of-band, and there is a format discrepancy to resolve first** (see the next callout). This is the single biggest manual gap in the registry-provisioning story.

> **⚠️ Format discrepancy in the source — confirm before generating.** The key format is described inconsistently:
> - `src/index.ts` (`Env.REGISTRY_SIGNING_KEY` JSDoc) and `README.md` say **"base64-encoded PKCS#8 Ed25519 private key"**, and the Worker derives the pubkey via `pubkeyFromPkcs8(...)`.
> - `wrangler.toml`'s secrets comment says **"64 raw bytes (seed + pubkey), base64-encoded"**.
>
> These are two *different* encodings. The code path that actually runs (`pubkeyFromPkcs8` in `src/index.ts`) consumes **PKCS#8**, so the PKCS#8 description is the authoritative one and the `wrangler.toml` comment appears stale. Verify against `src/services/network-registry/src/signing.ts` before generating a key, and do not assume the `wrangler.toml` "raw 64 bytes" wording.

### Trust-anchor warning — pin, don't TOFU

The consumer side (`src/common/registry/client.ts`, `src/common/registry/resolve-pubkey.ts`) supports **two** ways to learn the registry pubkey:

1. **Pinned** — `policy.federated.registry.pubkey` set in `cortex.yaml`. The client refuses any assertion whose `registry` field disagrees with the pin.
2. **TOFU** (Trust-On-First-Use) — pubkey absent → the client fetches `GET /registry/pubkey` on first boot and pins whatever comes back for the process lifetime.

The code itself flags TOFU as the **Phase-B caveat**: an attacker controlling the network path between cortex and the registry on first boot could substitute their own pubkey, and every assertion thereafter would verify against the attacker's key. The JSDoc in `client.ts` is explicit: *"Principals wanting zero-TOFU should populate `policy.federated.registry.pubkey` in cortex.yaml."*

**Production posture: pin it.** Fetch `GET /registry/pubkey` over a trusted path (or receive the value out-of-band from whoever runs the registry), and paste it into `policy.federated.registry.pubkey`. TOFU is acceptable only for dev against a registry you control on a trusted network.

---

## Deploy the registry

The registry is a Cloudflare Worker (`src/services/network-registry/`). It is built/deployed with `wrangler`, independently of the main cortex daemon. Per `wrangler.toml`, `package.json`, and `README.md`:

```bash
# from the service directory
cd src/services/network-registry
bun install
```

**Worker config** (`wrangler.toml`):
- `name = "cortex-network-registry"`, `main = "src/index.ts"`, `compatibility_flags = ["nodejs_compat"]`.
- `workers_dev = false` — no `*.workers.dev` URL; the service is reached via a route.
- Two named environments: `[env.dev]` (`cortex-network-registry-dev`) and `[env.production]` (`cortex-network-registry`), each carrying an `ENVIRONMENT` var.
- The only **binding/secret** the service needs is `REGISTRY_SIGNING_KEY` (and the optional `REGISTRY_PUBLIC_KEY`). There is no D1 / KV / R2 binding wired (storage is in-memory — see the persistence callout below).

**Provision the signing secret, then deploy** (from `README.md` §Deploy):

```bash
# One-time per environment: provision the signing key.
bunx wrangler secret put REGISTRY_SIGNING_KEY --env production
# Paste the base64-encoded Ed25519 private key (PKCS#8 — see the format callout above).

# Deploy
bunx wrangler deploy --env production
```

For dev, substitute `--env dev`. Local-only iteration uses `bunx wrangler dev` (the `dev` script in `package.json`), which runs without a signing key — the Worker then degrades to the "unconfigured" path (see [§4](#the-unconfigured-sentinel)).

> **⚠️ Not yet implemented — DNS / routes.** Both `[env.dev]` and `[env.production]` have their `routes = [...]` blocks **commented out** in `wrangler.toml` ("Routes for dev are TBD…", "finalised at deploy time"). The plan names `network.meta-factory.ai` (prod) and `network-dev.meta-factory.ai` (dev), but DNS is not provisioned in-repo. You must uncomment + tune the route and provision DNS at first deploy. Until then a deploy produces a Worker with no public hostname.

> **⚠️ Not yet implemented — durable persistence.** Per `README.md` §Storage, the store is **in-memory per-isolate** (`InMemoryRegistryStore`). Registrations do **not** survive isolate recycling, and different isolates may hold different state. D1 / KV persistence is an explicit follow-up (`README.md` §Roadmap items 1–2), as is durable nonce-replay storage. **Do not treat a v1 registry as a durable directory** — a principal may need to re-register after an isolate cycles.

> **⚠️ Note — `package.json` deploy script is environment-agnostic.** The `deploy` script is bare `wrangler deploy` (no `--env`). Always pass `--env production` / `--env dev` explicitly on the command line, or you deploy to the top-level (unnamed) environment.

---

## Register a principal

Registration is the principal flow that publishes a stack's **public** key into the registry so peers can resolve it. It is **proof-of-possession**: the registration claim is signed with the stack's own signing key, and the registry verifies that signature against the pubkey being claimed.

The tooling is `cortex provision-stack` (TC-1b, #632 — `src/cli/cortex/commands/provision-stack.ts`, logic in `src/bus/stack-provisioning.ts`). It has three subcommands:

```
cortex provision-stack generate <principal-id> --seed-path <path> [--stack-id <id>] [--force] [--register --registry-url <url>] [--json]
cortex provision-stack claim    <principal-id> --seed-path <path> [--stack-id <id>] [--json]
cortex provision-stack register <principal-id> --seed-path <path> --registry-url <url> [--stack-id <id>] [--json]
```

### Step 1 — generate the stack identity

```bash
cortex provision-stack generate andreas \
  --seed-path ~/.config/nats/cortex.nk \
  --stack-id andreas/default
```

`generate` writes a fresh `SU…` NKey seed to `--seed-path` **chmod 600** and prints the public material — `nkey_pub` (`U…`), the base64 pubkey, a short fingerprint, and a ready-to-paste `stack:` block for `cortex.yaml`. It **refuses to clobber** an existing seed without `--force` (rotation is a security event — `generateStackIdentity` in `stack-provisioning.ts` uses an `O_EXCL` create so the no-clobber guarantee is kernel-enforced). The seed is the **same** key the stack signs bus envelopes with (design invariant: "no new long-term keys"), so there is exactly one root of secret material per stack.

`--stack-id` defaults to `<principal-id>/default`; an explicit value must be `{principal}/{slug}` and its prefix must match `<principal-id>`.

### Step 2 — register the pubkey (proof-of-possession)

If the seed already exists (e.g. `arc upgrade` provisioned it but the registry entry is missing), register it without rotating:

```bash
cortex provision-stack register andreas \
  --seed-path ~/.config/nats/cortex.nk \
  --registry-url https://network.meta-factory.ai \
  --stack-id andreas/default
```

`register` is the **only** subcommand that performs network I/O. It re-derives the material from the on-disk seed (chmod-600 gated), builds a signed `RegistrationClaim` (`buildRegistrationClaim`), and POSTs it to `POST /principals/{principal-id}/register`.

You can also fold registration into `generate` by adding `--register --registry-url <url>`. For an air-gapped / review-before-post flow, `cortex provision-stack claim …` prints the signed body (public key + detached signature only — never the seed) without posting it.

> **Secrets discipline:** the NKey seed is written to disk and held in memory to sign the claim, but is **never** printed or logged. CLI output carries the pubkey + fingerprint only.

### What the registry verifies, and what it stores

On `POST /principals/{id}/register` (`routes/principals.ts`), the registry, in order:

1. **Refuses if unconfigured** — if `REGISTRY_SIGNING_KEY` is absent, returns **503** (`registry_unconfigured`). It will not burn a TOFU slot accepting an unsigned registration it cannot produce a signed receipt for.
2. **Validates** the path `principal_id`, the signed-registration envelope, and the claim shape (**400** on failure).
3. **Clock-skew check** — rejects a `claim.issued_at` more than **±5 minutes** (`CLOCK_SKEW_MS`) from registry-now (**400**).
4. **Replay check** — rejects a reused `claim.nonce` within the window (**409** `nonce_replayed`).
5. **Signature verification** — verifies `claim.signature` over `canonicalJSON(claim)` against `claim.principal_pubkey` (**401** `signature_invalid` on failure). This is the proof-of-possession: the claim must be signed by the very key it declares.
6. **Rotation guard** — if a record already exists for this `principal_id` and the claimed `principal_pubkey` differs from the on-record one, rejects the **silent key swap** with **409** `pubkey_rotation_not_supported`. First register for an id is TOFU (any pubkey accepted); subsequent registers must sign with the on-record key.
7. **Upsert + signed receipt** — stores `(principal_pubkey, stacks, capabilities)` and returns the new `SignedAssertion<PrincipalRecord>` with **201**.

The **`RegistrationClaim`** wire shape (`src/services/network-registry/src/types.ts`): `principal_id`, `principal_pubkey`, `stacks[]`, `capabilities[]`, `issued_at`, `nonce`, wrapped in `SignedRegistration { claim, signature }`.

The stored **`PrincipalRecord`** (returned by GET): `principal_id`, `principal_pubkey`, `stacks[]`, `capabilities[]`, `updated_at`.

### The "unconfigured" sentinel

When the registry has **no** `REGISTRY_SIGNING_KEY`, GET responses cannot be signed. Rather than fail, `signAssertion` (`routes/principals.ts`) degrades to a structured-but-unsigned response with `registry: "unconfigured"` and an empty `signature`. This is the documented dev-only degradation. **Consuming cortex stacks MUST refuse to trust a sentinel-keyed assertion** — both `client.ts` and `resolve-pubkey.ts` explicitly reject `registry === "unconfigured"` (and `GET /registry/pubkey` itself returns **503** in this state). The POST mutation path never reaches the sentinel — it 503s first.

---

## Wire a cortex to use the registry

A consuming cortex declares the registry under `policy.federated.registry` (`PolicyFederatedRegistrySchema` in `src/common/types/cortex-config.ts`):

```yaml
policy:
  federated:
    registry:
      url: https://network.meta-factory.ai           # registry base URL (https in prod)
      pubkey: <base64 Ed25519 — from GET /registry/pubkey>   # PIN this (44 chars incl. '=')

security:
  signing: enforce                                     # activation condition (see below)
```

- **`url`** — validated as a URL. `https://` is required in production; `http://` is tolerated only so test rigs can hit a local in-process Hono app.
- **`pubkey`** — optional in the schema, but **set it in production**. Validated softly as base64 Ed25519 (`/^[A-Za-z0-9+/]{43}=$/` — 44 chars including padding). When set, cortex refuses any assertion whose `registry` field disagrees; when absent, cortex TOFUs at boot (the Phase-B caveat above).

### Activation condition — `security.signing: enforce`

The cross-principal verify seam (TC-2d, #635) engages **only** under `security.signing: enforce`. This is load-bearing and deliberate (`src/cortex.ts` ~L1289–1367):

```ts
const federationVerifyEnabled = config.security.signing === "enforce";
```

The gate is keyed on `signing === "enforce"`, **not** on `signingKnobs.cryptoVerify` (which is `true` for all postures as cheap observability per `src/common/security-posture.ts`). Under `off` / `permissive`, the `PrincipalPubkeyResolver` is never constructed and there is **zero registry I/O** — federated envelopes verify local-only, exactly as today. The seam wires only when **all** of these hold: `signing === "enforce"`, a `policy.federated.registry` block is present, and the local stack signer / NKey pubkey is derivable. On success cortex logs:

```
cortex: TC-2d federated-verify seam wired (signing=enforce, registry=<url>) —
  inbound federated.* envelopes verify against registry-resolved peer pubkeys
```

If `enforce` is set but no `policy.federated.registry` is configured, cortex logs that federated envelopes verify local-only (no peer resolution) and continues.

### What breaks if you skip a step

- **Registry pubkey not pinned** → cortex falls back to TOFU; a first-boot MITM on the registry path can substitute its own anchor key and forge every subsequent resolution. Mitigation: pin `policy.federated.registry.pubkey`.
- **Peer principal not registered** → `GET /principals/{id}` returns **404**; the resolver returns `not_found`; the verifier **rejects** that peer's envelope as unverifiable. The peer must run `cortex provision-stack register` before its traffic will be accepted.
- **Pubkey mismatch** (peer rotated, or pin is wrong) → the resolver / client logs a `registry pubkey mismatch` and ignores the assertion; the peer's envelopes are rejected until the keys agree.

---

## Verify it works

1. **Registry is up + signed.** `GET /api/health` returns `{ "status": "ok", ... }`. `GET /registry/pubkey` returns `{ "algorithm": "Ed25519", "public_key": "<base64>" }` — **not** a 503 and **not** `"unconfigured"`. If it 503s, `REGISTRY_SIGNING_KEY` was never provisioned.

2. **A principal resolves.** `GET /principals/{id}` returns a `SignedAssertion` whose `registry` field equals the pubkey you pinned, `payload.principal_id` echoes `{id}`, and `payload.principal_pubkey` is the registered base64 Ed25519 key. A 404 means the principal isn't registered.

3. **Boot self-check passes.** On a consuming cortex under `signing: enforce`, the boot-time `verifier-self-check` (cortex#480 / TC-1b, `src/bus/verifier-self-check.ts`) round-trips a self-signed envelope through `verifySignedByChain`. Success logs a grep-friendly line:

   ```
   cortex: verifier-self-check OK — self-signed envelope round-tripped through verifySignedByChain (stack=did:mf:andreas-meta-factory)
   ```

   A failure logs `verifier-self-check: FAILED …` (grep `verifier-self-check` in `cortex-meta-factory.error.log`). Under `enforce` a failure is **fatal** (see [§7](#operational-notes)).

4. **A cross-principal verify lands.** When a `federated.{peer}.{stack}` envelope arrives, the resolver fetches the peer's pubkey from the registry, verifies the registry assertion against the pinned anchor, caches it, and feeds it to the chain verifier. A successful resolve is silent (cached); failures log via `process.stderr` — e.g. `registry-resolver: resolve(<peer>): signature did not verify; ignoring` (resolution failed) or `… GET <url> returned 404` (peer unregistered). Either way the verifier rejects the unverifiable envelope rather than admitting it.

---

## Operational notes

### Crash-loop fail-safe (deliberate "down beats bad-identity")

Under `security.signing: enforce`, a stack with a **missing or unverifiable** signing identity must **not** serve traffic peers will silently reject. The TC-1b boot gate (`bootVerifierSelfCheck` in `src/bus/verifier-self-check.ts`) enforces this by **throwing** under `enforce`:

- no signing identity wired → `REFUSING TO BOOT — security.signing=enforce but no stack signing identity is wired …`
- identity wired but the self-check round-trip fails → `REFUSING TO BOOT — … failed the boot self-check …`
- (in `src/cortex.ts`) `enforce` with no agents at all → same fail-fast refusal.

The throw propagates to `bootOrDie` (`src/cortex.ts`), which logs `cortex: FATAL — boot aborted: …`, removes the PID file, and calls `process.exit(1)`. Because the launchd plists ship `KeepAlive = true` (`src/services/ai.meta-factory.cortex.meta-factory.plist` and siblings), launchd immediately restarts the process — which fails the gate again — producing a **deliberate crash-loop**. This is the intended posture: a stack with a broken identity stays **down** rather than serving traffic the federation will drop.

**How to recognise it:** repeated `cortex: FATAL — boot aborted: verifier-self-check: REFUSING TO BOOT …` lines in the error log, a process that never stays up under `launchctl list`. **How to recover:** either provision/repair the stack identity — `cortex provision-stack generate|register`, then confirm `stack.nkey_seed_path` + `stack.nkey_pub` in `cortex.yaml` and that the pubkey is registered — or, as a temporary measure, drop `security.signing` to `permissive` (advisory: warns but boots). Re-promote to `enforce` once the identity round-trips.

### Rotation

- **Stack-key rotation** is the cross-peer coordinated change in [sop-stack-identity §How do I rotate](./sop-stack-identity.md). The registry adds one constraint: a **silent** key swap is rejected (**409** `pubkey_rotation_not_supported`). Co-signed-transition rotation is a registry **v2 follow-up** (`README.md` §Roadmap item 3) — until it lands, rotating a registered principal's key requires registry-side intervention, not just a re-register.
- **Registry-key rotation** invalidates every principal's pinned `policy.federated.registry.pubkey` at once. It is a federation-wide event: every consumer must update the pin (and bust its resolver cache) before it will trust the rotated registry. Treat it as catastrophic-blast-radius.

### Threat model

- **Registry-seed leak (catastrophic — federation-wide).** Anyone with `REGISTRY_SIGNING_KEY` can forge a `SignedAssertion` for *any* principal — i.e. substitute their own key for any peer that consumers will then trust and cache. This compromises cross-principal trust for the whole federation, not one stack. Mitigations: keep the key only as a CF Worker secret (never on disk, never in `cortex.yaml`, never logged); rotate on any suspicion (and force every consumer to re-pin); restrict who can `wrangler secret put` / deploy the Worker.
- **First-boot TOFU substitution.** A consumer that doesn't pin `policy.federated.registry.pubkey` trusts whatever `GET /registry/pubkey` returns on first boot; a network-path attacker can substitute their own anchor. Mitigation: **pin** the pubkey out-of-band (the production posture).
- **Forged registration.** Blocked by proof-of-possession (the claim is signed by the very key it declares) + the rotation guard (no silent swap of an established key) + nonce/skew replay protection. The first-sight TOFU window for a brand-new `principal_id` remains: whoever registers an unclaimed id first owns it until co-signed rotation exists.
- **Replay within the skew window across isolates.** The in-memory nonce cache is per-isolate; an in-flight replay against a *different* isolate within the ±5-minute skew window can currently succeed (`README.md` §Roadmap item 2). Durable nonce storage is a follow-up; until then the 5-minute window bounds the exposure.
- **Open discovery surface.** Network membership is open-announce — any principal can announce into any `network_id`, and attribution is visible without a join handshake (`README.md` §"Discovery vs. traffic gating"). This is intentional for v1; *traffic* gating lives in `accept_subjects` / `deny_subjects`, not in the directory. A sealed-network join handshake is a follow-up.

---

## Cross-references

- [`docs/sop-stack-identity.md`](./sop-stack-identity.md) — the per-stack signing key (the other half of the signed-envelope story; rotation procedure for the stack NKey).
- [`docs/design-trust-confidentiality.md`](./design-trust-confidentiality.md) — the Trust & Confidentiality design (posture ramp `off → permissive → enforce`; §4 Phase 1.1b provisioning invariant; §"Phase 2-verify").
- **Issues:** #632 (TC-1b — `cortex provision-stack` + the posture-aware boot gate), #633 (TC-2a — `PrincipalPubkeyResolver`), #634 (TC-2 track), #635 (TC-2d — `federated.*` crypto-verify seam wired under `enforce`).
- **Source — registry service:** `src/services/network-registry/src/index.ts`, `…/src/routes/principals.ts`, `…/src/types.ts`, `…/wrangler.toml`, `…/package.json`, `…/README.md`.
- **Source — provisioning CLI:** `src/cli/cortex/commands/provision-stack.ts`, `src/bus/stack-provisioning.ts`.
- **Source — consumer side:** `src/common/registry/resolve-pubkey.ts`, `src/common/registry/client.ts`, `src/common/types/cortex-config.ts` (`PolicyFederatedRegistrySchema`), `src/common/security-posture.ts`.
- **Source — boot gate:** `src/bus/verifier-self-check.ts` (`bootVerifierSelfCheck`), `src/cortex.ts` (TC-2d seam ~L1289, boot self-check ~L2275, `bootOrDie`).
