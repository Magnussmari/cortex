/**
 * G-1113.B.2 — taskRowToSourceRef shim: legacy source_* columns → SourceRef.
 */
import { test, expect } from "bun:test";
import { taskRowToSourceRef } from "../db/tasks";

test("maps a GitHub-sourced row to a github SourceRef", () => {
  const ref = taskRowToSourceRef({
    source_system: "github",
    source_url: "https://github.com/the-metafactory/cortex/issues/540",
    source_external_id: "540",
  });
  expect(ref).toEqual({
    provider: "github",
    externalId: "540",
    url: "https://github.com/the-metafactory/cortex/issues/540",
    providerNativeType: null,
  });
});

test("maps an internal row to an internal SourceRef with null refs", () => {
  const ref = taskRowToSourceRef({
    source_system: "internal",
    source_url: null,
    source_external_id: null,
  });
  expect(ref).toEqual({
    provider: "internal",
    externalId: null,
    url: null,
    providerNativeType: null,
  });
});

test("falls back to 'custom' for an unknown stored provider (defensive)", () => {
  const ref = taskRowToSourceRef({
    source_system: "svn",
    source_url: null,
    source_external_id: "r1234",
  });
  expect(ref).toEqual({
    provider: "custom",
    externalId: "r1234",
    url: null,
    providerNativeType: null,
  });
});

test("never sets providerNativeType in B.2 (adapters populate it in B.3+)", () => {
  for (const sys of ["github", "internal"]) {
    expect(taskRowToSourceRef({ source_system: sys, source_url: null, source_external_id: "1" }).providerNativeType).toBeNull();
  }
});
