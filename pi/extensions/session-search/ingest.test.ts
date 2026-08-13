import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openIndex } from "./db.ts";
import { type FixtureSession, appendEntries, appendPartial, writeSession } from "./fixtures.ts";
import { refreshIndex } from "./ingest.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ss-ingest-"));
  const db = openIndex(join(root, "index.sqlite"));
  const sessions = join(root, "sessions");
  return {
    db,
    sessions,
    options: {
      sessionsDir: sessions,
      budgetBytes: 1 << 30,
      includeThinking: false,
      excludeCwd: [] as string[],
    },
  };
}

const BASIC: FixtureSession = {
  path: "--work-repo--/a.jsonl",
  id: "aaa",
  cwd: "/work/repo",
  entries: [
    { id: "e1", parentId: null, role: "user", text: "why not duckdb" },
    {
      id: "e2",
      parentId: "e1",
      role: "assistant",
      text: "its fts index does not refresh",
      toolCalls: [{ name: "read", arguments: { file_path: "/work/repo/auth.ts" } }],
    },
    { id: "e3", parentId: "e2", toolResult: { toolName: "read", text: "the whole file body" } },
  ],
};

test("ingesting twice yields the same row count", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, BASIC);
  const first = refreshIndex(db, options);
  const before = db.prepare("SELECT count(*) AS n FROM entries").get()!.n;
  assert.equal(first.entriesInserted, 3);
  assert.equal(before, 3);

  const second = refreshIndex(db, options);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries").get()!.n, before);
  assert.equal(second.filesIngested, 0);
});

test("appending and refreshing reads only the new entries", () => {
  const { db, sessions, options } = setup();
  const path = writeSession(sessions, BASIC);
  refreshIndex(db, options);
  appendEntries(path, [{ id: "e4", parentId: "e3", role: "assistant", text: "sqlite it is" }]);

  const stats = refreshIndex(db, options);
  assert.equal(stats.entriesInserted, 1);
  assert.ok(stats.bytesRead > 0 && stats.bytesRead < 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries").get()!.n, 4);
});

test("a file ending mid-line leaves the partial line for the next pass", () => {
  const { db, sessions, options } = setup();
  const path = writeSession(sessions, BASIC);
  refreshIndex(db, options);
  appendPartial(path, { id: "e4", parentId: "e3", role: "user", text: "half written" });

  assert.equal(refreshIndex(db, options).entriesInserted, 0);
  appendEntries(path, []); // closes the record with a newline
  assert.equal(refreshIndex(db, options).entriesInserted, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries WHERE entry_id = 'e4'").get()!.n, 1);
});

test("a rewritten file is detected and re-ingested", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, BASIC);
  refreshIndex(db, options);
  writeSession(sessions, {
    ...BASIC,
    entries: [{ id: "z1", parentId: null, role: "user", text: "entirely different" }],
  });

  refreshIndex(db, options);
  const ids = db
    .prepare("SELECT entry_id FROM entries ORDER BY entry_id")
    .all()
    .map((row: any) => row.entry_id);
  assert.deepEqual(ids, ["z1"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose").get()!.n, 1);
});

test("prose excludes tool results, bash output, and thinking; evidence records the right action", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, {
    ...BASIC,
    entries: [
      ...BASIC.entries,
      { id: "e4", parentId: "e3", role: "assistant", thinking: "secretly reasoning", text: "done" },
      { id: "e5", parentId: "e4", bash: { command: "npm run migrate", output: "1000 rows migrated" } },
      {
        id: "e6",
        parentId: "e5",
        role: "assistant",
        toolCalls: [{ name: "edit", arguments: { path: "/work/repo/auth.ts" } }],
      },
    ],
  });
  refreshIndex(db, options);

  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'whole'").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'migrated'").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'secretly'").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'duckdb'").get()!.n, 1);

  const evidence = db
    .prepare("SELECT tool, action, target FROM evidence ORDER BY rowid")
    .all()
    .map((row: any) => ({ tool: row.tool, action: row.action, target: row.target }));
  assert.deepEqual(evidence, [
    { tool: "read", action: "read", target: "/work/repo/auth.ts" },
    { tool: "bash", action: "run", target: "npm run migrate" },
    { tool: "edit", action: "write", target: "/work/repo/auth.ts" },
  ]);
});

test("includeThinking puts thinking into prose", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, {
    ...BASIC,
    entries: [{ id: "e1", parentId: null, role: "assistant", thinking: "secretly reasoning", text: "done" }],
  });
  refreshIndex(db, { ...options, includeThinking: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'secretly'").get()!.n, 1);
});

test("an unparseable line is skipped, counted, and does not wedge the file", () => {
  const { db, sessions, options } = setup();
  const path = writeSession(sessions, BASIC);
  appendFileSync(path, "{ not json\n");
  appendEntries(path, [{ id: "e9", parentId: "e3", role: "user", text: "still indexed" }]);

  const stats = refreshIndex(db, options);
  assert.equal(stats.skippedLines, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries WHERE entry_id = 'e9'").get()!.n, 1);
});

test("a refresh over the byte budget stops and reports the backlog", () => {
  const { db, sessions, options } = setup();
  for (let index = 0; index < 5; index += 1) {
    writeSession(sessions, {
      path: `--work-repo--/s${index}.jsonl`,
      id: `s${index}`,
      cwd: "/work/repo",
      created: `2026-08-0${index + 1}T00:00:00.000Z`,
      entries: [{ id: "e1", parentId: null, role: "user", text: `session number ${index}` }],
    });
  }
  const stats = refreshIndex(db, { ...options, budgetBytes: 1 });
  assert.equal(stats.filesIngested, 1);
  assert.ok(stats.remainingFiles >= 4);
  assert.ok(stats.remainingBytes > 0);
});

test("excludeCwd skips a project directory entirely", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, BASIC);
  refreshIndex(db, { ...options, excludeCwd: ["/work/**"] });
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries").get()!.n, 0);

  // And it stays skipped without re-reading on the next pass.
  const second = refreshIndex(db, { ...options, excludeCwd: ["/work/**"] });
  assert.equal(second.bytesRead, 0);
});

test("a missing sessions directory is not an error", () => {
  const { db, options } = setup();
  const stats = refreshIndex(db, { ...options, sessionsDir: join(tmpdir(), "ss-absent-dir") });
  assert.equal(stats.filesIngested, 0);
  assert.equal(stats.entriesInserted, 0);
});
