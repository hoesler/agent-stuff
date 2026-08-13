# Session Search Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension that finds a past conversation — across every project, session, and fork — through a SQLite FTS5 index over session JSONL that refreshes itself from file tails at query time.

**Architecture:** Ten modules under `pi/extensions/session-search/`. `index.ts` is the only file that imports pi: it registers two tools and one command. Everything else is either pure (`extract`, `tree`, `lineage`, `render`, parts of `scan`/`search`) or talks only to `node:sqlite` and `node:fs`, so tests run under `node --test` with real temp databases and real JSONL fixtures — nothing mocked.

**Tech Stack:** TypeScript (type-checked only, never emitted — pi loads `.ts` directly), `node:sqlite` (`DatabaseSync`, synchronous, built into Node — verified with FTS5 + `snippet()` + `bm25()` on Node 26.5), `node:test` + `node:assert/strict`, `typebox` (tool parameter schemas), `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `getAgentDir`).

Spec: `docs/superpowers/specs/2026-08-13-session-search-design.md`

## Global Constraints

- **Two-space indentation, double quotes, trailing commas** — match `pi/extensions/session-title/`, not `subagent/` (which uses tabs).
- **Imports of local modules use the `.ts` extension** (`./types.ts`) — `allowImportingTsExtensions` is on and pi loads TypeScript directly.
- **No new runtime dependencies.** `node:sqlite` is built in; `typebox` and the `@earendil-works/*` packages are already available to extensions.
- **Every module except `index.ts` must import nothing from pi**, not even types. Session entries are read structurally from plain objects, as `session-title/transcript.ts` does.
- **`node:sqlite` is synchronous.** No `await` around database work. Tool `execute` is `async` because pi's signature requires it, not because the index is.
- **Config key names are exact:** `version`, `dbPath`, `sessionsDir`, `includeThinking`, `refreshBudgetBytes`, `excludeCwd`, `maxSnippetChars`.
- **Tool names are exactly `session_search` and `session_read`; the command is exactly `session-index`.**
- **The extension must work with no config file at all.** A missing config is defaults, never an error.
- **Nothing throws out of a tool call.** Every failure path returns a result that says what happened (see the spec's "Failure behavior").
- **Verification after every task:** `npm run typecheck` and `npm test` from the repo root must both pass.
- **`thurstonsand/pi-sessions` is prior art for the SQLite-index approach** and gets attribution in the extension `README.md` (Task 11).

## Deviation from the spec, recorded

The spec describes fork-family resolution as a `WITH RECURSIVE` CTE. This plan walks `files.parent_path` in memory in `lineage.ts` instead: the whole table is ~541 rows, the walk is the same walk, and a pure function is testable with literals where a CTE is not. The behavior the spec specifies — group by family root, dedup on `entry_id`, prefer the origin file — is unchanged.

---

### Task 1: Scaffolding, types, and config

**Files:**
- Create: `pi/extensions/session-search/tsconfig.json`
- Create: `pi/extensions/session-search/types.ts`
- Create: `pi/extensions/session-search/config.ts`
- Test: `pi/extensions/session-search/config.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionSearchConfig`, `ConfigError`, `ConfigSnapshot`, `DEFAULTS` from `types.ts`; `resolveConfigPaths(options)`, `defaultConfig(agentDir)`, `parseOverride(value)`, `SessionSearchConfigLoader` from `config.ts`.

- [ ] **Step 1: Create the per-extension tsconfig**

`pi/extensions/session-search/tsconfig.json` — byte-identical to `pi/extensions/session-title/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["./**/*.ts"]
}
```

- [ ] **Step 2: Write `types.ts`**

No test — types and constants only.

```ts
/**
 * A fully resolved configuration. Every field has a value: the extension works
 * with no config file at all, so parsing never produces a partial config that
 * the rest of the code has to defend against.
 */
export interface SessionSearchConfig {
  version: 1;
  /** SQLite index location. */
  dbPath: string;
  /** Root of pi's per-project session directories. */
  sessionsDir: string;
  /** Index assistant `thinking` blocks as prose. */
  includeThinking: boolean;
  /** Ceiling on bytes read by one inline refresh. */
  refreshBudgetBytes: number;
  /** Globs of session working directories to skip. */
  excludeCwd: string[];
  /** Per-result snippet cap, in characters. */
  maxSnippetChars: number;
}

export const DEFAULTS = {
  includeThinking: false,
  refreshBudgetBytes: 33554432,
  excludeCwd: [] as string[],
  maxSnippetChars: 240,
} as const;

export interface ConfigError {
  path: string;
  message: string;
}

/**
 * A snapshot always carries a usable config. Errors are reported alongside it
 * rather than swallowed or thrown: a typo in one field must not take searching
 * away, but it must not be silent either.
 */
export interface ConfigSnapshot {
  config: SessionSearchConfig;
  paths: string[];
  fingerprint: string;
  errors: ConfigError[];
}
```

- [ ] **Step 3: Write the failing config tests**

`pi/extensions/session-search/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SessionSearchConfigLoader,
  defaultConfig,
  parseOverride,
  resolveConfigPaths,
} from "./config.ts";

test("defaults derive both paths from the agent dir", () => {
  const config = defaultConfig("/agent");
  assert.equal(config.dbPath, join("/agent", "session-search", "index.sqlite"));
  assert.equal(config.sessionsDir, join("/agent", "sessions"));
  assert.equal(config.includeThinking, false);
  assert.equal(config.refreshBudgetBytes, 33554432);
  assert.deepEqual(config.excludeCwd, []);
  assert.equal(config.maxSnippetChars, 240);
});

test("config paths: global first, project second, env replaces both", () => {
  assert.deepEqual(
    resolveConfigPaths({ envPath: undefined, startupCwd: "/work", agentDir: "/agent", projectTrusted: true }),
    [join("/agent", "session-search.json"), join("/work", ".pi", "session-search.json")],
  );
  assert.deepEqual(
    resolveConfigPaths({ envPath: undefined, startupCwd: "/work", agentDir: "/agent", projectTrusted: false }),
    [join("/agent", "session-search.json")],
  );
  assert.deepEqual(
    resolveConfigPaths({ envPath: "cfg.json", startupCwd: "/work", agentDir: "/agent", projectTrusted: true }),
    [join("/work", "cfg.json")],
  );
});

test("parseOverride accepts a partial file and rejects bad values", () => {
  assert.deepEqual(parseOverride({ includeThinking: true }), { includeThinking: true });
  assert.deepEqual(parseOverride({ version: 1, excludeCwd: ["/tmp/**"] }), { excludeCwd: ["/tmp/**"] });
  assert.throws(() => parseOverride({ nope: 1 }), /unknown property/);
  assert.throws(() => parseOverride({ version: 2 }), /expected 1/);
  assert.throws(() => parseOverride({ maxSnippetChars: -1 }), /positive integer/);
  assert.throws(() => parseOverride({ excludeCwd: "x" }), /array of strings/);
  assert.throws(() => parseOverride([]), /expected object/);
});

test("loader with no files present yields defaults and no errors", async () => {
  const loader = new SessionSearchConfigLoader([join(tmpdir(), "nope-session-search.json")], "/agent");
  const snapshot = await loader.refresh();
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.config.maxSnippetChars, 240);
});

test("later layers win per field, and a broken layer is reported but not fatal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-config-"));
  const global = join(dir, "global.json");
  const project = join(dir, "project.json");
  writeFileSync(global, JSON.stringify({ version: 1, includeThinking: true, maxSnippetChars: 100 }));
  writeFileSync(project, JSON.stringify({ maxSnippetChars: 50 }));

  const loader = new SessionSearchConfigLoader([global, project], "/agent");
  const snapshot = await loader.refresh();
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.config.includeThinking, true);
  assert.equal(snapshot.config.maxSnippetChars, 50);

  writeFileSync(project, "{ not json");
  const broken = await loader.refresh();
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.config.maxSnippetChars, 100);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/config.test.ts`
Expected: FAIL — cannot find module `./config.ts`.

- [ ] **Step 5: Write `config.ts`**

Follow `session-title/config.ts` in shape. Differences: every field is optional in every layer, defaults come from `defaultConfig(agentDir)`, and a broken layer is collected into `errors` instead of invalidating the snapshot.

```ts
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULTS, type ConfigError, type ConfigSnapshot, type SessionSearchConfig } from "./types.ts";

const ROOT_KEYS = new Set([
  "version",
  "dbPath",
  "sessionsDir",
  "includeThinking",
  "refreshBudgetBytes",
  "excludeCwd",
  "maxSnippetChars",
]);

export interface ConfigPathOptions {
  envPath: string | undefined;
  startupCwd: string;
  agentDir: string;
  projectTrusted: boolean;
}

export function resolveConfigPaths(options: ConfigPathOptions): string[] {
  const selected = options.envPath?.trim();
  if (selected) {
    return [isAbsolute(selected) ? selected : resolve(options.startupCwd, selected)];
  }
  const paths = [join(options.agentDir, "session-search.json")];
  if (options.projectTrusted) {
    paths.push(join(options.startupCwd, ".pi", "session-search.json"));
  }
  return paths;
}

export function defaultConfig(agentDir: string): SessionSearchConfig {
  return {
    version: 1,
    dbPath: join(agentDir, "session-search", "index.sqlite"),
    sessionsDir: join(agentDir, "sessions"),
    ...DEFAULTS,
    excludeCwd: [],
  };
}
```

Then the strict `parseOverride`, with one helper per type — `optionalBoolean`, `positiveInteger` (rejects non-integers and values `< 1`, message contains `positive integer`), `stringArray` (message contains `array of strings`), `nonEmptyString` — and `rejectUnknown`/`record` copied in shape from `session-title/config.ts` (`expected object`, `unknown property`, `expected 1` for a wrong `version`).

`SessionSearchConfigLoader` takes `(paths: string[], agentDir: string)`, caches on the `path:mtime:size` fingerprint exactly as `session-title` does, and builds the snapshot by folding each successfully parsed layer over `defaultConfig(agentDir)`. A layer that fails to read as JSON, or fails `parseOverride`, pushes `{ path, message }` into `errors` and is skipped; the remaining layers still apply. `dbPath` and `sessionsDir` from a config file are resolved to absolute against the startup cwd by the caller in `index.ts`, so the loader stores them verbatim.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the extension to the test script**

In `package.json`, extend `scripts.test` with `pi/extensions/session-search/*.test.ts`:

```json
"test": "node --test pi/extensions/model-modes/*.test.ts pi/extensions/session-title/*.test.ts pi/extensions/subagent/*.test.ts pi/extensions/session-search/*.test.ts"
```

- [ ] **Step 8: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add pi/extensions/session-search package.json
git commit -m "feat(session-search): scaffold types and configuration"
```

---

### Task 2: The database — schema, pragmas, versioning

**Files:**
- Create: `pi/extensions/session-search/db.ts`
- Test: `pi/extensions/session-search/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCHEMA_VERSION`, `openIndex(dbPath): DatabaseSync`, `applySchema(db): void`, `readSchemaVersion(db): number | undefined`, `resetIndex(db): void`, `getMeta(db, key): string | undefined`, `setMeta(db, key, value): void` from `db.ts`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/db.test.ts`:

```ts
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
  first.exec("INSERT INTO files(path, session_id, cwd, bytes_indexed, size, mtime_ms) VALUES('/a','a','/w',0,0,0)");
  setMeta(first, "schema_version", "0");
  first.close();

  const second = openIndex(path);
  assert.equal(readSchemaVersion(second), SCHEMA_VERSION);
  assert.equal(second.prepare("SELECT count(*) AS n FROM files").get()!.n, 0);
  second.close();
});

test("prose is external-content: text lives in entries and snippet() still works", () => {
  const db = openIndex(tempDb());
  db.exec("INSERT INTO files(path, session_id, cwd, bytes_indexed, size, mtime_ms) VALUES('/a','a','/w',0,0,0)");
  db.exec(
    "INSERT INTO entries(path, entry_id, parent_id, kind, role, ts, text) " +
      "VALUES('/a','e1',NULL,'message','user','2026-08-01T00:00:00.000Z','ripgrep versus sqlite for searching sessions')",
  );
  const rowid = db.prepare("SELECT rowid FROM entries").get()!.rowid as number;
  db.prepare("INSERT INTO prose(rowid, text) VALUES(?, ?)").run(rowid, "ripgrep versus sqlite for searching sessions");

  const hit = db
    .prepare("SELECT snippet(prose, 0, '[', ']', '…', 6) AS snip FROM prose WHERE prose MATCH 'sqlite'")
    .get()!;
  assert.match(String(hit.snip), /\[sqlite\]/);
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/db.test.ts`
Expected: FAIL — cannot find module `./db.ts`.

- [ ] **Step 3: Write `db.ts`**

```ts
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Bump on any schema change: a mismatch rebuilds the index from the JSONL. */
export const SCHEMA_VERSION = 1;

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
```

`applySchema(db)` runs `DDL` then writes `schema_version`. `getMeta`/`setMeta` are one-row helpers over `meta` (`INSERT ... ON CONFLICT(key) DO UPDATE SET value = excluded.value`). `readSchemaVersion` returns `Number(getMeta(db, "schema_version"))` or `undefined` when absent or when `meta` does not exist yet (wrap in try/catch — an empty file has no tables).

`resetIndex(db)` drops `prose`, `evidence`, `entries`, `files`, `meta` in that order (`prose` first: it references `entries` as its content table) and calls `applySchema`.

`openIndex(dbPath)`:

```ts
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
```

Note the deliberate `foreign_keys = OFF`: `entries.path` and `evidence.entry_rowid` are logical references, and the per-file drop in Task 5 deletes in dependency order itself. Declaring real foreign keys would only add per-row enforcement cost to bulk ingest.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): add the sqlite index schema"
```

---

### Task 3: Entry extraction — prose and evidence

**Files:**
- Create: `pi/extensions/session-search/extract.ts`
- Test: `pi/extensions/session-search/extract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EvidenceRow`, `ExtractedEntry`, `extractEntry(raw, options): ExtractedEntry | undefined`, `extractHeader(raw): SessionHeaderRow | undefined`, `toolAction(name): Action`, `toolTarget(name, args): string | undefined` from `extract.ts`.

This module and `tree.ts` hold the real complexity. It reads entries structurally — no pi imports — so every case is testable with an object literal.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/extract.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEntry, extractHeader } from "./extract.ts";

const OPTIONS = { includeThinking: false };

function entry(overrides: Record<string, unknown>) {
  return { id: "e1", parentId: null, timestamp: "2026-08-01T10:00:00.000Z", ...overrides };
}

test("a header yields the file row", () => {
  assert.deepEqual(
    extractHeader({
      type: "session",
      id: "8f2a1c",
      timestamp: "2026-08-01T09:00:00.000Z",
      cwd: "/work/repo",
      parentSession: "/sessions/parent.jsonl",
    }),
    {
      sessionId: "8f2a1c",
      created: "2026-08-01T09:00:00.000Z",
      cwd: "/work/repo",
      parentPath: "/sessions/parent.jsonl",
    },
  );
  assert.equal(extractHeader({ type: "message" }), undefined);
});

test("user text is prose, string content included", () => {
  const string = extractEntry(
    entry({ type: "message", message: { role: "user", content: "why not duckdb?" } }),
    OPTIONS,
  );
  assert.equal(string!.text, "why not duckdb?");
  assert.equal(string!.role, "user");
  assert.equal(string!.kind, "message");

  const blocks = extractEntry(
    entry({
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at" },
          { type: "image", data: "AAAABBBB", mimeType: "image/png" },
          { type: "text", text: "this diagram" },
        ],
      },
    }),
    OPTIONS,
  );
  assert.equal(blocks!.text, "look at this diagram");
});

test("assistant text is prose; thinking is excluded by default and included on request", () => {
  const message = entry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the user probably means the index" },
        { type: "text", text: "FTS5 keeps the snippet function" },
      ],
    },
  });
  assert.equal(extractEntry(message, OPTIONS)!.text, "FTS5 keeps the snippet function");
  assert.equal(
    extractEntry(message, { includeThinking: true })!.text,
    "the user probably means the index FTS5 keeps the snippet function",
  );
});

test("tool calls become evidence with read and write separated", () => {
  const extracted = extractEntry(
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "editing now" },
          { type: "toolCall", id: "t1", name: "read", arguments: { file_path: "/work/auth.ts" } },
          { type: "toolCall", id: "t2", name: "edit", arguments: { path: "/work/auth.ts" } },
          { type: "toolCall", id: "t3", name: "bash", arguments: { command: "npm run migrate" } },
          { type: "toolCall", id: "t4", name: "grep", arguments: { pattern: "TODO" } },
        ],
      },
    }),
    OPTIONS,
  );
  assert.equal(extracted!.text, "editing now");
  assert.deepEqual(extracted!.evidence, [
    { tool: "read", action: "read", target: "/work/auth.ts" },
    { tool: "edit", action: "write", target: "/work/auth.ts" },
    { tool: "bash", action: "run", target: "npm run migrate" },
    { tool: "grep", action: "read", target: "TODO" },
  ]);
});

test("tool results and bash output are indexed as neither prose nor evidence targets", () => {
  const result = extractEntry(
    entry({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "t1",
        content: [{ type: "text", text: "the entire contents of auth.ts" }],
        isError: false,
      },
    }),
    OPTIONS,
  );
  assert.equal(result!.text, undefined);
  assert.equal(result!.role, "toolResult");
  assert.deepEqual(result!.evidence, []);

  const bash = extractEntry(
    entry({
      type: "message",
      message: { role: "bashExecution", command: "npm test", output: "300 passing", exitCode: 0 },
    }),
    OPTIONS,
  );
  assert.equal(bash!.text, undefined);
  assert.deepEqual(bash!.evidence, [{ tool: "bash", action: "run", target: "npm test" }]);
});

test("summaries, names, and labels are prose; structural entries are metadata only", () => {
  assert.equal(
    extractEntry(entry({ type: "compaction", summary: "we chose sqlite", firstKeptEntryId: "e0" }), OPTIONS)!.text,
    "we chose sqlite",
  );
  assert.equal(
    extractEntry(entry({ type: "branch_summary", fromId: "e0", summary: "abandoned the duckdb branch" }), OPTIONS)!.text,
    "abandoned the duckdb branch",
  );
  assert.equal(extractEntry(entry({ type: "session_info", name: "Session search" }), OPTIONS)!.text, "Session search");
  assert.equal(extractEntry(entry({ type: "label", targetId: "e0", label: "the decision" }), OPTIONS)!.text, "the decision");

  const model = extractEntry(entry({ type: "model_change", provider: "copilot", modelId: "gpt-5" }), OPTIONS);
  assert.equal(model!.kind, "model_change");
  assert.equal(model!.text, undefined);
});

test("every entry with an id yields a row, so the tree stays complete", () => {
  const unknown = extractEntry(entry({ type: "something_new_pi_added" }), OPTIONS);
  assert.equal(unknown!.kind, "something_new_pi_added");
  assert.equal(unknown!.text, undefined);

  assert.equal(extractEntry({ type: "message" }, OPTIONS), undefined);
  assert.equal(extractEntry(null, OPTIONS), undefined);
  assert.equal(extractEntry({ type: "session", id: "s1" }, OPTIONS), undefined);
});

test("empty prose is undefined, not an empty string", () => {
  const blank = extractEntry(
    entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "   " }] } }),
    OPTIONS,
  );
  assert.equal(blank!.text, undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/extract.test.ts`
Expected: FAIL — cannot find module `./extract.ts`.

- [ ] **Step 3: Write `extract.ts`**

```ts
/**
 * One raw JSONL entry to one index row.
 *
 * Entries are read structurally rather than through pi's session types, so this
 * module stays free of pi imports and testable with plain object literals — the
 * approach `session-title/transcript.ts` already takes.
 *
 * Two rules carry the design:
 *
 * 1. Every entry with an id produces a row, even when it has no prose. Branch
 *    resolution walks `parentId` to the root, so a skipped tool result would
 *    break the chain and misplace a hit on the wrong branch.
 * 2. Tool *results*, bash *output*, and image data are never prose. They are
 *    most of the corpus by bytes and none of it by recall value.
 */

export type Action = "read" | "write" | "run" | "other";

export interface EvidenceRow {
  tool: string;
  action: Action;
  target: string | undefined;
}

export interface ExtractedEntry {
  entryId: string;
  parentId: string | null;
  kind: string;
  role: string | undefined;
  ts: string | undefined;
  text: string | undefined;
  evidence: EvidenceRow[];
}

export interface SessionHeaderRow {
  sessionId: string;
  created: string | undefined;
  cwd: string | undefined;
  parentPath: string | undefined;
}

const READ_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "tree", "search", "webfetch", "web_search"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "multi_edit", "patch", "apply_patch", "create", "delete", "move"]);

export function toolAction(name: string): Action {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "run") return "run";
  if (WRITE_TOOLS.has(lower)) return "write";
  if (READ_TOOLS.has(lower)) return "read";
  return "other";
}

export function toolTarget(name: string, args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["file_path", "path", "filePath", "command", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
```

Then `blockText(content, includeThinking)` — the same structural walk `session-title/transcript.ts` uses, extended to join `thinking` blocks when asked, joining with a single space and trimming; an empty result becomes `undefined`.

`extractEntry(raw, options)`:
- return `undefined` unless `raw` is an object with a string `id` and a string `type` that is not `"session"`;
- `kind` is `raw.type`, `parentId` is `raw.parentId ?? null`, `ts` is `raw.timestamp` when it is a string;
- `role` is `raw.message.role` for `type === "message"`, otherwise `undefined`;
- prose by kind: `message` with role `user`/`assistant` → `blockText`; `compaction`/`branch_summary` → `summary`; `session_info` → `name`; `label` → `label`; everything else → `undefined`;
- evidence: for an assistant message, one row per `toolCall` block in order (`tool: block.name`, `action: toolAction(block.name)`, `target: toolTarget(block.name, block.arguments)`); for a `bashExecution` message, one row `{ tool: "bash", action: "run", target: message.command }`; otherwise `[]`.

`extractHeader(raw)` returns the four header fields when `raw.type === "session"` and `raw.id` is a string, else `undefined`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): extract prose and tool evidence from entries"
```

---

### Task 4: Scanning — stat comparison and tail reads

**Files:**
- Create: `pi/extensions/session-search/scan.ts`
- Test: `pi/extensions/session-search/scan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionFile`, `StoredState`, `FilePlan`, `listSessionFiles(sessionsDir): SessionFile[]`, `planFile(stored, current): FilePlan`, `readLines(path, from): { lines: string[]; nextOffset: number }`, `endsOnNewline(path, offset): boolean` from `scan.ts`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/scan.test.ts`:

```ts
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endsOnNewline, listSessionFiles, planFile, readLines } from "./scan.ts";

test("listSessionFiles finds jsonl one level down and tolerates a missing root", () => {
  const root = mkdtempSync(join(tmpdir(), "ss-scan-"));
  mkdirSync(join(root, "--work-repo--"));
  writeFileSync(join(root, "--work-repo--", "a.jsonl"), "{}\n");
  writeFileSync(join(root, "--work-repo--", "notes.txt"), "ignored");
  const found = listSessionFiles(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, join(root, "--work-repo--", "a.jsonl"));
  assert.ok(found[0].size > 0);
  assert.deepEqual(listSessionFiles(join(root, "absent")), []);
});

test("planFile classifies unchanged, new, grown, and rewritten", () => {
  const current = { path: "/a", size: 100, mtimeMs: 5 };
  assert.equal(planFile({ size: 100, mtimeMs: 5, bytesIndexed: 100 }, current).kind, "unchanged");
  assert.equal(planFile(undefined, current).kind, "new");
  assert.equal(planFile({ size: 60, mtimeMs: 1, bytesIndexed: 60 }, current).kind, "grown");
  assert.equal(planFile({ size: 200, mtimeMs: 1, bytesIndexed: 200 }, current).kind, "rewritten");
  assert.equal(planFile({ size: 60, mtimeMs: 1, bytesIndexed: 80 }, current).kind, "rewritten");
  assert.equal(planFile({ size: 100, mtimeMs: 9, bytesIndexed: 100 }, current).kind, "grown");
  assert.equal(planFile(undefined, current).from, 0);
  assert.equal(planFile({ size: 60, mtimeMs: 1, bytesIndexed: 60 }, current).from, 60);
  assert.equal(planFile({ size: 200, mtimeMs: 1, bytesIndexed: 200 }, current).from, 0);
});

test("readLines returns only complete lines and stops at the last newline", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ss-tail-")), "s.jsonl");
  writeFileSync(path, '{"a":1}\n{"b":2}\n');
  const first = readLines(path, 0);
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(first.nextOffset, 16);

  appendFileSync(path, '{"c":3}');
  const partial = readLines(path, first.nextOffset);
  assert.deepEqual(partial.lines, []);
  assert.equal(partial.nextOffset, first.nextOffset);

  appendFileSync(path, "\n");
  const completed = readLines(path, partial.nextOffset);
  assert.deepEqual(completed.lines, ['{"c":3}']);
  assert.equal(completed.nextOffset, 24);
});

test("endsOnNewline detects an offset that no longer lands on a record boundary", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ss-boundary-")), "s.jsonl");
  writeFileSync(path, '{"a":1}\n{"b":2}\n');
  assert.equal(endsOnNewline(path, 8), true);
  assert.equal(endsOnNewline(path, 0), true);
  assert.equal(endsOnNewline(path, 5), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/scan.test.ts`
Expected: FAIL — cannot find module `./scan.ts`.

- [ ] **Step 3: Write `scan.ts`**

```ts
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SessionFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface StoredState {
  size: number;
  mtimeMs: number;
  bytesIndexed: number;
}

export interface FilePlan {
  kind: "unchanged" | "new" | "grown" | "rewritten";
  /** Byte offset to start reading from. */
  from: number;
}

/**
 * Sessions live one directory deep: `<sessionsDir>/<encoded-cwd>/<id>.jsonl`.
 * Walking with `stat` only keeps this under 100 ms for 43 directories.
 */
export function listSessionFiles(sessionsDir: string): SessionFile[] { /* readdirSync withFileTypes, recurse one level, statSync each .jsonl, skip unreadable */ }

/**
 * A file that shrank, or whose stored offset exceeds its size, was rewritten.
 * Everything else that changed is a tail read. Misjudging this costs speed and
 * never correctness: ingest is idempotent.
 */
export function planFile(stored: StoredState | undefined, current: SessionFile): FilePlan {
  if (!stored) return { kind: "new", from: 0 };
  if (current.size < stored.size || current.size < stored.bytesIndexed) return { kind: "rewritten", from: 0 };
  if (current.size === stored.size && current.mtimeMs === stored.mtimeMs) return { kind: "unchanged", from: stored.bytesIndexed };
  return { kind: "grown", from: stored.bytesIndexed };
}
```

`readLines(path, from)` opens the file, reads from `from` to EOF into a `Buffer`, finds the last `\n`, decodes only up to and including it, and splits on `\n` discarding empties. `nextOffset` is `from + lastNewlineIndex + 1`, or `from` when the chunk holds no newline — which is exactly the "leave the partial line for the next pass" rule that makes it safe to index a session another pi process is writing right now.

`endsOnNewline(path, offset)` returns `true` for `offset === 0`, otherwise reads the single byte at `offset - 1` and compares it to `0x0a`.

Both helpers return their empty value rather than throwing when the file cannot be opened.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/scan.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): scan session files by stat and tail"
```

---

### Task 5: Ingest — idempotent, transactional, budgeted

**Files:**
- Create: `pi/extensions/session-search/ingest.ts`
- Test: `pi/extensions/session-search/ingest.test.ts`
- Create: `pi/extensions/session-search/fixtures.ts` (test helper, exported for reuse by later tasks)

**Interfaces:**
- Consumes: `openIndex`, `getMeta`, `setMeta` from `db.ts`; `extractEntry`, `extractHeader` from `extract.ts`; `listSessionFiles`, `planFile`, `readLines`, `endsOnNewline` from `scan.ts`.
- Produces: `RefreshOptions`, `RefreshStats`, `refreshIndex(db, options): RefreshStats`, `ingestFile(db, file, plan, options): number`, `dropFile(db, path): void` from `ingest.ts`; `writeSession(dir, spec)` and `sessionSpec` helpers from `fixtures.ts`.

- [ ] **Step 1: Write the fixture generator**

`pi/extensions/session-search/fixtures.ts` — a real JSONL writer, so nothing in the stateful half is mocked:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FixtureEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string;
  role?: "user" | "assistant";
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  toolResult?: { toolName: string; text: string };
  bash?: { command: string; output: string };
  summary?: string;
  name?: string;
  label?: string;
}

export interface FixtureSession {
  path: string;
  id: string;
  cwd: string;
  created?: string;
  parentSession?: string;
  entries: FixtureEntry[];
}

/** Serialize one fixture entry into the JSONL shape pi writes. */
export function entryLine(entry: FixtureEntry): string { /* switch on the populated field, emit the matching session entry */ }

/** Write a session file, creating its project directory. Returns the path. */
export function writeSession(root: string, session: FixtureSession): string { /* header line + entry lines */ }

/** Append entries to an existing fixture, as a live pi process would. */
export function appendEntries(path: string, entries: FixtureEntry[]): void

/** Append a line without its trailing newline, simulating a half-written record. */
export function appendPartial(path: string, entry: FixtureEntry): void
```

`entryLine` emits, by populated field: `text`/`thinking`/`toolCalls` → `{type:"message", message:{role:"assistant", content:[...]}}` (or `role:"user"` when `role` says so); `toolResult` → `{type:"message", message:{role:"toolResult", toolName, content:[{type:"text",text}], isError:false}}`; `bash` → `{type:"message", message:{role:"bashExecution", command, output, exitCode:0}}`; `summary` with `type:"compaction"` or `"branch_summary"`; `name` → `session_info`; `label` → `label`. Timestamps default to a fixed base incremented per entry so tests are deterministic.

- [ ] **Step 2: Write the failing ingest tests**

`pi/extensions/session-search/ingest.test.ts` — these pin behaviors 1–4, 7, and 8 from the spec's testing section:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openIndex } from "./db.ts";
import { appendEntries, appendPartial, writeSession } from "./fixtures.ts";
import { refreshIndex } from "./ingest.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ss-ingest-"));
  const db = openIndex(join(root, "index.sqlite"));
  const sessions = join(root, "sessions");
  return { db, sessions, options: { sessionsDir: sessions, budgetBytes: 1 << 30, includeThinking: false, excludeCwd: [] } };
}

const BASIC = {
  path: "--work-repo--/a.jsonl",
  id: "aaa",
  cwd: "/work/repo",
  entries: [
    { id: "e1", parentId: null, role: "user" as const, text: "why not duckdb" },
    { id: "e2", parentId: "e1", role: "assistant" as const, text: "its fts index does not refresh", toolCalls: [{ name: "read", arguments: { file_path: "/work/repo/auth.ts" } }] },
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
  writeSession(sessions, { ...BASIC, entries: [{ id: "z1", parentId: null, role: "user", text: "entirely different" }] });

  refreshIndex(db, options);
  const ids = db.prepare("SELECT entry_id FROM entries ORDER BY entry_id").all().map((r: any) => r.entry_id);
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
      { id: "e6", parentId: "e5", role: "assistant", toolCalls: [{ name: "edit", arguments: { path: "/work/repo/auth.ts" } }] },
    ],
  });
  refreshIndex(db, options);

  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'whole'").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'migrated'").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'secretly'").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'duckdb'").get()!.n, 1);

  const evidence = db.prepare("SELECT tool, action, target FROM evidence ORDER BY rowid").all();
  assert.deepEqual(evidence, [
    { tool: "read", action: "read", target: "/work/repo/auth.ts" },
    { tool: "bash", action: "run", target: "npm run migrate" },
    { tool: "edit", action: "write", target: "/work/repo/auth.ts" },
  ]);
});

test("includeThinking puts thinking into prose", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, { ...BASIC, entries: [{ id: "e1", parentId: null, role: "assistant", thinking: "secretly reasoning", text: "done" }] });
  refreshIndex(db, { ...options, includeThinking: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM prose WHERE prose MATCH 'secretly'").get()!.n, 1);
});

test("an unparseable line is skipped, counted, and does not wedge the file", () => {
  const { db, sessions, options } = setup();
  const path = writeSession(sessions, BASIC);
  require("node:fs").appendFileSync(path, "{ not json\n");
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
});

test("excludeCwd skips a project directory entirely", () => {
  const { db, sessions, options } = setup();
  writeSession(sessions, BASIC);
  refreshIndex(db, { ...options, excludeCwd: ["/work/**"] });
  assert.equal(db.prepare("SELECT count(*) AS n FROM entries").get()!.n, 0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/ingest.test.ts`
Expected: FAIL — cannot find module `./ingest.ts`.

- [ ] **Step 4: Write `ingest.ts`**

```ts
export interface RefreshOptions {
  sessionsDir: string;
  budgetBytes: number;
  includeThinking: boolean;
  excludeCwd: string[];
}

export interface RefreshStats {
  filesIngested: number;
  entriesInserted: number;
  bytesRead: number;
  skippedLines: number;
  /** Files left unread because the byte budget ran out. */
  remainingFiles: number;
  remainingBytes: number;
  elapsedMs: number;
}
```

`refreshIndex(db, options)`:

1. `listSessionFiles(options.sessionsDir)`; return zeroed stats when the directory is missing.
2. Load stored state for every path in one query into a `Map<string, StoredState & { cwd: string | null }>`.
3. `planFile` each; drop the `unchanged` ones. For a `grown` plan, also require `endsOnNewline(path, plan.from)` — a `false` demotes it to `rewritten`, because the stored offset no longer lands on a record boundary.
4. Skip a file whose stored `cwd` matches any `excludeCwd` glob (Task 8's `globToLike` is not yet available, so `ingest.ts` owns a tiny `matchesGlob(value, pattern)` that converts `*`/`**`/`?` to a `RegExp`; `search.ts` reuses it in Task 8 by importing it from here).
5. Sort the remaining files newest-first by `mtimeMs` — recent sessions are what gets searched, so a truncated refresh truncates from the far end.
6. Ingest until `bytesRead >= budgetBytes`; count what is left into `remainingFiles`/`remainingBytes`.

`ingestFile(db, file, plan, options)` runs inside one transaction (`db.exec("BEGIN")` … `COMMIT`, `ROLLBACK` on throw):

- for `rewritten` and `new`, call `dropFile(db, file.path)` first;
- `readLines(file.path, plan.from)`;
- for each line: `JSON.parse` inside a try/catch that increments `skippedLines` and continues — one bad line must never wedge a file permanently;
- a parsed header updates the `files` row (`session_id`, `cwd`, `created`, `parent_path`); note the cwd check for `excludeCwd` again here, because a `new` file has no stored cwd yet: an excluded cwd aborts the transaction with a rollback and records the file with `bytes_indexed = size` so it is not re-read;
- a parsed entry goes through `extractEntry`; insert with

```sql
INSERT INTO entries(path, entry_id, parent_id, kind, role, ts, text)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path, entry_id) DO NOTHING
```

  and when `changes === 1` and `text` is set, `INSERT INTO prose(rowid, text) VALUES(?, ?)` with `lastInsertRowid`, plus one `evidence` row per extracted evidence item. Using `changes` is what makes double ingest a no-op in all three tables at once;
- finally update the `files` row: `bytes_indexed = plan.from + consumed`, `size`, `mtime_ms`, and `last_activity = max(last_activity, newest ts seen)`.

`dropFile(db, path)` deletes in dependency order, and the FTS delete must carry the original text because `prose` is external-content:

```ts
const rows = db.prepare("SELECT rowid, text FROM entries WHERE path = ? AND text IS NOT NULL").all(path);
const remove = db.prepare("INSERT INTO prose(prose, rowid, text) VALUES('delete', ?, ?)");
for (const row of rows) remove.run(row.rowid, row.text);
db.prepare("DELETE FROM evidence WHERE entry_rowid IN (SELECT rowid FROM entries WHERE path = ?)").run(path);
db.prepare("DELETE FROM entries WHERE path = ?").run(path);
db.prepare("UPDATE files SET bytes_indexed = 0, size = 0, mtime_ms = 0 WHERE path = ?").run(path);
```

Cumulative `skippedLines` is kept in `meta` under `skipped_lines` so `/session-index` can report it; `RefreshStats.skippedLines` is the count for this pass.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/ingest.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): ingest session tails idempotently"
```

---

### Task 6: Branch resolution

**Files:**
- Create: `pi/extensions/session-search/tree.ts`
- Test: `pi/extensions/session-search/tree.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Skeleton`, `BranchInfo`, `mainLine(skeleton): string[]`, `classifyEntry(skeleton, entryId): BranchInfo` from `tree.ts`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/tree.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEntry, mainLine } from "./tree.ts";

/** root e1 → e2 → e3 (main line), with e2 → f1 → f2 as an abandoned side branch. */
const FORKED = [
  { id: "e1", parentId: null, ts: "2026-07-14T10:00:00.000Z" },
  { id: "e2", parentId: "e1", ts: "2026-07-14T10:01:00.000Z" },
  { id: "f1", parentId: "e2", ts: "2026-07-14T10:02:00.000Z" },
  { id: "f2", parentId: "f1", ts: "2026-07-14T10:03:00.000Z" },
  { id: "e3", parentId: "e2", ts: "2026-07-14T11:00:00.000Z" },
];

test("the main line runs from the chronologically last entry to the root", () => {
  assert.deepEqual(mainLine(FORKED), ["e1", "e2", "e3"]);
});

test("a hit on the main line reports the session leaf as its branch identity", () => {
  const info = classifyEntry(FORKED, "e2");
  assert.equal(info.onMainLine, true);
  assert.equal(info.leafId, "e3");
  assert.equal(info.divergedAt, undefined);
  assert.equal(info.entriesPastDivergence, 0);
});

test("a hit on a side branch reports the divergence and how far the branch ran", () => {
  const info = classifyEntry(FORKED, "f1");
  assert.equal(info.onMainLine, false);
  assert.equal(info.leafId, "f2");
  assert.equal(info.divergedAt, "2026-07-14T10:02:00.000Z");
  assert.equal(info.entriesPastDivergence, 2);
});

test("branch identity is the leaf id, and it does not move when a new branch diverges earlier", () => {
  const withEarlierFork = [...FORKED, { id: "g1", parentId: "e1", ts: "2026-07-14T10:00:30.000Z" }];
  assert.equal(classifyEntry(withEarlierFork, "f1").leafId, "f2");
  assert.equal(classifyEntry(withEarlierFork, "g1").leafId, "g1");
});

test("a branch running through non-prose entries still resolves to the root", () => {
  const withStructural = [
    { id: "e1", parentId: null, ts: "2026-07-14T10:00:00.000Z" },
    { id: "m1", parentId: "e1", ts: "2026-07-14T10:00:10.000Z" },
    { id: "t1", parentId: "m1", ts: "2026-07-14T10:00:20.000Z" },
    { id: "e2", parentId: "t1", ts: "2026-07-14T10:01:00.000Z" },
  ];
  assert.deepEqual(mainLine(withStructural), ["e1", "m1", "t1", "e2"]);
  assert.equal(classifyEntry(withStructural, "e1").onMainLine, true);
});

test("an orphaned entry and a parent cycle degrade instead of hanging", () => {
  const broken = [
    { id: "a", parentId: "missing", ts: "2026-07-14T10:00:00.000Z" },
    { id: "c1", parentId: "c2", ts: "2026-07-14T10:01:00.000Z" },
    { id: "c2", parentId: "c1", ts: "2026-07-14T10:02:00.000Z" },
  ];
  assert.equal(classifyEntry(broken, "a").leafId, "a");
  assert.equal(classifyEntry(broken, "c1").onMainLine, false);
  assert.equal(classifyEntry([], "nope").leafId, "nope");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/tree.test.ts`
Expected: FAIL — cannot find module `./tree.ts`.

- [ ] **Step 3: Write `tree.ts`**

```ts
/**
 * Branch resolution over a session's `(id, parentId, ts)` skeleton.
 *
 * A session is a tree, and a line match tells you which file holds the text,
 * not which branch. The main line — the path from the chronologically last
 * entry back to the root — is the branch a resume lands on, which makes it the
 * meaningful default. Branch identity is the leaf entry id, never an ordinal:
 * ordinals renumber when a new branch diverges earlier, and an identifier that
 * changes between being read and being used is worse than none.
 */

export interface Skeleton {
  id: string;
  parentId: string | null;
  ts: string | undefined;
}

export interface BranchInfo {
  onMainLine: boolean;
  /** Leaf of the branch the entry sits on — the branch's stable identity. */
  leafId: string;
  /** Timestamp of the first entry off the main line, when the hit is on a side branch. */
  divergedAt: string | undefined;
  /** Entries from the divergence point to the branch leaf, inclusive. */
  entriesPastDivergence: number;
}
```

Implementation notes:

- `pathToRoot(byId, id)` walks `parentId` with a `Set` of visited ids as a cycle guard and stops at a missing parent, returning root-first order.
- `mainLine(skeleton)` picks the entry with the greatest `ts` (ties broken by the later position in the array, which is file order) and returns its `pathToRoot`.
- `classifyEntry(skeleton, entryId)`:
  - build `byId` and a `childrenOf` map;
  - `main = new Set(mainLine(skeleton))`;
  - when `entryId` is unknown, return `{ onMainLine: false, leafId: entryId, divergedAt: undefined, entriesPastDivergence: 0 }`;
  - the branch leaf is found by descending from `entryId`, at each step taking the child with the greatest `ts` (cycle-guarded), and is `entryId` itself when it has no children;
  - `onMainLine` is `main.has(entryId)`; when true, `leafId` is the last element of `mainLine`, `divergedAt` is `undefined`, and `entriesPastDivergence` is `0`;
  - when false, the divergence entry is the first entry on `pathToRoot(entryId)` that is *not* in `main`; `divergedAt` is its `ts`, and `entriesPastDivergence` counts the entries from it down to the branch leaf inclusive (walk down the same greatest-`ts`-child descent).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): resolve branches within a session tree"
```

---

### Task 7: Fork families — dedup and origin

**Files:**
- Create: `pi/extensions/session-search/lineage.ts`
- Test: `pi/extensions/session-search/lineage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FileNode`, `familyRoot(files, path): string`, `groupByFamily(files, paths): Map<string, string[]>`, `chooseOrigin(candidates): { origin: Candidate; continuations: Candidate[] }` from `lineage.ts`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/lineage.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseOrigin, familyRoot, groupByFamily } from "./lineage.ts";

const FILES = [
  { path: "/s/a.jsonl", parentPath: null, created: "2026-07-01T00:00:00.000Z" },
  { path: "/s/b.jsonl", parentPath: "/s/a.jsonl", created: "2026-07-02T00:00:00.000Z" },
  { path: "/s/c.jsonl", parentPath: "/s/b.jsonl", created: "2026-07-03T00:00:00.000Z" },
  { path: "/s/x.jsonl", parentPath: null, created: "2026-07-04T00:00:00.000Z" },
];

test("a fork chain resolves to its root file", () => {
  assert.equal(familyRoot(FILES, "/s/c.jsonl"), "/s/a.jsonl");
  assert.equal(familyRoot(FILES, "/s/a.jsonl"), "/s/a.jsonl");
  assert.equal(familyRoot(FILES, "/s/unknown.jsonl"), "/s/unknown.jsonl");
});

test("a missing ancestor and a cycle both stop the walk", () => {
  const orphan = [{ path: "/s/o.jsonl", parentPath: "/s/gone.jsonl", created: "2026-07-01T00:00:00.000Z" }];
  assert.equal(familyRoot(orphan, "/s/o.jsonl"), "/s/o.jsonl");
  const cyclic = [
    { path: "/s/p.jsonl", parentPath: "/s/q.jsonl", created: "2026-07-01T00:00:00.000Z" },
    { path: "/s/q.jsonl", parentPath: "/s/p.jsonl", created: "2026-07-01T00:00:00.000Z" },
  ];
  assert.ok(["/s/p.jsonl", "/s/q.jsonl"].includes(familyRoot(cyclic, "/s/p.jsonl")));
});

test("files group by family root", () => {
  const groups = groupByFamily(FILES, ["/s/c.jsonl", "/s/b.jsonl", "/s/x.jsonl"]);
  assert.deepEqual([...groups.keys()].sort(), ["/s/a.jsonl", "/s/x.jsonl"]);
  assert.deepEqual(groups.get("/s/a.jsonl"), ["/s/c.jsonl", "/s/b.jsonl"]);
});

test("the oldest file holding the entry is the origin; the rest are continuations", () => {
  const chosen = chooseOrigin([
    { path: "/s/c.jsonl", created: "2026-07-03T00:00:00.000Z" },
    { path: "/s/a.jsonl", created: "2026-07-01T00:00:00.000Z" },
    { path: "/s/b.jsonl", created: "2026-07-02T00:00:00.000Z" },
  ]);
  assert.equal(chosen.origin.path, "/s/a.jsonl");
  assert.deepEqual(chosen.continuations.map((c) => c.path), ["/s/b.jsonl", "/s/c.jsonl"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/lineage.test.ts`
Expected: FAIL — cannot find module `./lineage.ts`.

- [ ] **Step 3: Write `lineage.ts`**

```ts
/**
 * Fork families over `files.parent_path`, which forms a forest.
 *
 * Both fork paths in pi's SessionManager — `forkFrom` and
 * `createBranchedSession` — copy entries verbatim and preserve `entry_id`, so
 * the same id in five files is one moment, not five hits. Collapsing on
 * `entry_id` is therefore an equality check: no similarity scoring, no
 * threshold to tune. The canonical hit is the oldest file containing the entry,
 * where the moment happened; its descendants are listed as continuations.
 */

export interface FileNode {
  path: string;
  parentPath: string | null;
  created: string | undefined;
}

export interface Candidate {
  path: string;
  created: string | undefined;
}
```

`familyRoot(files, path)` builds a `Map<string, string | null>` of parents and walks up with a visited-set cycle guard, stopping when the parent is absent from the map (a forked-from session whose file is gone still anchors its own family). `groupByFamily(files, paths)` maps each input path to its root, preserving input order within a group. `chooseOrigin(candidates)` sorts by `created` ascending, breaking ties on `path` so the choice is stable, and returns the first as `origin` with the rest as `continuations`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/lineage.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): collapse fork families onto their origin"
```

---

### Task 8: Search — filters, ranking, assembly

**Files:**
- Create: `pi/extensions/session-search/search.ts`
- Test: `pi/extensions/session-search/search.test.ts`

**Interfaces:**
- Consumes: `openIndex` from `db.ts`; `refreshIndex` from `ingest.ts`; `classifyEntry` from `tree.ts`; `familyRoot`, `chooseOrigin` from `lineage.ts`; `matchesGlob` from `ingest.ts`.
- Produces: `SearchParams`, `SearchResult`, `Continuation`, `parseWhen(value, now): string | undefined`, `globToLike(pattern): string`, `searchIndex(db, params, options): SearchResult[]`, `readEntries(db, request): TranscriptEntry[]`, `resolveSession(db, idOrPath): string | undefined` from `search.ts`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/search.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openIndex } from "./db.ts";
import { writeSession } from "./fixtures.ts";
import { refreshIndex } from "./ingest.ts";
import { parseWhen, readEntries, resolveSession, searchIndex } from "./search.ts";

const OPTIONS = { maxSnippetChars: 240 };

function indexed(sessions: Parameters<typeof writeSession>[1][]) {
  const root = mkdtempSync(join(tmpdir(), "ss-search-"));
  const db = openIndex(join(root, "index.sqlite"));
  const dir = join(root, "sessions");
  for (const session of sessions) writeSession(dir, session);
  refreshIndex(db, { sessionsDir: dir, budgetBytes: 1 << 30, includeThinking: false, excludeCwd: [] });
  return db;
}

const PARENT = {
  path: "--work-repo--/a.jsonl",
  id: "aaa",
  cwd: "/work/repo",
  created: "2026-07-14T09:00:00.000Z",
  entries: [
    { id: "e1", parentId: null, role: "user" as const, text: "convinced that ripgrep might be problematic because of JSON", timestamp: "2026-07-14T10:00:00.000Z" },
    { id: "e2", parentId: "e1", role: "assistant" as const, text: "sqlite fts5 gives snippets", timestamp: "2026-07-14T10:01:00.000Z" },
    { id: "e3", parentId: "e2", role: "assistant" as const, toolCalls: [{ name: "write", arguments: { file_path: "/work/repo/src/auth.ts" } }], timestamp: "2026-07-14T10:02:00.000Z" },
    { id: "e4", parentId: "e3", bash: { command: "npm run migrate -- --latest", output: "done" }, timestamp: "2026-07-14T10:03:00.000Z" },
  ],
};

/** A fork: same entry ids copied verbatim, plus its own continuation. */
const FORK = {
  path: "--work-repo--/b.jsonl",
  id: "bbb",
  cwd: "/work/repo",
  created: "2026-07-20T09:00:00.000Z",
  parentSession: "--work-repo--/a.jsonl",
  entries: [...PARENT.entries, { id: "k1", parentId: "e4", role: "user" as const, text: "carrying on here", timestamp: "2026-07-20T10:00:00.000Z" }],
};

const OTHER = {
  path: "--other-proj--/c.jsonl",
  id: "ccc",
  cwd: "/other/proj",
  created: "2026-08-01T09:00:00.000Z",
  entries: [
    { id: "n1", parentId: null, type: "session_info", name: "Ripgrep versus sqlite" as string, timestamp: "2026-08-01T10:00:00.000Z" },
    { id: "n2", parentId: "n1", role: "user" as const, text: "unrelated ripgrep talk", timestamp: "2026-08-01T10:01:00.000Z" },
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

test("FTS5 syntax works and a malformed query is reported, not thrown", () => {
  const db = indexed([PARENT]);
  assert.equal(searchIndex(db, { query: '"might be problematic"', limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { query: "ripg*", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { query: "ripgrep NOT JSON", limit: 10 }, OPTIONS).length, 0);
  assert.throws(() => searchIndex(db, { query: '"unbalanced', limit: 10 }, OPTIONS), /invalid query/i);
});

test("touched and action select on evidence, and command searches shell commands", () => {
  const db = indexed([PARENT]);
  assert.equal(searchIndex(db, { touched: "**/auth.ts", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { touched: "**/auth.ts", action: "write", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { touched: "**/auth.ts", action: "read", limit: 10 }, OPTIONS).length, 0);
  assert.equal(searchIndex(db, { command: "migrate", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { command: "1000 rows", limit: 10 }, OPTIONS).length, 0);
});

test("cwd, role, and date filters narrow the result set", () => {
  const db = indexed([PARENT, OTHER]);
  assert.equal(searchIndex(db, { query: "ripgrep", limit: 10 }, OPTIONS).length, 2);
  assert.equal(searchIndex(db, { query: "ripgrep", cwd: "/work/**", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { query: "ripgrep", role: "user", limit: 10 }, OPTIONS).length, 2);
  assert.equal(searchIndex(db, { query: "snippets", role: "user", limit: 10 }, OPTIONS).length, 0);
  assert.equal(searchIndex(db, { query: "ripgrep", after: "2026-07-20", limit: 10 }, OPTIONS).length, 1);
  assert.equal(searchIndex(db, { query: "ripgrep", before: "2026-07-20", limit: 10 }, OPTIONS).length, 1);
});

test("a fork sharing entry ids produces one result, attributed to the origin", () => {
  const results = searchIndex(indexed([PARENT, FORK]), { query: "ripgrep", limit: 10 }, OPTIONS);
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "aaa");
  assert.deepEqual(results[0].continuations.map((c) => c.sessionId), ["bbb"]);
});

test("a session name is carried on the result", () => {
  const results = searchIndex(indexed([OTHER]), { query: "unrelated", limit: 10 }, OPTIONS);
  assert.equal(results[0].name, "Ripgrep versus sqlite");
});

test("branch classification rides along on each hit", () => {
  const branched = {
    path: "--work-repo--/d.jsonl",
    id: "ddd",
    cwd: "/work/repo",
    created: "2026-07-14T09:00:00.000Z",
    entries: [
      { id: "e1", parentId: null, role: "user" as const, text: "shared opening", timestamp: "2026-07-14T10:00:00.000Z" },
      { id: "f1", parentId: "e1", role: "user" as const, text: "abandoned duckdb attempt", timestamp: "2026-07-14T10:01:00.000Z" },
      { id: "f2", parentId: "f1", role: "assistant" as const, text: "more of the abandoned path", timestamp: "2026-07-14T10:02:00.000Z" },
      { id: "e2", parentId: "e1", role: "assistant" as const, text: "the path that continued", timestamp: "2026-07-14T11:00:00.000Z" },
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
  assert.deepEqual(around.map((e) => e.entryId), ["e1", "e2", "e3"]);

  const branch = readEntries(db, { path, mode: "branch", leafId: "e4" });
  assert.deepEqual(branch.map((e) => e.entryId), ["e1", "e2", "e3", "e4"]);

  const last = readEntries(db, { path, mode: "last", count: 2 });
  assert.deepEqual(last.map((e) => e.entryId), ["e3", "e4"]);
  assert.deepEqual(last[1].evidence, [{ tool: "bash", action: "run", target: "npm run migrate -- --latest" }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/search.test.ts`
Expected: FAIL — cannot find module `./search.ts`.

- [ ] **Step 3: Write `search.ts`**

```ts
export interface SearchParams {
  query?: string;
  touched?: string;
  action?: "read" | "write" | "any";
  command?: string;
  cwd?: string;
  after?: string;
  before?: string;
  role?: "user" | "assistant" | "any";
  limit?: number;
}

export interface Continuation {
  sessionId: string;
  path: string;
}

export interface SearchResult {
  sessionId: string;
  path: string;
  cwd: string | undefined;
  name: string | undefined;
  entryId: string;
  ts: string | undefined;
  role: string | undefined;
  kind: string;
  snippet: string | undefined;
  branch: BranchInfo;
  continuations: Continuation[];
}
```

`globToLike(pattern)` converts a glob to a SQL `GLOB` pattern: pi's `GLOB` already understands `*`, `?`, and `[...]`, so the only translation needed is `**` → `*` and, when the pattern has no leading `*` or `/`, an implicit `*` prefix so `**/auth.ts` and `auth.ts` both match a full path. `matchesGlob` from `ingest.ts` covers the in-memory case; keep both in step by testing `globToLike("**/auth.ts")` returns `"*/auth.ts"`.

`parseWhen(value, now)`: an ISO date (`YYYY-MM-DD`) becomes midnight UTC; a full ISO timestamp passes through normalized; `\d+([hdwm])` subtracts hours, days, weeks, or 30-day months from `now`; anything else returns `undefined`.

`searchIndex(db, params, options)`:

1. Build the candidate query. With `query`, select from `prose` joined to `entries` and `files`, adding `snippet(prose, 0, '', '', '…', 24)` and ordering by `bm25(prose)`. Without `query`, select from `entries` joined to `files`, ordering by `e.ts DESC`, and require at least one of `touched`/`command` — the caller enforces "at least one of query, touched, command" but the function refuses an empty filter set with a thrown `Error("at least one of query, touched, or command is required")` that `index.ts` turns into a tool error.
2. Append filters as bound parameters: `touched` → `EXISTS (SELECT 1 FROM evidence v WHERE v.entry_rowid = e.rowid AND v.target GLOB ?)`, narrowed with `AND v.action = ?` unless `action` is `any` or absent; `command` → `EXISTS (... AND v.action = 'run' AND v.target LIKE '%' || ? || '%')`; `cwd` → `f.cwd GLOB ?`; `role` (other than `any`) → `e.role = ?`; `after`/`before` → `COALESCE(e.ts, f.last_activity) >= ?` / `< ?`.
3. Fetch `limit * 10 + 50` candidates, because dedup collapses forks after ranking.
4. Wrap the whole `prepare`/`all` in a try/catch: SQLite raises on a malformed FTS5 expression, and the message must come back as `Error("invalid query: …")`.
5. Group candidates by `entry_id`. For each group, load every `files` row holding that `entry_id` and pick `chooseOrigin`; the origin's row is the result, the rest become `continuations`. Then trim to `params.limit ?? 10`, preserving candidate order.
6. For each surviving result, load that file's skeleton — `SELECT entry_id AS id, parent_id AS parentId, ts FROM entries WHERE path = ? ORDER BY rowid` — and call `classifyEntry`. Cache skeletons per path within the call: several hits commonly share a file.
7. `name` comes from the latest `session_info` prose in the origin file; `snippet` is truncated to `options.maxSnippetChars` with an ellipsis and collapsed onto one line.

`resolveSession(db, idOrPath)` matches, in order: an exact `files.path`, an exact `files.session_id`, then a unique `session_id` prefix (`LIKE ? || '%'`, `undefined` when it matches zero or more than one).

`readEntries(db, request)` returns `TranscriptEntry[]` — `{ entryId, parentId, kind, role, ts, text, evidence }` — for three modes: `around` (the entry plus `radius` rows either side in `rowid` order), `branch` (the path from `leafId` to the root, root-first, via the skeleton and `pathToRoot`), and `last` (the final `count` rows by `rowid`). Evidence is loaded in one query per call and attached by rowid.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): query, rank, and assemble results"
```

---

### Task 9: Rendering

**Files:**
- Create: `pi/extensions/session-search/render.ts`
- Test: `pi/extensions/session-search/render.test.ts`

**Interfaces:**
- Consumes: `SearchResult` from `search.ts` (type-only).
- Produces: `renderResults(results, options): string`, `renderTranscript(entries, options): string`, `relativeTime(ts, now): string`, `shortId(id): string` from `render.ts`.

Both tools are written against an agent's context budget: every result competes with the user's actual work for room.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/session-search/render.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTime, renderResults, renderTranscript } from "./render.ts";

const NOW = new Date("2026-08-13T12:00:00.000Z");

const RESULT = {
  sessionId: "8f2a1c3d4e5f",
  path: "/sessions/--work-repo--/8f2a1c.jsonl",
  cwd: "/Users/me/Develop/private/agent-stuff",
  name: "Ripgrep vs SQLite for session search",
  entryId: "e7f3a2b1",
  ts: "2026-07-14T10:00:00.000Z",
  role: "user",
  kind: "message",
  snippet: "convinced that ripgrep might be problematic because of JSON",
  branch: { onMainLine: false, leafId: "f2", divergedAt: "2026-07-14T10:02:00.000Z", entriesPastDivergence: 40 },
  continuations: [
    { sessionId: "bbb", path: "/sessions/--work-repo--/b.jsonl" },
    { sessionId: "ccc", path: "/sessions/--work-repo--/c.jsonl" },
  ],
};

test("a result carries a name, a cwd, an openable id, and the branch story", () => {
  const text = renderResults([RESULT], { now: NOW, home: "/Users/me" });
  assert.match(text, /1\. "Ripgrep vs SQLite for session search"/);
  assert.match(text, /~\/Develop\/private\/agent-stuff/);
  assert.match(text, /2026-07-14 \(4 weeks ago\)/);
  assert.match(text, /session 8f2a1c/);
  assert.match(text, /entry e7f3a2b1/);
  assert.match(text, /side branch, diverged 07-14, ran 40 more entries/);
  assert.match(text, /also in 2 forks/);
  assert.match(text, /convinced that ripgrep/);
});

test("a main-line hit says nothing about branches and forks", () => {
  const text = renderResults(
    [{ ...RESULT, branch: { onMainLine: true, leafId: "z", divergedAt: undefined, entriesPastDivergence: 0 }, continuations: [] }],
    { now: NOW, home: "/Users/me" },
  );
  assert.doesNotMatch(text, /side branch/);
  assert.doesNotMatch(text, /forks/);
});

test("an empty result set says so once", () => {
  assert.match(renderResults([], { now: NOW, home: "/Users/me" }), /No matching sessions/);
});

test("a backlog note rides along with the results", () => {
  const text = renderResults([RESULT], { now: NOW, home: "/Users/me", backlog: { files: 120, bytes: 200000000 } });
  assert.match(text, /120 files/);
  assert.match(text, /\/session-index/);
});

test("relativeTime reads naturally at every scale", () => {
  assert.equal(relativeTime("2026-08-13T11:00:00.000Z", NOW), "1 hour ago");
  assert.equal(relativeTime("2026-08-12T12:00:00.000Z", NOW), "yesterday");
  assert.equal(relativeTime("2026-07-14T10:00:00.000Z", NOW), "4 weeks ago");
  assert.equal(relativeTime("2025-08-13T10:00:00.000Z", NOW), "1 year ago");
});

test("a transcript renders dialogue, and tools only on request, never their output", () => {
  const entries = [
    { entryId: "e1", parentId: null, kind: "message", role: "user", ts: "2026-07-14T10:00:00.000Z", text: "why not duckdb", evidence: [] },
    { entryId: "e2", parentId: "e1", kind: "message", role: "assistant", ts: "2026-07-14T10:01:00.000Z", text: "its fts index does not refresh", evidence: [{ tool: "read", action: "read", target: "/work/auth.ts" }] },
    { entryId: "e3", parentId: "e2", kind: "message", role: "toolResult", ts: "2026-07-14T10:02:00.000Z", text: undefined, evidence: [] },
  ];
  const plain = renderTranscript(entries, { includeTools: false, maxChars: 4000, offset: 0 });
  assert.match(plain, /user: why not duckdb/);
  assert.match(plain, /assistant: its fts index does not refresh/);
  assert.doesNotMatch(plain, /auth\.ts/);

  const withTools = renderTranscript(entries, { includeTools: true, maxChars: 4000, offset: 0 });
  assert.match(withTools, /read \/work\/auth\.ts/);
});

test("a transcript over the cap is truncated and says how to page on", () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    entryId: `e${index}`,
    parentId: null,
    kind: "message",
    role: "user",
    ts: "2026-07-14T10:00:00.000Z",
    text: `line number ${index} with enough text to add up`,
    evidence: [],
  }));
  const text = renderTranscript(many, { includeTools: false, maxChars: 300, offset: 0 });
  assert.ok(text.length < 600);
  assert.match(text, /truncated/i);
  assert.match(text, /offset/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/render.test.ts`
Expected: FAIL — cannot find module `./render.ts`.

- [ ] **Step 3: Write `render.ts`**

`shortId(id)` takes the first 6 characters. `relativeTime` steps through minutes, hours, `yesterday`, days, weeks, months, years, singularizing at 1. Paths under `home` are abbreviated to `~/…`.

`renderResults` emits, per result, the four-line block from the spec:

```
1. "Ripgrep vs SQLite for session search"   ~/Develop/private/agent-stuff
   2026-07-14 (4 weeks ago) · session 8f2a1c · entry e7f3a2b1
   side branch, diverged 07-14, ran 40 more entries · also in 2 forks
   …convinced that [ripgrep] might be problematic because of [JSON]…
```

The third line is omitted entirely when the hit is on the main line and has no continuations; each half is omitted independently. An unnamed session falls back to `"(unnamed)"`. Zero results render `No matching sessions.` A `backlog` option appends one line: `N files (M MB) not yet indexed — run /session-index to finish them.`

`renderTranscript` renders `role: text` per entry with a prose body, prefixes non-message kinds with their kind (`compaction: …`), skips entries with neither text nor rendered evidence, and appends `  → read /work/auth.ts` lines under an entry only when `includeTools` is set — tool names and targets, never outputs. It accumulates until `maxChars` and then stops with `… truncated at entry N of M — call again with offset: N to continue.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): render results and transcripts"
```

---

### Task 10: The pi surface — two tools and one command

**Files:**
- Create: `pi/extensions/session-search/index.ts`
- Test: `pi/extensions/session-search/index.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the default-exported extension function; `describeStatus(db, config): string` and `openForQuery(state): QueryHandle` exported for tests.

- [ ] **Step 1: Write the failing tests**

`index.ts` imports pi, so the test covers only what can be exercised without a running pi: the status text and the "database busy" degradation. Keep both behind exported pure-ish helpers.

`pi/extensions/session-search/index.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openIndex } from "./db.ts";
import { writeSession } from "./fixtures.ts";
import { describeStatus } from "./index.ts";
import { refreshIndex } from "./ingest.ts";

test("status reports coverage, sizes, and the skipped-line count", () => {
  const root = mkdtempSync(join(tmpdir(), "ss-status-"));
  const dbPath = join(root, "index.sqlite");
  const db = openIndex(dbPath);
  const sessions = join(root, "sessions");
  writeSession(sessions, {
    path: "--work-repo--/a.jsonl",
    id: "aaa",
    cwd: "/work/repo",
    entries: [{ id: "e1", parentId: null, role: "user", text: "indexed prose" }],
  });
  refreshIndex(db, { sessionsDir: sessions, budgetBytes: 1 << 30, includeThinking: false, excludeCwd: [] });

  const text = describeStatus(db, { dbPath, sessionsDir: sessions });
  assert.match(text, /Files indexed: 1/);
  assert.match(text, /Entries: 1/);
  assert.match(text, /Skipped lines: 0/);
  assert.match(text, /Index size:/);
  assert.match(text, new RegExp(sessions.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("status on an empty index says nothing is indexed", () => {
  const root = mkdtempSync(join(tmpdir(), "ss-status-empty-"));
  const dbPath = join(root, "index.sqlite");
  const text = describeStatus(openIndex(dbPath), { dbPath, sessionsDir: join(root, "absent") });
  assert.match(text, /Files indexed: 0/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/session-search/index.test.ts`
Expected: FAIL — cannot find module `./index.ts`.

- [ ] **Step 3: Write `index.ts`**

Module-level state: a `SessionSearchConfigLoader`, the current `ConfigSnapshot`, a lazily opened `DatabaseSync`, and the last refresh's `RefreshStats`. `session_start` refreshes the config and closes the database when `dbPath` changed, so an edited config takes effect without restarting pi.

A single `withIndex(ctx, run)` helper does the work every entry point shares:

1. refresh the config, resolving `dbPath`/`sessionsDir` against `ctx.cwd` when relative;
2. open the index (lazily, once);
3. run `refreshIndex` inside a try/catch — a `SQLITE_BUSY` after `busy_timeout` expires is caught, the query proceeds against the index as it stands, and the caller is told `not including sessions written since <last successful refresh time>`, per the spec's failure behavior;
4. call `run(db, config, notes)`.

Configuration errors are surfaced as a leading `session-search: <message>` line on the tool result, never thrown.

`session_search` — parameters via typebox, all optional, with a description that teaches both surfaces so the model does not reach only for `query`:

```ts
pi.registerTool({
  name: "session_search",
  label: "Session search",
  description: [
    "Find a past pi conversation across every project, session, and fork.",
    "",
    "Two surfaces are indexed:",
    "- what was SAID — `query` runs an FTS5 expression over user and assistant prose,",
    "  compaction and branch summaries, session names, and labels. Phrases in double",
    "  quotes, AND/OR/NOT, and prefix* all work.",
    "- what was DONE — `touched` globs a file path from tool evidence (narrow it with",
    "  `action: \"write\"` for \"sessions where I changed this file\"), and `command`",
    "  substring-matches a shell command that was run. Tool output is never indexed,",
    "  so search for the command, not for what it printed.",
    "",
    "At least one of `query`, `touched`, or `command` is required; the rest narrow.",
    "Results give a session id to open with `pi --resume`, an entry id, and a snippet.",
    "Use session_read to expand one without leaving this session.",
  ].join("\n"),
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "FTS5 expression over prose" })),
    touched: Type.Optional(Type.String({ description: "Glob over a file path from tool evidence, e.g. **/auth.ts" })),
    action: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("any")])),
    command: Type.Optional(Type.String({ description: "Substring of a shell command that was run" })),
    cwd: Type.Optional(Type.String({ description: "Glob over the session's working directory" })),
    after: Type.Optional(Type.String({ description: "ISO date or relative shorthand such as 14d" })),
    before: Type.Optional(Type.String()),
    role: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("any")])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) { /* withIndex → searchIndex → renderResults */ },
});
```

The result is `{ content: [{ type: "text", text }], details: { count, backlog } }`; a thrown `invalid query` becomes `isError: true` with the message, so the model can correct its own syntax.

`session_read` takes `session` (id or path), and one of `entry` + `around` (default 10), `branch` (a leaf id), or `last` (a count), plus `include_tools` (default `false`) and `offset` (default 0). It resolves the session with `resolveSession`, returns `isError` with the ambiguity when that fails, and renders with `renderTranscript` capped at 8000 characters. Its description states plainly that tool *outputs* are never returned — that cap is what keeps a 200-entry branch affordable.

`/session-index` handler: `--rebuild` calls `resetIndex` then a budget-free `refreshIndex`; bare invocation refreshes and prints `describeStatus`, which reports files indexed, entries, prose rows, index size on disk (`statSync(dbPath).size`), the last refresh's duration, and the cumulative skipped-line count from `meta`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/session-search/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Load the extension in a real pi and exercise it**

```bash
pi -e pi/extensions/session-search/index.ts
```

In that session: run `/session-index`, then ask for a `session_search` on a phrase you know is in an old session, then `session_read` the entry it returns. Confirm each returns rather than throwing.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add pi/extensions/session-search
git commit -m "feat(session-search): register the tools and the index command"
```

---

### Task 11: Documentation and the three measurements

**Files:**
- Create: `pi/extensions/session-search/README.md`
- Modify: `README.md` (the Extensions table)

- [ ] **Step 1: Take the three measurements the spec asks for**

Against the real corpus, with the extension loaded:

```bash
pi -e pi/extensions/session-search/index.ts
# /session-index --rebuild   → full backfill time
# /session-index             → steady-state refresh time on an unchanged corpus
du -sh ~/.pi/agent/sessions ~/.pi/agent/session-search/index.sqlite
```

Record: full backfill time over the corpus, index size against corpus size (the prose fraction), and steady-state refresh time. These decide whether newest-first ingest is a fallback or the default, and whether refresh stays imperceptible inside a tool call.

- [ ] **Step 2: Write the extension README**

`pi/extensions/session-search/README.md` covering: what it does; the two search surfaces with worked `session_search` examples for prose, `touched` + `action`, and `command`; `session_read`; `/session-index` and `--rebuild`; the configuration table from the spec with defaults and the three config sources in precedence order; where the index lives and that deleting it costs one rebuild; and the measured numbers from Step 1. Attribution: "`thurstonsand/pi-sessions` is the prior art for keeping a SQLite index of pi sessions; this extension keeps the index and drops handoff, messaging, and titling."

- [ ] **Step 3: Add the row to the root README**

In the Extensions table of `README.md`, after the `session-title` row:

```markdown
| [`session-search`](pi/extensions/session-search) | Finds a past conversation across every project, session, and fork. A self-refreshing SQLite FTS5 index over session JSONL backs `session_search` (what was said, and which files and commands were touched) and `session_read` (expand a hit without leaving the session). `/session-index` reports coverage. |
```

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test`

```bash
git add README.md pi/extensions/session-search/README.md
git commit -m "docs(session-search): document the extension and its measurements"
```
