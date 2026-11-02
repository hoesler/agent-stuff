import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentDir, main } from "./cli.ts";
import { writeSession } from "./fixtures.ts";

const SESSION = "01a0cf09-c535-7458-8964-1708066115d0";

/**
 * `main` driven end to end over a real index built from real JSONL: the same
 * code path a `bash` call takes, minus the process boundary.
 */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "ss-cli-"));
  const sessions = join(root, "sessions");
  writeSession(sessions, {
    path: "--work-repo--/a.jsonl",
    id: SESSION,
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
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, dbPath: join(root, "index.sqlite"), sessionsDir: sessions }),
  );

  const run = async (argv: string[], options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      env: { PI_SESSION_SEARCH_CONFIG: configPath, ...options.env },
      cwd: root,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      stdin: () => options.stdin ?? "",
    });
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  };

  return { root, sessions, configPath, run };
}

test("search finds a hit and read expands it", async () => {
  const { run } = harness();

  const found = await run(["search", "ripgrep"]);
  assert.equal(found.code, 0);
  assert.match(found.stdout, /Ripgrep vs SQLite/);
  assert.match(found.stdout, new RegExp(`session ${SESSION}`));
  // The session name and the message both match; the name is ranked first.
  assert.ok(found.stdout.indexOf("entry n0") < found.stdout.indexOf("entry e1"));

  const touched = await run(["search", "--touched", "**/auth.ts", "--action", "write"]);
  assert.match(touched.stdout, /entry e2/);

  const read = await run(["read", SESSION, "--entry", "e1", "--around", "2", "--include-tools"]);
  assert.equal(read.code, 0);
  assert.match(read.stdout, /user: convinced that ripgrep/);
  assert.match(read.stdout, /write \/work\/repo\/src\/auth\.ts/);
  // Tool output is never stored, so it can never be returned.
  assert.doesNotMatch(read.stdout, /whole file body/);
});

test("a query on stdin needs no shell quoting", async () => {
  const { run } = harness();
  const found = await run(["search", "-"], { stdin: `"ripgrep might" AND json\n` });
  assert.equal(found.code, 0);
  assert.match(found.stdout, /entry e1/);
});

test("scope narrows to the working directory, and lineage comes from PI_SESSION_FILE", async () => {
  const { run, sessions } = harness();

  // The fixture session ran in /work/repo; the CLI runs in the temp root.
  const here = await run(["search", "ripgrep", "--scope", "project"]);
  assert.doesNotMatch(here.stdout, /entry e1/);

  const glob = await run(["search", "ripgrep", "--scope", "/work/**"]);
  assert.match(glob.stdout, /entry e1/);

  const orphan = await run(["search", "ripgrep", "--scope", "lineage"]);
  assert.match(orphan.stdout, /whole index/);

  const family = await run(["search", "ripgrep", "--scope", "lineage"], {
    env: { PI_SESSION_FILE: join(sessions, "--work-repo--/a.jsonl") },
  });
  assert.doesNotMatch(family.stdout, /whole index/);
  assert.match(family.stdout, /entry e1/);
});

test("a failed query exits 1 with the reason on stderr", async () => {
  const { run } = harness();

  const malformed = await run(["search", '"unbalanced']);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /invalid query/i);
  assert.equal(malformed.stdout, "");

  const empty = await run(["search"]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /at least one of/i);

  const unknown = await run(["read", "nope"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /No indexed session matches/);
});

test("an ambiguous session prefix names its candidates", async () => {
  const { run, sessions } = harness();
  // Started an hour after the harness session: the same leading UUIDv7 hex.
  writeSession(sessions, {
    path: "--work-repo--/b.jsonl",
    id: "01a0cf2b-7e10-7a3c-9d41-5b2e6f0c8a17",
    cwd: "/work/repo",
    created: "2026-07-14T10:00:00.000Z",
    entries: [{ id: "b1", parentId: null, role: "user", text: "a second session" }],
  });

  const ambiguous = await run(["read", "01a0cf"]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /"01a0cf" matches 2 sessions/);
  assert.match(ambiguous.stderr, /01a0cf2b-7e10-7a3c-9d41-5b2e6f0c8a17/);

  const found = await run(["read", "01a0cf2b"]);
  assert.match(found.stdout, /a second session/);
});

test("a wrong invocation exits 2 with usage", async () => {
  const { run } = harness();
  for (const argv of [
    [],
    ["frobnicate"],
    ["search", "x", "--bogus"],
    ["search", "two", "words"],
    ["search", "x", "--limit", "0"],
    ["search", "x", "--action", "delete"],
    ["read"],
    ["read", SESSION, "--entry", "e1", "--last", "3"],
    ["read", SESSION, "--around", "3"],
  ]) {
    const result = await run(argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.stderr, /Usage:/, argv.join(" "));
  }
});

test("status reports coverage, and --rebuild reindexes", async () => {
  const { run } = harness();
  const first = await run(["status"]);
  assert.match(first.stdout, /Files indexed: 1/);
  assert.match(first.stdout, /Skipped lines: 0/);

  const rebuilt = await run(["status", "--rebuild"]);
  assert.match(rebuilt.stdout, /Entries: 4/);
});

test("a broken config file is reported, and searching still works", async () => {
  const { run, root, configPath } = harness();
  writeFileSync(configPath, "{ not json");
  // The broken file falls back to defaults, which live under the agent dir.
  const result = await run(["status"], { env: { PI_CODING_AGENT_DIR: join(root, "agent") } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /session-search: .*config\.json/);
});

test("the agent dir follows pi's PI_CODING_AGENT_DIR rule", () => {
  assert.match(agentDir({}), /\.pi\/agent$/);
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/elsewhere" }), "/elsewhere");
  assert.match(agentDir({ PI_CODING_AGENT_DIR: "~/x" }), /\/x$/);
});

test("runs as a script, the way the skill invokes it", () => {
  const { configPath } = harness();
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const stdout = execFileSync(process.execPath, [cli, "search", "ripgrep"], {
    env: { ...process.env, PI_SESSION_SEARCH_CONFIG: configPath },
    encoding: "utf8",
  });
  assert.match(stdout, /Ripgrep vs SQLite/);
});
