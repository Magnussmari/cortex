/**
 * Shared database utilities for consistent SQLite initialization.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

/**
 * Initialize a SQLite database with standard configuration.
 * Creates parent directories if needed, enables WAL mode, and sets busy timeout.
 *
 * @param dbPath - Absolute path to the database file
 * @returns Initialized Database instance
 */
export function initDatabase(dbPath: string): Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    // TC-4b (cortex#637): runner SQLite dir holds session + worklog rows
    // (prompts, commands) — owner-only (0o700), never world-readable.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}
