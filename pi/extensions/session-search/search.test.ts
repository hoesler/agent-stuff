import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openIndex } from "./db.ts";
import { type FixtureSession, writeSession } from "./fixtures.ts";
import { refreshIndex } from "./ingest.ts";
import { parseWhen, readEntries, resolveSession, searchIndex } from "./search.ts";

const OPTIONS = { maxSnippetChars: 240 };

function indexed(sessions: FixtureSession[]) {
  const root = mkdtempSync(join(tmpdir(), "ss-search-"));
  const db = openIndex(join(root, "index.sqlite"));
  const dir = join(root, "sessions");
  for (const session of sessions) writeSession(dir, session);
  refreshIndex(db, {
    sessionsDir: dir,
    budgetBytes: 1 << 30,
    includeThinking: false,
    excludeCwd: [],
  });
  return db;
}

const PARENT: FixtureSession = {
  path: "--work-repo--/a.jsonl",
  id: "aaa",
  cwd: "/work/repo",
  created: "2026-07-14T09:00:00.000Z",
  entries: [
    {
      id: "e1",
      parentId: null,
      role: "user",
      text: "convinced that ripgrep might be problematic because of JSON",
      timestamp: "2026-07-14T10:00:00.000Z",
    },
    {
      id: "e2",
      parentId: "e1",
      role: "assistant",
      text: "sqlite fts5 gives snippets",
      timestamp: "2026-07-14T10:01:00.000Z",
    },
    {
      id: "e3",
      parentId: "e2",
      role: "assistant",
      toolCalls: [{ name: "write", arguments: { file_path: "/work/repo/src/auth.ts" } }],
      timestamp: "2026-07-14T10:02:00.000Z",
    },
    {
      id: "e4",
      parentId: "e3",
      bash: { command: "npm run migrate -- --latest", output: "done" },
      timestamp: "2026-07-14T10:03:00.000Z",
    },
  ],
};

/** A fork: the same entry ids copied verbatim, plus its own continuation. */
const FORK: FixtureSession = {
  path: "--work-repo--/b.jsonl",
  id: "bbb",
  cwd: "/work/repo",
  created: "2026-07-20T09:00:00.000Z",
  parentSession: "--work-repo--/a.jsonl",
  entries: [
    ...PARENT.entries,
    {
      id: "k1",
      parentId: "e4",
      role: "user",
      text: "carrying on here",
      timestamp: "2026-07-20T10:00:00.000Z",
    },
  ],
};

const OTHER: FixtureSession = {
  path: "--other-proj--/c.jsonl",
  id: "ccc",
  cwd: "/other/proj",
  created: "2026-08-01T09:00:00.000Z",
  entries: [
    {
      id: "n1",
      parentId: null,
      type: "session_info",
      name: "Ripgrep versus sqlite",
      timestamp: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "n2",
      parentId: "n1",
      role: "user",
      text: "unrelated ripgrep talk",
      timestamp: "2026-08-01T10:01:00.000Z",
    },
  ],
};

test("a prose query returns a snippet, the session id, and the entry id", () => {
  const results = searchIndex(indexed([PARENT]), { query: "ripgrep", limit: 10 }, OPTIONS);
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "aaa");
  assert.equal(results[0].entryId, "e1");
  assert.equal(results[0].cwd, "/work/repo");
  assert.match(results[0].snippet!, /ripgrep/i);
});

test("FTS5 syntax works and a malformed query is reported, not thrown as sqlite noise", () => {
  const db = indexed([PARENT]);
  assert.equal(searchIndex(db, { query: '"might be problematic"', limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { query: "ripg*", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { query: "ripgrep NOT JSON", limit: 10 }, OPTIONS).length, 0);
  assert.throws(() => searchIndex(db, { query: '"unbalanced', limit: 10 }, OPTIONS), /invalid query/i);
});

test("an empty filter set is refused", () => {
  assert.throws(() => searchIndex(indexed([PARENT]), { limit: 10 }, OPTIONS), /at least one of/i);
});

test("touched and action select on evidence, and command searches shell commands", () => {
  const db = indexed([PARENT]);
  assert.equal(searchIndex(db, { touched: "**/auth.ts", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { touched: "**/auth.ts", action: "write", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { touched: "**/auth.ts", action: "read", limit: 10 }, OPTIONS).length, 0);
  assert.equal(searchIndex(db, { command: "migrate", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { command: "1000 rows", limit: 10 }, OPTIONS).length, 0);
});

/** Shares a path prefix with `/work/repo` without being inside it. */
const SIBLING: FixtureSession = {
  path: "--work-repo-old--/e.jsonl",
  id: "eee",
  cwd: "/work/repo-old",
  created: "2026-07-10T09:00:00.000Z",
  entries: [
    { id: "s1", parentId: null, role: "user", text: "ripgrep in the old checkout", timestamp: "2026-07-10T10:00:00.000Z" },
  ],
};

/** A session started below the repository root, in a subdirectory. */
const NESTED: FixtureSession = {
  path: "--work-repo-packages-api--/f.jsonl",
  id: "fff",
  cwd: "/work/repo/packages/api",
  created: "2026-07-11T09:00:00.000Z",
  entries: [
    { id: "p1", parentId: null, role: "user", text: "ripgrep in the api package", timestamp: "2026-07-11T10:00:00.000Z" },
  ],
};

test("scope, role, and date filters narrow the result set", () => {
  const db = indexed([PARENT, OTHER]);
  // Three hits: two user messages and the session name, which is prose too.
  assert.equal(searchIndex(db, { query: "ripgrep", limit: 10 }, OPTIONS).length, 3);
  assert.equal(
    searchIndex(db, { query: "ripgrep", scope: { kind: "glob", pattern: "/work/**" }, limit: 10 }, OPTIONS).length,
    1,
  );
  assert.equal(searchIndex(db, { query: "ripgrep", role: "user", limit: 10 }, OPTIONS).length, 2);
  assert.equal(searchIndex(db, { query: "snippets", role: "user", limit: 10 }, OPTIONS).length, 0);
  assert.equal(searchIndex(db, { query: "ripgrep", after: "2026-07-20", limit: 10 }, OPTIONS).length, 2);
  assert.equal(searchIndex(db, { query: "ripgrep", before: "2026-07-20", limit: 10 }, OPTIONS).length, 1);
});

test("a roots scope takes the directory and everything below it, but not a sibling sharing its prefix", () => {
  const db = indexed([PARENT, NESTED, SIBLING, OTHER]);
  const scoped = searchIndex(db, { query: "ripgrep", scope: { kind: "roots", roots: ["/work/repo"] }, limit: 10 }, OPTIONS);
  assert.deepEqual(
    scoped.map((result) => result.sessionId).sort(),
    ["aaa", "fff"],
  );
});

test("a roots scope spans several worktrees at once", () => {
  const db = indexed([PARENT, SIBLING, OTHER]);
  const scoped = searchIndex(
    db,
    { query: "ripgrep", scope: { kind: "roots", roots: ["/work/repo", "/work/repo-old"] }, limit: 10 },
    OPTIONS,
  );
  assert.deepEqual(
    scoped.map((result) => result.sessionId).sort(),
    ["aaa", "eee"],
  );
});

test("a paths scope selects exactly the named session files", () => {
  const db = indexed([PARENT, OTHER]);
  const parentPath = resolveSession(db, "aaa")!;
  const scoped = searchIndex(db, { query: "ripgrep", scope: { kind: "paths", paths: [parentPath] }, limit: 10 }, OPTIONS);
  assert.deepEqual(
    scoped.map((result) => result.sessionId),
    ["aaa"],
  );
  assert.equal(
    searchIndex(db, { query: "ripgrep", scope: { kind: "paths", paths: [] }, limit: 10 }, OPTIONS).length,
    0,
  );
});

test("a fork sharing entry ids produces one result, attributed to the origin", () => {
  const results = searchIndex(indexed([PARENT, FORK]), { query: "ripgrep", limit: 10 }, OPTIONS);
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "aaa");
  assert.deepEqual(
    results[0].continuations.map((continuation) => continuation.sessionId),
    ["bbb"],
  );
});

test("a session name is carried on the result", () => {
  const results = searchIndex(indexed([OTHER]), { query: "unrelated", limit: 10 }, OPTIONS);
  assert.equal(results[0].name, "Ripgrep versus sqlite");
});

test("branch classification rides along on each hit", () => {
  const branched: FixtureSession = {
    path: "--work-repo--/d.jsonl",
    id: "ddd",
    cwd: "/work/repo",
    created: "2026-07-14T09:00:00.000Z",
    entries: [
      { id: "e1", parentId: null, role: "user", text: "shared opening", timestamp: "2026-07-14T10:00:00.000Z" },
      {
        id: "f1",
        parentId: "e1",
        role: "user",
        text: "abandoned duckdb attempt",
        timestamp: "2026-07-14T10:01:00.000Z",
      },
      {
        id: "f2",
        parentId: "f1",
        role: "assistant",
        text: "more of the abandoned path",
        timestamp: "2026-07-14T10:02:00.000Z",
      },
      {
        id: "e2",
        parentId: "e1",
        role: "assistant",
        text: "the path that continued",
        timestamp: "2026-07-14T11:00:00.000Z",
      },
    ],
  };
  const db = indexed([branched]);
  const side = searchIndex(db, { query: "abandoned", limit: 10 }, OPTIONS)[0];
  assert.equal(side.branch.onMainLine, false);
  assert.equal(side.branch.leafId, "f2");
  assert.equal(side.branch.entriesPastDivergence, 2);
  const main = searchIndex(db, { query: "continued", limit: 10 }, OPTIONS)[0];
  assert.equal(main.branch.onMainLine, true);
});

test("parseWhen accepts ISO dates and relative shorthand", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  assert.equal(parseWhen("2026-07-14", now), "2026-07-14T00:00:00.000Z");
  assert.equal(parseWhen("14d", now), "2026-07-30T12:00:00.000Z");
  assert.equal(parseWhen("2w", now), "2026-07-30T12:00:00.000Z");
  assert.equal(parseWhen("6h", now), "2026-08-13T06:00:00.000Z");
  assert.equal(parseWhen("garbage", now), undefined);
});

test("resolveSession accepts an id, an id prefix, or a path; readEntries returns dialogue in order", () => {
  const db = indexed([PARENT]);
  const path = resolveSession(db, "aaa")!;
  assert.equal(resolveSession(db, path), path);
  assert.equal(resolveSession(db, "aa"), path);
  assert.equal(resolveSession(db, "zzz"), undefined);

  const around = readEntries(db, { path, mode: "around", entryId: "e2", radius: 1 });
  assert.deepEqual(
    around.map((entry) => entry.entryId),
    ["e1", "e2", "e3"],
  );

  const branch = readEntries(db, { path, mode: "branch", leafId: "e4" });
  assert.deepEqual(
    branch.map((entry) => entry.entryId),
    ["e1", "e2", "e3", "e4"],
  );

  const last = readEntries(db, { path, mode: "last", count: 2 });
  assert.deepEqual(
    last.map((entry) => entry.entryId),
    ["e3", "e4"],
  );
  assert.deepEqual(last[1].evidence, [
    { tool: "bash", action: "run", target: "npm run migrate -- --latest" },
  ]);
});
