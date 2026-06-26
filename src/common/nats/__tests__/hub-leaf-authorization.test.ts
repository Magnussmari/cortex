/**
 * ADR-0018 PR5b — hub-side leaf authorization renderer (pure) tests.
 *
 * The hub end of the per-member PSK: add/replace/remove a `leafnodes {
 * authorization { users: [...] } }` entry idempotently, without touching the
 * hub's own leafnodes directives, and never letting a hostile value
 * break out of the users[] array.
 */

import { describe, test, expect } from "bun:test";
import {
  upsertHubLeafUser,
  removeHubLeafUser,
  hubLeafUserPresent,
  listHubLeafUsers,
  HubAuthConflictError,
} from "../hub-leaf-authorization";

describe("upsertHubLeafUser", () => {
  test("adds a user into a config with no leafnodes block (creates the block)", () => {
    const conf = `server_name: hub\nlisten: 0.0.0.0:4222\n`;
    const out = upsertHubLeafUser(conf, "alice", "PSK-alice");
    expect(out).toContain("leafnodes {");
    expect(hubLeafUserPresent(out, "alice")).toBe(true);
    expect(listHubLeafUsers(out)).toEqual([{ user: "alice", secret: "PSK-alice" }]);
    // The hub's own directives are preserved verbatim.
    expect(out).toContain("server_name: hub");
    expect(out).toContain("listen: 0.0.0.0:4222");
  });

  test("inserts into an EXISTING leafnodes block, preserving its directives", () => {
    const conf = `leafnodes {\n  listen: 0.0.0.0:7422\n  no_advertise: true\n}\n`;
    const out = upsertHubLeafUser(conf, "alice", "PSK-alice");
    expect(out).toContain("listen: 0.0.0.0:7422");
    expect(out).toContain("no_advertise: true");
    expect(hubLeafUserPresent(out, "alice")).toBe(true);
  });

  test("is idempotent — same (user, secret) re-render is byte-stable", () => {
    const conf = `leafnodes {\n  listen: 0.0.0.0:7422\n}\n`;
    const once = upsertHubLeafUser(conf, "alice", "PSK-alice");
    const twice = upsertHubLeafUser(once, "alice", "PSK-alice");
    expect(twice).toBe(once);
  });

  test("accumulates multiple distinct users (sorted)", () => {
    let conf = `leafnodes {\n  listen: 0.0.0.0:7422\n}\n`;
    conf = upsertHubLeafUser(conf, "bob", "PSK-bob");
    conf = upsertHubLeafUser(conf, "alice", "PSK-alice");
    expect(listHubLeafUsers(conf)).toEqual([
      { user: "alice", secret: "PSK-alice" },
      { user: "bob", secret: "PSK-bob" },
    ]);
  });

  test("rotate: a new secret for an existing user REPLACES it (old inert)", () => {
    let conf = upsertHubLeafUser(`leafnodes {}\n`, "alice", "PSK-old");
    conf = upsertHubLeafUser(conf, "alice", "PSK-new");
    const users = listHubLeafUsers(conf);
    expect(users).toEqual([{ user: "alice", secret: "PSK-new" }]);
    expect(conf).not.toContain("PSK-old");
  });

  test("rejects a malformed user (HOCON-injection guard)", () => {
    expect(() => upsertHubLeafUser(`leafnodes {}\n`, 'a" } ] } evil {', "x")).toThrow();
    expect(() => upsertHubLeafUser(`leafnodes {}\n`, "Alice", "x")).toThrow(); // uppercase
  });

  test("rejects an empty secret", () => {
    expect(() => upsertHubLeafUser(`leafnodes {}\n`, "alice", "")).toThrow();
  });

  test("refuses to clobber a hand-written authorization block inside leafnodes", () => {
    const conf = `leafnodes {\n  authorization {\n    user: legacy\n    password: hunter2\n  }\n}\n`;
    expect(() => upsertHubLeafUser(conf, "alice", "PSK")).toThrow(HubAuthConflictError);
  });
});

describe("removeHubLeafUser", () => {
  test("removes a user; idempotent on an absent user", () => {
    let conf = upsertHubLeafUser(`leafnodes {\n  listen: 0.0.0.0:7422\n}\n`, "alice", "PSK-alice");
    conf = upsertHubLeafUser(conf, "bob", "PSK-bob");
    conf = removeHubLeafUser(conf, "alice");
    expect(hubLeafUserPresent(conf, "alice")).toBe(false);
    expect(hubLeafUserPresent(conf, "bob")).toBe(true);
    // The leaked secret is gone from the file (transport cut).
    expect(conf).not.toContain("PSK-alice");
    // idempotent
    expect(removeHubLeafUser(conf, "alice")).toBe(conf);
  });

  test("removing the last user tears down the managed region, preserving hub directives", () => {
    let conf = upsertHubLeafUser(`leafnodes {\n  listen: 0.0.0.0:7422\n}\n`, "alice", "PSK-alice");
    conf = removeHubLeafUser(conf, "alice");
    expect(conf).not.toContain("authorization");
    expect(conf).not.toContain("PSK-alice");
    expect(conf).toContain("listen: 0.0.0.0:7422");
  });

  test("add → remove round-trips to an empty user set", () => {
    const base = `leafnodes {\n  listen: 0.0.0.0:7422\n}\n`;
    const out = removeHubLeafUser(upsertHubLeafUser(base, "alice", "PSK"), "alice");
    expect(listHubLeafUsers(out)).toEqual([]);
  });
});
