/**
 * cortex#1265 — tests for the {@link OperatorModeExportPort} arc-shell adapter
 * (the server-config bridge: export the operator-mode JWTs so provision can
 * populate `stack.nats_infra`). Only the arc SUBPROCESS runner is swapped — for a
 * faithful contract harness that emulates arc's REAL `nats export-*` CLI: it
 * pins the argv cortex emits AND the `arc.nats.operator.v1` envelope it demands
 * back (the anti-rot guard, sibling of the #1225 provision-integration test).
 */
import { describe, test, expect } from "bun:test";

import { buildOperatorModeExportAdapter, type ArcExportRunner } from "../operator-mode-export";

const OP_PUB = "O" + "D".repeat(55);
const FED_PUB = "A" + "F".repeat(55);
const SYS_PUB = "A" + "S".repeat(55);
const OP_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPUCJ9.sig";
const FED_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig";
const SYS_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBU1lTIn0.sig";

const SCHEMA = "arc.nats.operator.v1";

/**
 * Faithful arc-CLI contract harness. Emulates arc's REAL `nats export-{operator,
 * account,system}` verbs + the `arc.nats.operator.v1` envelope. `record` captures
 * the argv. `sysAbsent` makes export-system return SYSTEM_ACCOUNT_NOT_FOUND.
 */
function arcContractRunner(record: string[][], opts?: { sysAbsent?: boolean }): ArcExportRunner {
  return async (argv) => {
    record.push([...argv]);
    const json = (env: object) => ({ stdout: JSON.stringify(env) + "\n", stderr: "", exitCode: 0 });
    const err = (code: string, message: string) => ({
      stdout: JSON.stringify({ schema: SCHEMA, ok: false, error: { code, message } }) + "\n",
      stderr: "",
      exitCode: 1,
    });
    if (argv[0] !== "nats") return { stdout: "", stderr: "unknown command", exitCode: 1 };
    switch (argv[1]) {
      case "export-operator":
        return json({ schema: SCHEMA, ok: true, operator: argv[argv.indexOf("--name") + 1], pubKey: OP_PUB, jwt: OP_JWT, seedPath: null });
      case "export-account":
        return json({ schema: SCHEMA, ok: true, account: argv[2], pubKey: FED_PUB, jwt: FED_JWT, seedPath: null });
      case "export-system":
        if (opts?.sysAbsent) return err("SYSTEM_ACCOUNT_NOT_FOUND", "system account \"SYS\" not found");
        return json({ schema: SCHEMA, ok: true, account: argv[argv.indexOf("--name") + 1], pubKey: SYS_PUB, jwt: SYS_JWT, seedPath: null });
      default:
        return { stdout: "", stderr: `unknown command: ${argv.join(" ")}`, exitCode: 1 };
    }
  };
}

describe("operator-mode-export adapter — faithful arc contract", () => {
  test("exportOperator emits `nats export-operator --name <op> --json` and parses the JWT", async () => {
    const record: string[][] = [];
    const adapter = buildOperatorModeExportAdapter(arcContractRunner(record));
    const r = await adapter.exportOperator({ name: "OP_ANDREAS" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorJwt).toBe(OP_JWT);
      expect(r.pubKey).toBe(OP_PUB);
    }
    const argv = record.find((a) => a[1] === "export-operator");
    expect(argv).toEqual(["nats", "export-operator", "--name", "OP_ANDREAS", "--json"]);
  });

  test("exportAccount emits `nats export-account <name> --json` and parses the JWT", async () => {
    const record: string[][] = [];
    const adapter = buildOperatorModeExportAdapter(arcContractRunner(record));
    const r = await adapter.exportAccount("ANDREAS_WORK_FED");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.jwt).toBe(FED_JWT);
      expect(r.pubKey).toBe(FED_PUB);
    }
    expect(record.find((a) => a[1] === "export-account")).toEqual(["nats", "export-account", "ANDREAS_WORK_FED", "--json"]);
  });

  test("exportSystem returns the SYS account when present", async () => {
    const adapter = buildOperatorModeExportAdapter(arcContractRunner([]));
    const r = await adapter.exportSystem({ name: "SYS" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pubKey).toBe(SYS_PUB);
      expect(r.jwt).toBe(SYS_JWT);
    }
  });

  test("exportSystem maps SYSTEM_ACCOUNT_NOT_FOUND to notFound:true (the skip signal)", async () => {
    const adapter = buildOperatorModeExportAdapter(arcContractRunner([], { sysAbsent: true }));
    const r = await adapter.exportSystem({ name: "SYS" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.notFound).toBe(true);
  });

  test("a schema mismatch (arc too old) fails loudly", async () => {
    const stale: ArcExportRunner = async () => ({
      stdout: JSON.stringify({ schema: "arc.nats.v1", ok: true }) + "\n",
      stderr: "",
      exitCode: 0,
    });
    const adapter = buildOperatorModeExportAdapter(stale);
    const r = await adapter.exportOperator({ name: "OP_ANDREAS" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("schema mismatch");
  });

  test("a non-not-found arc error on exportSystem is NOT a skip (notFound:false)", async () => {
    const broken: ArcExportRunner = async () => ({
      stdout: JSON.stringify({ schema: SCHEMA, ok: false, error: { code: "NSC_NOT_INSTALLED", message: "boom" } }) + "\n",
      stderr: "",
      exitCode: 1,
    });
    const adapter = buildOperatorModeExportAdapter(broken);
    const r = await adapter.exportSystem({ name: "SYS" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.notFound).toBe(false);
  });
});
