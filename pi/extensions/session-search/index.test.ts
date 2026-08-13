import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openIndex } from "./db.ts";
import { writeSession } from "./fixtures.ts";
import sessionSearchExtension, { describeStatus } from "./index.ts";
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
  const stats = refreshIndex(db, {
    sessionsDir: sessions,
    budgetBytes: 1 << 30,
    includeThinking: false,
    excludeCwd: [],
  });

  const text = describeStatus(db, { dbPath, sessionsDir: sessions }, stats);
  assert.match(text, /Files indexed: 1/);
  assert.match(text, /Entries: 1/);
  assert.match(text, /Skipped lines: 0/);
  assert.match(text, /Index size:/);
  assert.match(text, new RegExp(sessions.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("status on an empty index says nothing is indexed", () => {
  const root = mkdtempSync(join(tmpdir(), "ss-status-empty-"));
  const dbPath = join(root, "index.sqlite");
  const text = describeStatus(openIndex(dbPath), {
    dbPath,
    sessionsDir: join(root, "absent"),
  });
  assert.match(text, /Files indexed: 0/);
  assert.match(text, /Entries: 0/);
});

/**
 * The registered tools, driven end to end against a stub of pi's extension API.
 * This is the closest a unit test gets to the real surface: the same execute()
 * functions the model calls, over a real index built from real JSONL.
 */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "ss-tools-"));
  const sessions = join(root, "sessions");
  writeSession(sessions, {
    path: "--work-repo--/a.jsonl",
    id: "8f2a1c",
    cwd: "/work/repo",
    created: "2026-07-14T09:00:00.000Z",
    entries: [
      { id: "n0", parentId: null, type: "session_info", name: "Ripgrep vs SQLite" },
      {
        id: "e1",
        parentId: "n0",
        role: "user",
        text: "convinced that ripgrep might be problematic because of JSON",
      },
      {
        id: "e2",
        parentId: "e1",
        role: "assistant",
        text: "sqlite fts5 keeps snippets",
        toolCalls: [{ name: "write", arguments: { file_path: "/work/repo/src/auth.ts" } }],
      },
      { id: "e3", parentId: "e2", toolResult: { toolName: "write", text: "the whole file body" } },
    ],
  });

  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    on: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any;

  sessionSearchExtension(pi);

  const notices: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => false,
    ui: { notify: (message: string) => notices.push(message) },
  } as any;

  process.env.PI_SESSION_SEARCH_CONFIG = join(root, "config.json");
  writeFileSync(
    process.env.PI_SESSION_SEARCH_CONFIG,
    JSON.stringify({ version: 1, dbPath: join(root, "index.sqlite"), sessionsDir: sessions }),
  );

  return { tools, commands, ctx, notices };
}

test("session_search finds a hit and session_read expands it", async () => {
  const { tools, ctx } = harness();

  const found = await tools.get("session_search").execute("c1", { query: "ripgrep" }, undefined, undefined, ctx);
  const text = found.content[0].text as string;
  assert.match(text, /Ripgrep vs SQLite/);
  assert.match(text, /session 8f2a1c/);
  assert.match(text, /entry e1/);
  // The session name and the message both match; the name is ranked first.
  assert.equal(found.details.count, 2);
  assert.ok(text.indexOf("entry n0") < text.indexOf("entry e1"));

  const touched = await tools
    .get("session_search")
    .execute("c2", { touched: "**/auth.ts", action: "write" }, undefined, undefined, ctx);
  assert.match(touched.content[0].text as string, /entry e2/);

  const read = await tools
    .get("session_read")
    .execute("c3", { session: "8f2a1c", entry: "e1", around: 2, include_tools: true }, undefined, undefined, ctx);
  const transcript = read.content[0].text as string;
  assert.match(transcript, /user: convinced that ripgrep/);
  assert.match(transcript, /write \/work\/repo\/src\/auth\.ts/);
  // Tool output is never stored, so it can never be returned.
  assert.doesNotMatch(transcript, /whole file body/);
});

test("a malformed query and an unknown session are thrown, not returned as results", async () => {
  const { tools, ctx } = harness();
  await assert.rejects(
    tools.get("session_search").execute("c1", { query: '"unbalanced' }, undefined, undefined, ctx),
    /invalid query/i,
  );
  await assert.rejects(
    tools.get("session_search").execute("c2", {}, undefined, undefined, ctx),
    /at least one of/i,
  );
  await assert.rejects(
    tools.get("session_read").execute("c3", { session: "nope" }, undefined, undefined, ctx),
    /No indexed session matches/,
  );
});

test("/session-index reports status and --rebuild reindexes", async () => {
  const { commands, ctx, notices } = harness();
  await commands.get("session-index").handler("", ctx);
  assert.match(notices.at(-1)!, /Files indexed: 1/);

  await commands.get("session-index").handler("--rebuild", ctx);
  assert.match(notices.at(-1)!, /Entries: 4/);

  await commands.get("session-index").handler("bogus", ctx);
  assert.match(notices.at(-1)!, /Usage: \/session-index/);
});
