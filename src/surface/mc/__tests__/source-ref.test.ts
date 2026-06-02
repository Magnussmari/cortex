/**
 * G-1113.B.1 — Provider enum + SourceRef shape (types only).
 *
 * Guards the single-source-of-truth invariant (PROVIDERS ⇄ Provider ⇄
 * isProvider) and the legacy-superset relationship with TaskSourceSystem.
 */
import { test, expect } from "bun:test";
import { PROVIDERS, isProvider, type Provider, type SourceRef, type TaskSourceSystem } from "../types";

// Compile-time invariant: every legacy TaskSourceSystem member MUST be a
// Provider. If someone adds a TaskSourceSystem member without adding it to
// PROVIDERS, this line fails `tsc` — the superset relationship is enforced by
// the type-checker, not by remembering to extend the runtime array below.
type _AssertSourceSystemSubsetOfProvider = TaskSourceSystem extends Provider ? true : never;
const _sourceSystemIsProviderSubset: _AssertSourceSystemSubsetOfProvider = true;
void _sourceSystemIsProviderSubset;

test("PROVIDERS lists the expected members", () => {
  expect([...PROVIDERS]).toEqual([
    "internal",
    "github",
    "gitlab",
    "azure-devops",
    "jira",
    "linear",
    "bitbucket",
    "custom",
  ]);
});

test("isProvider accepts every PROVIDERS member", () => {
  for (const p of PROVIDERS) expect(isProvider(p)).toBe(true);
});

test("isProvider rejects non-members and non-strings", () => {
  expect(isProvider("Github")).toBe(false); // case-sensitive
  expect(isProvider("svn")).toBe(false);
  expect(isProvider("")).toBe(false);
  expect(isProvider(null)).toBe(false);
  expect(isProvider(undefined)).toBe(false);
  expect(isProvider(42)).toBe(false);
});

test("Provider is a superset of the legacy TaskSourceSystem", () => {
  const legacy: TaskSourceSystem[] = ["github", "internal"];
  for (const s of legacy) expect(isProvider(s)).toBe(true);
});

test("SourceRef shape: providerNativeType preserved on the normalized concept (design §11)", () => {
  const mr: SourceRef = {
    provider: "gitlab",
    externalId: "42",
    url: "https://gitlab.example/group/repo/-/merge_requests/42",
    providerNativeType: "merge_request",
  };
  expect(mr.provider).toBe("gitlab");
  expect(mr.providerNativeType).toBe("merge_request");

  const internal: SourceRef = {
    provider: "internal",
    externalId: null,
    url: null,
    providerNativeType: null,
  };
  expect(internal.externalId).toBeNull();

  // type-level: a valid Provider is assignable
  const p: Provider = "azure-devops";
  expect(isProvider(p)).toBe(true);
});
