/**
 * M3 (cortex#1241) — receive-side transition-window primitive.
 */

import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import { openInboundEnvelope } from "../inbound-payload";
import { NetworkKeyring, sealPayload, type NetworkKey } from "../payload-encryption";

async function key(kid = "net1/k1"): Promise<NetworkKey> {
  await sodium.ready;
  return { kid, key: sodium.randombytes_buf(32) };
}

function cleartextEnvelope(): Envelope {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: "andreas.meta-factory.luna",
    type: "dispatch.task.dispatched",
    timestamp: "2026-06-27T00:00:00.000Z",
    sovereignty: {
      classification: "federated",
      data_residency: "NZ",
      max_hop: 3,
      frontier_ok: true,
      model_class: "any",
    },
    payload: { task: "review", secret: "do-not-leak" },
  };
}

describe("transition window: cleartext inbound", () => {
  test("enabled → cleartext accepted (both-accepted window)", async () => {
    const out = await openInboundEnvelope(cleartextEnvelope(), new NetworkKeyring([]), {
      mode: "enabled",
    });
    expect(out.status).toBe("cleartext");
  });

  test("off → cleartext accepted", async () => {
    const out = await openInboundEnvelope(cleartextEnvelope(), new NetworkKeyring([]), {
      mode: "off",
    });
    expect(out.status).toBe("cleartext");
  });

  test("required → cleartext REJECTED (secure default)", async () => {
    const out = await openInboundEnvelope(cleartextEnvelope(), new NetworkKeyring([]), {
      mode: "required",
    });
    expect(out.status).toBe("rejected");
    if (out.status === "rejected") expect(out.reason).toBe("cleartext_in_required");
  });
});

describe("transition window: sealed inbound", () => {
  test("sealed + key held → opened, payload recovered", async () => {
    const k = await key();
    const sealed = await sealPayload(cleartextEnvelope(), "net1", k);
    const keyring = new NetworkKeyring([{ net: "net1", keys: [k] }]);
    const out = await openInboundEnvelope(sealed, keyring, { mode: "enabled" });
    expect(out.status).toBe("opened");
    if (out.status === "opened") {
      expect(out.envelope.payload).toEqual(cleartextEnvelope().payload);
    }
  });

  test("sealed + key held → opened under required too", async () => {
    const k = await key();
    const sealed = await sealPayload(cleartextEnvelope(), "net1", k);
    const out = await openInboundEnvelope(
      sealed,
      new NetworkKeyring([{ net: "net1", keys: [k] }]),
      { mode: "required" },
    );
    expect(out.status).toBe("opened");
  });

  test("sealed + key MISSING → rejected key_unavailable (loud, not dropped-as-cleartext)", async () => {
    const k = await key();
    const sealed = await sealPayload(cleartextEnvelope(), "net1", k);
    const out = await openInboundEnvelope(sealed, new NetworkKeyring([]), {
      mode: "enabled",
    });
    expect(out.status).toBe("rejected");
    if (out.status === "rejected") expect(out.reason).toBe("key_unavailable");
  });

  test("sealed + wrong key → rejected open_failed", async () => {
    const sealed = await sealPayload(cleartextEnvelope(), "net1", await key());
    const wrong = await key(); // same kid, different bytes
    const out = await openInboundEnvelope(
      sealed,
      new NetworkKeyring([{ net: "net1", keys: [wrong] }]),
      { mode: "enabled" },
    );
    expect(out.status).toBe("rejected");
    if (out.status === "rejected") expect(out.reason).toBe("open_failed");
  });
});
