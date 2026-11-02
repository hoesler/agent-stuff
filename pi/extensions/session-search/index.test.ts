import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeSession } from "./fixtures.ts";
import sessionSearchExtension from "./index.ts";

/** The extension against a stub of pi's API: it contributes a skill and a command, no tools. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "ss-ext-"));
  const sessions = join(root, "sessions");
  writeSession(sessions, {
    path: "--work-repo--/a.jsonl",
    id: "aaa",
    cwd: "/work/repo",
    entries: [{ id: "e1", parentId: null, role: "user", text: "indexed prose" }],
  });
  process.env.PI_SESSION_SEARCH_CONFIG = join(root, "config.json");
  writeFileSync(
    process.env.PI_SESSION_SEARCH_CONFIG,
    JSON.stringify({ version: 1, dbPath: join(root, "index.sqlite"), sessionsDir: sessions }),
  );

  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools: string[] = [];
  const pi = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerTool: (tool: any) => tools.push(tool.name),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any;
  sessionSearchExtension(pi);

  const notices: string[] = [];
  const ctx = { cwd: root, ui: { notify: (message: string) => notices.push(message) } } as any;
  return { handlers, commands, tools, ctx, notices };
}

test("contributes the skill, and registers no tools", async () => {
  const { handlers, tools } = harness();
  assert.deepEqual(tools, []);

  const { skillPaths } = await handlers.get("resources_discover")({ type: "resources_discover" });
  assert.equal(skillPaths.length, 1);
  assert.ok(existsSync(skillPaths[0]), skillPaths[0]);
  const skill = readFileSync(skillPaths[0], "utf8");
  assert.match(skill, /^---\nname: session-search\n/);
  // The skill's relative path must name a file that is actually there.
  assert.match(skill, /node \.\/cli\.ts search/);
  assert.ok(existsSync(join(skillPaths[0], "..", "cli.ts")));
});

test("/session-index reports status and --rebuild reindexes", async () => {
  const { commands, ctx, notices } = harness();
  await commands.get("session-index").handler("", ctx);
  assert.match(notices.at(-1)!, /Files indexed: 1/);

  await commands.get("session-index").handler("--rebuild", ctx);
  assert.match(notices.at(-1)!, /Entries: 1/);

  await commands.get("session-index").handler("bogus", ctx);
  assert.match(notices.at(-1)!, /Usage: \/session-index/);
});
