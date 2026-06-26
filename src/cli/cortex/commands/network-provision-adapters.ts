/**
 * G1d / T1 (cortex#1139) — the LIVE adapters for `cortex network provision`.
 *
 * These touch the real world (nsc store via arc, the signing seed on disk, the
 * stack config YAML). The orchestration is pure over the injected ports
 * (`network-provision-lib.ts`); these adapters are only constructed on a real
 * `--apply` invocation. The arc account-tree seam reuses
 * `buildOperatorProvisioningAdapter` (operator-provisioning.ts) and the existing
 * `buildFederationWiringAdapter` (network-federation-wiring.ts) — cortex NEVER
 * runs nsc itself (ADR-0013 Model B invariant).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

import { parseDocument } from "yaml";

import { generateStackIdentity } from "../../../bus/stack-provisioning";
import { buildFederationWiringAdapter } from "./network-federation-wiring";
import { buildOperatorProvisioningAdapter } from "./operator-provisioning";
import type {
  ProvisionPorts,
  SigningIdentityPort,
  ProvisionConfigWritePort,
} from "./network-provision-lib";

// =============================================================================
// Signing-identity adapter — composes provision-stack's generateStackIdentity
// =============================================================================

/**
 * Live {@link SigningIdentityPort}. `generate` writes the seed `chmod 600` and
 * REFUSES to clobber without `force` (the orchestrator only calls it when the
 * seed is absent OR `--force` is set, so the refusal is belt-and-braces).
 *
 * @param seedPathExpanded - the already-tilde-expanded `stack.nkey_seed_path`.
 */
export function buildSigningIdentityAdapter(): SigningIdentityPort {
  return {
    exists: (seedPath) => existsSync(seedPath),
    generate: ({ seedPath, force }) => {
      try {
        const material = generateStackIdentity({ seedPath, force });
        return { ok: true, nkeyPub: material.nkeyPub, fingerprint: material.fingerprint };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// =============================================================================
// Config write-back adapter — persist stack.nats_infra + nkey_seed_path
// =============================================================================

/**
 * Live {@link ProvisionConfigWritePort}. Writes the resolved account-tree
 * fields into the stack config YAML in place, preserving comments
 * (parseDocument + setIn — same discipline as `ConfigStorePort.writeNetworks`).
 *
 * @param stackConfigPath - the already-resolved, tilde-expanded path to the
 *   stack file the daemon loads (config-split `stacks/<slug>.yaml`, or the
 *   legacy monolith). The CLI resolves this layout-aware before constructing.
 */
export function buildProvisionConfigWriteAdapter(stackConfigPath: string): ProvisionConfigWritePort {
  return {
    write: (fields) => {
      try {
        const doc = existsSync(stackConfigPath)
          ? parseDocument(readFileSync(stackConfigPath, "utf-8"))
          : parseDocument("");
        doc.setIn(["stack", "nats_infra", "account"], fields.account);
        doc.setIn(["stack", "nats_infra", "agents_account"], fields.agentsAccount);
        doc.setIn(["stack", "nats_infra", "creds_path"], fields.credsPath);
        doc.setIn(["stack", "nkey_seed_path"], fields.seedPath);
        if (fields.nkeyPub !== undefined) {
          doc.setIn(["stack", "nkey_pub"], fields.nkeyPub);
        }
        mkdirSync(dirname(stackConfigPath), { recursive: true });
        writeFileSync(stackConfigPath, doc.toString(), "utf-8");
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// =============================================================================
// Full live port bundle
// =============================================================================

/** Build the full live {@link ProvisionPorts} bundle for a real `--apply` run. */
export function buildLiveProvisionPorts(stackConfigPath: string): ProvisionPorts {
  return {
    operator: buildOperatorProvisioningAdapter(),
    signing: buildSigningIdentityAdapter(),
    federationWiring: buildFederationWiringAdapter(),
    configWrite: buildProvisionConfigWriteAdapter(stackConfigPath),
  };
}
