import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA_VERSION, getMeta, openIndex, readSchemaVersion, setMeta } from "./db.ts";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "ss-db-")), "nested", "index.sqlite");
}

test("openIndex creates the file, its parent, and the schema", () => {
  const path = tempDb();
  const db = openIndex(path);
  assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all()
    .map((row: any) => row.name);
  for (const name of ["entries", "evidence", "files", "meta", "prose"]) {
    assert.ok(tables.includes(name), `missing ${name}`);
  }
  assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  db.close();
});

test("reopening keeps the data", () => {
  const path = tempDb();
  const first = openIndex(path);
  setMeta(first, "probe", "kept");
  first.close();
  const second = openIndex(path);
  assert.equal(getMeta(second, "probe"), "kept");
  second.close();
});

test("a stale schema version rebuilds the database", () => {
  const path = tempDb();
  const first = openIndex(path);
  first.exec(
    "INSERT INTO files(path, session_id, cwd, bytes_indexed, size, mtime_ms) VALUES('/a','a','/w',0,0,0)",
  );
  setMeta(first, "schema_version", "0");
  first.close();

  const second = openIndex(path);
  assert.equal(readSchemaVersion(second), SCHEMA_VERSION);
  assert.equal(second.prepare("SELECT count(*) AS n FROM files").get()!.n, 0);
  second.close();
});

test("prose is external-content: text lives in entries and snippet() still works", () => {
  const db = openIndex(tempDb());
  db.exec(
    "INSERT INTO files(path, session_id, cwd, bytes_indexed, size, mtime_ms) VALUES('/a','a','/w',0,0,0)",
  );
  db.exec(
    "INSERT INTO entries(path, entry_id, parent_id, kind, role, ts, text) " +
      "VALUES('/a','e1',NULL,'message','user','2026-08-01T00:00:00.000Z','ripgrep versus sqlite for searching sessions')",
  );
  const rowid = db.prepare("SELECT rowid FROM entries").get()!.rowid as number;
  db.prepare("INSERT INTO prose(rowid, text) VALUES(?, ?)").run(
    rowid,
    "ripgrep versus sqlite for searching sessions",
  );

  const hit = db
    .prepare("SELECT snippet(prose, 0, '[', ']', '…', 6) AS snip FROM prose WHERE prose MATCH 'sqlite'")
    .get()!;
  assert.match(String(hit.snip), /\[sqlite\]/);
  db.close();
});
