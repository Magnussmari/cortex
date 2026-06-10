/**
 * S1 (#735) — NetworkCache unit tests (DD-10 disk fallback).
 *
 * Direct tests of the cache primitive: store/load round-trip, corrupt-file
 * resilience, wrong-network rejection, and the no-file case. These complement
 * the client-level cache tests in `network-client.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { NetworkCache } from "../network-cache";
import type { NetworkDescriptor, NetworkRosterResult } from "../types";

const noopLog = (): void => {
  /* swallow */
};

let tmp: string;
let cache: NetworkCache;

const descriptor: NetworkDescriptor = {
  network_id: "iaw",
  hub_url: "tls://hub.meta-factory.ai:7422",
  leaf_port: 7422,
  members: ["andreas", "jc"],
};
const roster: NetworkRosterResult = {
  network_id: "iaw",
  members: [{ principal_id: "andreas", principal_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cortex-cache-unit-"));
  cache = new NetworkCache({ cacheDir: tmp, logError: noopLog });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("NetworkCache", () => {
  test("store then load round-trips a verified pair", () => {
    expect(cache.store("iaw", descriptor, roster)).toBe(true);
    const loaded = cache.load("iaw");
    expect(loaded?.descriptor).toEqual(descriptor);
    expect(loaded?.roster).toEqual(roster);
    expect(typeof loaded?.cached_at).toBe("string");
  });

  test("load returns undefined when no cache file exists", () => {
    expect(cache.load("absent")).toBeUndefined();
  });

  test("load returns undefined on a corrupt (non-JSON) cache file", () => {
    writeFileSync(join(tmp, "iaw.json"), "{ not valid json", { encoding: "utf8" });
    expect(cache.load("iaw")).toBeUndefined();
  });

  test("load rejects a file whose cached network_id does not match", () => {
    // A descriptor for a DIFFERENT network written under the iaw filename.
    cache.store("other", { ...descriptor, network_id: "other" }, { ...roster, network_id: "other" });
    // Hand-place the 'other' content under the 'iaw' filename to simulate a
    // swapped/corrupt file.
    const otherContent = cache.load("other");
    expect(otherContent).toBeDefined();
    writeFileSync(
      join(tmp, "iaw.json"),
      JSON.stringify({
        schema_version: 1,
        cached_at: new Date().toISOString(),
        descriptor: { ...descriptor, network_id: "other" },
        roster: { ...roster, network_id: "other" },
      }),
      { encoding: "utf8" },
    );
    expect(cache.load("iaw")).toBeUndefined();
  });

  test("load rejects an unknown schema_version", () => {
    writeFileSync(
      join(tmp, "iaw.json"),
      JSON.stringify({ schema_version: 999, cached_at: "x", descriptor, roster }),
      { encoding: "utf8" },
    );
    expect(cache.load("iaw")).toBeUndefined();
  });

  // #850 — enumerate every cached descriptor (the `registered`-lifecycle source).
  describe("list (#850)", () => {
    test("returns [] when the cache dir does not exist", () => {
      const absent = new NetworkCache({
        cacheDir: join(tmp, "does-not-exist"),
        logError: noopLog,
      });
      expect(absent.list()).toEqual([]);
    });

    test("returns [] when the cache dir is empty", () => {
      expect(cache.list()).toEqual([]);
    });

    test("enumerates every valid cached record", () => {
      cache.store("iaw", descriptor, roster);
      const community: NetworkDescriptor = { ...descriptor, network_id: "metafactory-community" };
      const communityRoster: NetworkRosterResult = { ...roster, network_id: "metafactory-community" };
      cache.store("metafactory-community", community, communityRoster);

      const ids = cache.list().map((r) => r.descriptor.network_id).sort();
      expect(ids).toEqual(["iaw", "metafactory-community"]);
    });

    test("skips a corrupt file rather than throwing or surfacing it", () => {
      cache.store("iaw", descriptor, roster);
      writeFileSync(join(tmp, "broken.json"), "{ not json", { encoding: "utf8" });

      const ids = cache.list().map((r) => r.descriptor.network_id);
      expect(ids).toEqual(["iaw"]); // the corrupt file is dropped
    });

    test("ignores non-.json files in the cache dir", () => {
      cache.store("iaw", descriptor, roster);
      writeFileSync(join(tmp, "README.txt"), "not a cache file", { encoding: "utf8" });
      expect(cache.list().length).toBe(1);
    });

    // Review #1 — a non-canonical filename must be ENUMERATED + validated by
    // reading the entry directly, NOT silently missed via a pathFor round-trip
    // (pathFor sanitizes `[^a-z0-9-] → _`, so `load("Foo")` would look at
    // `Foo.json` → `_oo`? no — `F`→`_`, i.e. `_oo.json`, a different path).
    test("enumerates a non-canonical filename whose record matches its basename", () => {
      // `Foo.json` — uppercase basename. Its record's network_id MUST equal the
      // basename "Foo" for the swap guard to admit it. (A real cache never writes
      // such a name; this proves list() reads the actual file, not a sanitized one.)
      const fooDescriptor: NetworkDescriptor = { ...descriptor, network_id: "Foo" };
      const fooRoster: NetworkRosterResult = { ...roster, network_id: "Foo" };
      writeFileSync(
        join(tmp, "Foo.json"),
        JSON.stringify({
          schema_version: 1,
          cached_at: new Date().toISOString(),
          descriptor: fooDescriptor,
          roster: fooRoster,
        }),
        { encoding: "utf8" },
      );
      const ids = cache.list().map((r) => r.descriptor.network_id);
      // BEFORE review #1's fix this was [] — load("Foo") → pathFor sanitized
      // "Foo" to "_oo" and read the wrong (absent) path, silently missing it.
      expect(ids).toEqual(["Foo"]);
    });

    test("drops a file with valid JSON whose network_id mismatches its basename (swap guard)", () => {
      // Valid JSON, valid shape, but the record names a DIFFERENT network than the
      // filename → the swap guard drops it (a swapped/renamed file is not trusted).
      writeFileSync(
        join(tmp, "iaw.json"),
        JSON.stringify({
          schema_version: 1,
          cached_at: new Date().toISOString(),
          descriptor: { ...descriptor, network_id: "someone-else" },
          roster: { ...roster, network_id: "someone-else" },
        }),
        { encoding: "utf8" },
      );
      expect(cache.list()).toEqual([]); // dropped, not mis-attributed
    });

    test("degrades to a drop (not a throw) on an unreadable / dangling-symlink entry", () => {
      cache.store("iaw", descriptor, roster);
      // A dangling symlink ending in `.json` — readFileSync throws ENOENT/ELOOP.
      // list() must drop it and still return the valid record, never throw.
      symlinkSync(join(tmp, "nonexistent-target"), join(tmp, "dangling.json"));
      // A directory occupying a `.json` entry slot — readFileSync throws EISDIR.
      mkdirSync(join(tmp, "adir.json"));

      let result: ReturnType<typeof cache.list>;
      expect(() => {
        result = cache.list();
      }).not.toThrow();
      const ids = result!.map((r) => r.descriptor.network_id);
      expect(ids).toEqual(["iaw"]); // only the valid record survives
    });
  });
});
