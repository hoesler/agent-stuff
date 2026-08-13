/**
 * The index database.
 *
 * It stores nothing that is not reconstructible from the session JSONL, so it
 * is a cache and not a second source of truth. Deleting it costs one rebuild.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Bump on any schema change: a mismatch rebuilds the index from the JSONL. */
export const SCHEMA_VERSION = 1;

/**
 * `prose` is an external-content FTS5 table: it reads text back out of
 * `entries` by rowid, so prose is stored once and `snippet()` still works. A
 * contentless table would store less but forbid snippets.
 *
 * Every entry gets a row in `entries`, including those with no prose, because
 * branch resolution walks `parent_id` to the root and a gap would silently
 * misplace a hit on the wrong branch.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  session_id    TEXT,
  cwd           TEXT,
  parent_path   TEXT,
  created       TEXT,
  bytes_indexed INTEGER NOT NULL DEFAULT 0,
  size          INTEGER NOT NULL DEFAULT 0,
  mtime_ms      INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  rowid     INTEGER PRIMARY KEY,
  path      TEXT NOT NULL,
  entry_id  TEXT NOT NULL,
  parent_id TEXT,
  kind      TEXT NOT NULL,
  role      TEXT,
  ts        TEXT,
  text      TEXT,
  UNIQUE(path, entry_id)
);

CREATE INDEX IF NOT EXISTS entries_by_path ON entries(path);
CREATE INDEX IF NOT EXISTS entries_by_entry_id ON entries(entry_id);

CREATE VIRTUAL TABLE IF NOT EXISTS prose USING fts5(
  text,
  content='entries',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS evidence (
  entry_rowid INTEGER NOT NULL,
  tool        TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT
);

CREATE INDEX IF NOT EXISTS evidence_by_entry ON evidence(entry_rowid);
`;

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function readSchemaVersion(db: DatabaseSync): number | undefined {
  const raw = getMeta(db, "schema_version");
  if (raw === undefined) return undefined;
  const version = Number(raw);
  return Number.isFinite(version) ? version : undefined;
}

export function applySchema(db: DatabaseSync): void {
  db.exec(DDL);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
}

/** Drop everything and start over. `prose` goes first: it reads `entries`. */
export function resetIndex(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS prose");
  db.exec("DROP TABLE IF EXISTS evidence");
  db.exec("DROP TABLE IF EXISTS entries");
  db.exec("DROP TABLE IF EXISTS files");
  db.exec("DROP TABLE IF EXISTS meta");
  applySchema(db);
}

/**
 * Open (creating if needed) the index.
 *
 * WAL and a busy timeout because pi runs in many windows across many project
 * directories, and each refreshes the index at query time. `foreign_keys` stays
 * off deliberately: `entries.path` and `evidence.entry_rowid` are logical
 * references, the per-file drop in `ingest.ts` deletes in dependency order
 * itself, and real constraints would only add per-row cost to bulk ingest.
 */
export function openIndex(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = OFF");

  const version = readSchemaVersion(db);
  if (version === undefined) applySchema(db);
  else if (version !== SCHEMA_VERSION) resetIndex(db);

  // The index aggregates content from every project the user has worked in.
  chmodSync(dbPath, 0o600);
  return db;
}
