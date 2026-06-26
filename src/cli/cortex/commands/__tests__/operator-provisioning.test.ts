/**
 * G1d (cortex#1139) — tests for the arc-shell driver behind `cortex network
 * provision`: `arc nats init-operator` + `arc nats add-account`. The arc
 * subprocess is faked via the injectable runner — no real nsc/arc.
 */
import { describe, test, expect } from "bun:test";

import {
  buildOperatorProvisioningAdapter,
  type ArcOperatorRunner,
  type ArcOperatorRunResult,
} from "../operator-provisioning";

const SCHEMA = "arc.nats.operator.v1";

/** A runner that returns a canned stdout JSON line. */
function cannedRunner(payload: object, exitCode = 0): {
  runner: ArcOperatorRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: ArcOperatorRunner = (argv) => {
    calls.push([...argv]);
    const result: ArcOperatorRunResult = {
      stdout: JSON.stringify(payload) + "\n",
      stderr: "",
      exitCode,
    };
    return Promise.resolve(result);
  };
  return { runner, calls };
}

describe("operator-provisioning — init-operator", () => {
  test("shells `arc nats init-operator --name <name> --json` and parses the ok envelope", async () => {
    const { runner, calls } = cannedRunner({
      schema: SCHEMA,
      ok: true,
      operator: "OP_ANDREAS",
      pubKey: "OD4D",
      created: true,
      alreadyExisted: false,
      seedPath: "/keys/O/AB/OD4D.nk",
    });
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.initOperator({ name: "OP_ANDREAS", force: false });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.operator).toBe("OP_ANDREAS");
      expect(res.created).toBe(true);
      expect(res.alreadyExisted).toBe(false);
    }
    expect(calls[0]).toEqual(["nats", "init-operator", "--name", "OP_ANDREAS", "--json"]);
  });

  test("appends --force when rotating", async () => {
    const { runner, calls } = cannedRunner({
      schema: SCHEMA,
      ok: true,
      operator: "OP_ANDREAS",
      pubKey: "OD4D",
      created: true,
      alreadyExisted: true,
      seedPath: null,
    });
    const port = buildOperatorProvisioningAdapter(runner);
    await port.initOperator({ name: "OP_ANDREAS", force: true });
    expect(calls[0]).toEqual(["nats", "init-operator", "--name", "OP_ANDREAS", "--force", "--json"]);
  });

  test("idempotent re-run surfaces alreadyExisted=true, created=false", async () => {
    const { runner } = cannedRunner({
      schema: SCHEMA,
      ok: true,
      operator: "OP_ANDREAS",
      pubKey: "OD4D",
      created: false,
      alreadyExisted: true,
      seedPath: "/keys/O/AB/OD4D.nk",
    });
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.initOperator({ name: "OP_ANDREAS", force: false });
    expect(res.ok && res.alreadyExisted).toBe(true);
    expect(res.ok && res.created).toBe(false);
  });

  test("surfaces an arc error envelope as { ok:false, reason }", async () => {
    const { runner } = cannedRunner({
      schema: SCHEMA,
      ok: false,
      error: { code: "NSC_NOT_INSTALLED", message: "nsc is not on PATH" },
    });
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.initOperator({ name: "OP_ANDREAS", force: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("NSC_NOT_INSTALLED");
      expect(res.reason).toContain("nsc is not on PATH");
    }
  });

  test("a wrong schema string fails loudly (arc dependency unmet)", async () => {
    const { runner } = cannedRunner({ schema: "arc.nats.v1", ok: true });
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.initOperator({ name: "OP_ANDREAS", force: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("cortex#1139");
  });

  test("a spawn failure surfaces an install hint", async () => {
    const runner: ArcOperatorRunner = () => Promise.reject(new Error("ENOENT: arc not found"));
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.initOperator({ name: "OP_ANDREAS", force: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("arc nats init-operator");
  });
});

describe("operator-provisioning — add-account", () => {
  test("shells `arc nats add-account <name> --json` and parses the ok envelope", async () => {
    const acct = "A" + "B".repeat(55);
    const { runner, calls } = cannedRunner({
      schema: SCHEMA,
      ok: true,
      account: "ANDREAS_RESEARCH_FED",
      pubKey: acct,
      created: true,
      alreadyExisted: false,
    });
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.addAccount({ name: "ANDREAS_RESEARCH_FED" });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.account).toBe("ANDREAS_RESEARCH_FED");
      expect(res.pubKey).toBe(acct);
      expect(res.created).toBe(true);
    }
    expect(calls[0]).toEqual(["nats", "add-account", "ANDREAS_RESEARCH_FED", "--json"]);
  });

  test("idempotent re-run: alreadyExisted=true", async () => {
    const acct = "A" + "C".repeat(55);
    const { runner } = cannedRunner({
      schema: SCHEMA,
      ok: true,
      account: "ANDREAS_RESEARCH_AGENTS",
      pubKey: acct,
      created: false,
      alreadyExisted: true,
    });
    const port = buildOperatorProvisioningAdapter(runner);
    const res = await port.addAccount({ name: "ANDREAS_RESEARCH_AGENTS" });
    expect(res.ok && res.alreadyExisted).toBe(true);
  });
});
