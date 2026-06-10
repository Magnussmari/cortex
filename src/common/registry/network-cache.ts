/**
 * S1 (Network Join Control Plane, #735) — on-disk last-known-good cache for
 * verified network descriptors + rosters.
 *
 * **DD-10 (registry-down → cached roster + warn).** When the registry is
 * unreachable at boot, federation must NOT be silently torn down: the stack
 * falls back to the last verified descriptor + roster it cached. S2's
 * config-load peer resolver reads this via {@link NetworkCache.load} when a
 * live fetch fails; S1 writes it via {@link NetworkCache.store} — but ONLY
 * after the response signature verified against the pinned registry pubkey
 * (DD-9). An unverified response is never cached, so the cache is a trust
 * extension of the pin, not a bypass of it.
 *
 * Path convention: one JSON file per network under a cache dir, default
 * `~/.config/cortex/network-cache/` (matches the `~/.config/cortex/` stack
 * config dir convention used across the CLIs). The dir + filename are
 * injectable so tests use a tmp dir and never touch a real home directory.
 *
 * Failure handling (CLAUDE.md: NEVER empty catch): every read/write error is
 * logged via `logError` (defaults to stderr) and turned into a negative
 * return — a missing/corrupt cache file degrades to "no cache", never a throw.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

import type { NetworkDescriptor, NetworkRosterResult } from "./types";

/** Default cache dir — sibling of `~/.config/cortex/cortex.yaml`. */
const DEFAULT_CACHE_DIR = join(homedir(), ".config", "cortex", "network-cache");

/** Schema version stamped into each cache file so a future shape change can
 *  detect + discard stale entries rather than mis-parsing them. */
const CACHE_SCHEMA_VERSION = 1 as const;

/**
 * Base64 raw ed25519 pubkey grammar (44 chars incl. `=` padding) — the SAME
 * gate `network-client.parseRoster` applies before a roster is trusted. PR #818
 * review NIT-5 (defense-in-depth): a cache record is only written AFTER
 * signature verification (DD-9), so a poisoned file implies local-disk tamper —
 * but the on-disk reader must not be a softer gate than the network reader, lest
 * a future cache consumer inherit an ungated (malformed/poison) pubkey. We apply
 * the identical grammar to cached roster members on load.
 */
const BASE64_ED25519 = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The on-disk record for one network: the last verified descriptor + roster,
 * plus the time they were cached. Both halves are written together so a reader
 * always gets a consistent pair (descriptor + its matching roster).
 */
export interface CachedNetwork {
  schema_version: typeof CACHE_SCHEMA_VERSION;
  /** ISO-8601 time this record was written (i.e. last verified). */
  cached_at: string;
  descriptor: NetworkDescriptor;
  roster: NetworkRosterResult;
}

/** Construction options for {@link NetworkCache}. */
export interface NetworkCacheOptions {
  /**
   * Directory cache files live under. Defaults to
   * `~/.config/cortex/network-cache/`. Tests pass a tmp dir.
   */
  cacheDir?: string;
  /**
   * Logger seam — defaults to `process.stderr.write` (CLAUDE.md "no empty
   * catches"). Tests inject a spy / no-op.
   */
  logError?: (msg: string) => void;
}

/**
 * Last-known-good disk cache for network descriptors + rosters. One file per
 * network. Construct once; call `store()` after a verified fetch and `load()`
 * on the registry-down fallback path (S2).
 */
export class NetworkCache {
  private readonly cacheDir: string;
  private readonly logError: (msg: string) => void;

  constructor(options: NetworkCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.logError =
      options.logError ??
      ((msg: string) => {
        process.stderr.write(`network-cache: ${msg}\n`);
      });
  }

  /**
   * Persist a verified descriptor + roster for `networkId`. Call ONLY after
   * the responses verified against the pinned registry pubkey (DD-9) — this
   * method does NOT verify, it only writes. Returns `true` on success,
   * `false` (with a log line) on any I/O error; a cache-write failure must
   * not fail the calling fetch (the live data is already in hand).
   */
  store(
    networkId: string,
    descriptor: NetworkDescriptor,
    roster: NetworkRosterResult,
  ): boolean {
    const record: CachedNetwork = {
      schema_version: CACHE_SCHEMA_VERSION,
      cached_at: new Date().toISOString(),
      descriptor,
      roster,
    };
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      // Pretty-print: these files are human-inspectable during ops triage of
      // a registry outage, and the size is trivial (a handful of peers).
      writeFileSync(this.pathFor(networkId), JSON.stringify(record, null, 2), {
        encoding: "utf8",
      });
      return true;
    } catch (err) {
      this.logError(
        `store(${networkId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Load the last-known-good cached record for `networkId`, or `undefined` if
   * there is no cache file, it cannot be read, it is not valid JSON, or it
   * fails the structural shape check. NEVER throws — a corrupt cache degrades
   * to "no cache" so the caller falls through to its no-cache path rather
   * than crashing on a poison file.
   */
  load(networkId: string): CachedNetwork | undefined {
    return this.readRecordAt(this.pathFor(networkId), networkId, `load(${networkId})`);
  }

  /**
   * Read + parse + shape-validate the cache file at an EXPLICIT `path`, checking
   * its `network_id` against `expectedNetworkId`. NEVER throws — every failure
   * (missing file, unreadable, bad JSON, failed shape/version/swap guard) logs
   * and returns `undefined` (fail-closed). `label` prefixes the log line.
   *
   * Reading by explicit path (rather than re-deriving via {@link pathFor}) is
   * what lets {@link list} enumerate every on-disk file faithfully: `pathFor`
   * SANITIZES its argument (`[^a-z0-9-] → _`), so round-tripping a non-canonical
   * filename (`Foo.json`, `a.b.json`) through it would resolve to a DIFFERENT
   * path and silently miss the real file. `list` reads the actual entry directly
   * and passes the basename as the expected id so the swap guard still fires.
   */
  private readRecordAt(
    path: string,
    expectedNetworkId: string,
    label: string,
  ): CachedNetwork | undefined {
    let text: string;
    try {
      text = readFileSync(path, { encoding: "utf8" });
    } catch (err) {
      // ENOENT is the common, expected case (no cache yet) — log at the same
      // fidelity as other misses so a silent "why is there no cache" is still
      // observable, but it is not an error condition for the caller. Any other
      // read failure (permissions, a dangling/broken symlink → ENOENT/ELOOP, a
      // directory in the entry slot → EISDIR) also degrades to a drop, never a
      // throw.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        this.logError(
          `${label} read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.logError(
        `${label} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }

    if (!isCachedNetwork(parsed, expectedNetworkId)) {
      this.logError(
        `${label} cache file failed shape/version check; ignoring`,
      );
      return undefined;
    }
    return parsed;
  }

  /**
   * Enumerate EVERY valid cached record under the cache dir (#850). One file
   * per network; each `*.json` entry is read DIRECTLY at its actual path and
   * shape-checked the same way {@link load} validates a single record (so a
   * corrupt/poison file is dropped, not surfaced). The expected `network_id`
   * for the swap guard is the file's basename — but we read the file at its real
   * `join(cacheDir, entry)` path rather than re-deriving it via {@link pathFor}.
   * `pathFor` SANITIZES its argument, so round-tripping a non-canonical filename
   * (`Foo.json`, `a.b.json`) through `load` would resolve to a DIFFERENT path
   * and silently miss the file; reading the entry directly enumerates it
   * faithfully, and the swap guard then drops it if its `network_id` does not
   * match the basename (fail-closed). A missing cache dir degrades to `[]` (no
   * cache yet), never a throw — symmetric with `load`.
   *
   * This is the read `cortex network status` uses to surface `registered`
   * networks (descriptor cached but not in this stack's config). It does NOT
   * verify signatures — a record is only ever WRITTEN after DD-9 verification
   * (see `store`), so enumeration is a trust extension of that write-time gate.
   */
  list(): CachedNetwork[] {
    let entries: string[];
    try {
      entries = readdirSync(this.cacheDir);
    } catch (err) {
      // ENOENT is the common, expected case (no cache dir yet) — degrade to no
      // cache. Any other error (permissions, not-a-dir) is logged but still
      // degrades to "no cache" so a status read never crashes on a bad dir.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        this.logError(
          `list() readdir failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [];
    }

    const records: CachedNetwork[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      // Read the ACTUAL file (no pathFor round-trip — see jsdoc). The basename is
      // the expected `network_id` for the swap guard; a file whose record names a
      // different network (or fails shape/version) is dropped fail-closed.
      const expectedNetworkId = basename(entry, ".json");
      const record = this.readRecordAt(
        join(this.cacheDir, entry),
        expectedNetworkId,
        `list(${entry})`,
      );
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  /** Absolute path to the cache file for `networkId`. */
  private pathFor(networkId: string): string {
    // `networkId` is letter-prefixed lowercase-alphanumeric + hyphen per the
    // schema grammar, so it is filesystem-safe as a bare filename. Defend
    // anyway: a path separator would let a malformed id escape the cache dir.
    const safe = networkId.replace(/[^a-z0-9-]/g, "_");
    return join(this.cacheDir, `${safe}.json`);
  }
}

/**
 * Structural guard for a parsed cache file. Checks the schema version, the
 * descriptor/roster shape, and that the cached `network_id` matches the id we
 * loaded under — a swapped file (descriptor for a different network) is
 * treated as corrupt.
 */
function isCachedNetwork(value: unknown, networkId: string): value is CachedNetwork {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== CACHE_SCHEMA_VERSION) return false;
  if (typeof v.cached_at !== "string") return false;

  const descriptor = v.descriptor;
  if (descriptor === null || typeof descriptor !== "object") return false;
  const d = descriptor as Record<string, unknown>;
  if (
    d.network_id !== networkId ||
    typeof d.hub_url !== "string" ||
    typeof d.leaf_port !== "number" ||
    !Array.isArray(d.members)
  ) {
    return false;
  }

  const roster = v.roster;
  if (roster === null || typeof roster !== "object") return false;
  const r = roster as Record<string, unknown>;
  if (r.network_id !== networkId || !Array.isArray(r.members)) return false;

  // PR #818 review NIT-5 — grammar-gate each cached roster member's pubkey with
  // the SAME `BASE64_ED25519` regex `parseRoster` applies on the network path. A
  // member with a missing/non-string/malformed `principal_pubkey` taints the
  // whole record (consistent with parseRoster rejecting the whole roster), so
  // the cache file is treated as corrupt and ignored rather than serving a
  // poison key to a future consumer.
  for (const member of r.members) {
    if (member === null || typeof member !== "object") return false;
    const m = member as Record<string, unknown>;
    if (typeof m.principal_id !== "string") return false;
    if (typeof m.principal_pubkey !== "string") return false;
    if (!BASE64_ED25519.test(m.principal_pubkey)) return false;
  }

  return true;
}
