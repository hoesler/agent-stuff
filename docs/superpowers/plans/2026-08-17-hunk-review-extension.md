# Hunk Review Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension whose single `/hunk` command reviews a changeset in the user's live Hunk window, or collects the inline notes the user left there and addresses them.

**Architecture:** Ten modules under `pi/extensions/hunk/`. `index.ts` is the only file that imports pi: it registers one command, one `resources_discover` handler, and one `agent_settled` handler. Everything else is pure or talks to an injected `exec`, so tests run under `node --test` against fake exec results captured from Hunk 0.18.2.

**Tech Stack:** TypeScript (type-checked only, never emitted — pi loads `.ts` directly), `node:test` + `node:assert/strict`, `@earendil-works/pi-coding-agent` (`ExtensionAPI`, `getAgentDir`), `@earendil-works/pi-tui` (`SelectList`, `Container`, `Text`, `DynamicBorder`), the `hunk` CLI (0.18.2+), `osascript` + Ghostty for spawning.

**Spec:** `docs/superpowers/specs/2026-08-17-hunk-review-design.md`

## Global Constraints

- **Two-space indentation, double quotes, trailing commas** — match `pi/extensions/session-search/` and `session-title/`, not `subagent/`, `tool-catalog/`, or `code-review/` (which use tabs). Task 11 edits `code-review/index.ts`, which is tab-indented: **use tabs in that file only.**
- **Imports of local modules use the `.ts` extension** (`./types.ts`) — `allowImportingTsExtensions` is on and pi loads TypeScript directly.
- **No new runtime dependencies.** Everything comes from Node built-ins and the already-present `@earendil-works/*` peer packages.
- **Every module except `index.ts` must import nothing from pi**, not even types. Session entries are read structurally from plain objects, as `session-title/transcript.ts` and `tool-catalog/state.ts` do.
- **The command is exactly `hunk`.** Config keys are exactly `version`, `hunkBin`, `spawn`, `noteAuthor`. The custom entry type is exactly `hunk-addressed`.
- **The extension must work with no config file at all.** A missing config is defaults, never an error.
- **Nothing throws out of a command handler.** Every failure path calls `ctx.ui.notify` with a message that names the next move (see the spec's "Failure behavior").
- **Never reword Hunk's own error messages.** Strip the `hunk: ` prefix and pass the rest through — Hunk's bundled skill maps each message to a cause.
- **Never start a turn the agent cannot complete.** If no session resolves, notify and return without `sendUserMessage`.
- **Never remove a user note.** The extension calls no `comment rm` and no `comment clear`, ever.
- **Verification after every task:** `npm run typecheck` and `npm test` from the repo root must both pass.

## Hunk JSON shapes, measured against 0.18.2

These are captured from a live session and are what the parsers must accept. Do not re-derive them.

`hunk session list --json` (exit 0 even with no sessions):

```json
{"sessions": [{
  "sessionId": "cd6f2ddd-2e76-4f7f-a190-10d196dc1a08",
  "pid": 95595,
  "cwd": "/private/tmp/probe",
  "repoRoot": "/private/tmp/probe",
  "title": "probe working tree",
  "fileCount": 1,
  "files": [{"path": "a.txt", "additions": 2, "deletions": 1, "hunkCount": 1}],
  "snapshot": {"state": {"liveCommentCount": 0}}
}]}
```

`hunk session comment list --repo <path> --type user --json`:

```json
{"comments": [{
  "noteId": "mcp:9c9703ef-58a3-4311-814b-b98cc4e84924",
  "source": "agent",
  "filePath": "a.txt",
  "hunkIndex": 0,
  "newRange": [2, 2],
  "body": "probe note\n\nwhy",
  "author": "pi",
  "createdAt": "2026-08-17T13:24:55.194Z",
  "editable": false
}]}
```

Every other `hunk session …` command exits **1** with `hunk: <message>` on **stderr** when it fails.

## Deviations from the spec, recorded

1. **Two modules more than the spec's eight.** `types.ts` holds the shared shapes so no module imports another for a type alone, and `args.ts` holds `/hunk` command-line parsing so `index.ts` stays pi-surface-only. The spec's module responsibilities are otherwise unchanged.

2. **The spec requires that a failed reply leaves a note out of the addressed set, without saying how the extension knows.** It cannot know at dispatch time — the agent does the work in a turn that has not run yet. This plan therefore marks notes addressed *after* the turn, on `agent_settled`, by correlating: a user note counts as addressed when an agent note authored by `noteAuthor` exists on the same file and line with a `createdAt` later than the dispatch timestamp. That rule is a pure function (`confirmAddressed`, Task 3) and is what Task 9 wires to the event.

3. **The spec's "base branch" picker entry does not compute a merge base.** `git`'s `main...HEAD` already means merge-base(main, HEAD)..HEAD, so the target forwards the branch name and lets git resolve it. One fewer subprocess, identical result.

---

### Task 1: Scaffolding, types, and config

**Files:**
- Create: `pi/extensions/hunk/tsconfig.json`
- Create: `pi/extensions/hunk/types.ts`
- Create: `pi/extensions/hunk/config.ts`
- Test: `pi/extensions/hunk/config.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `HunkConfig`, `SpawnMode`, `SPAWN_MODES`, `DEFAULTS`, `ConfigError`, `ConfigSnapshot`, `HunkSession`, `HunkNote`, `HunkFailure`, `HunkResult<T>` from `types.ts`; `resolveConfigPaths(options)`, `defaultConfig()`, `parseConfig(raw, path)`, `loadConfig(options)` from `config.ts`.

- [ ] **Step 1: Create the per-extension tsconfig**

`pi/extensions/hunk/tsconfig.json` — byte-identical to `pi/extensions/session-search/tsconfig.json`:

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
/** Where a window may be spawned from, when none is live. */
export type SpawnMode = "ghostty" | "never";

export const SPAWN_MODES: readonly SpawnMode[] = ["ghostty", "never"];

/**
 * A fully resolved configuration. Every field has a value: the extension works
 * with no config file at all, so parsing never produces a partial config the
 * rest of the code has to defend against.
 */
export interface HunkConfig {
  version: 1;
  /** Path to the binary, for installs outside PATH. */
  hunkBin: string;
  /** `never` always prints the command instead of opening a window. */
  spawn: SpawnMode;
  /** `--author` on notes the agent is told to write. */
  noteAuthor: string;
}

export const DEFAULTS = {
  hunkBin: "hunk",
  spawn: "ghostty" as SpawnMode,
  noteAuthor: "pi",
} as const;

export interface ConfigError {
  path: string;
  message: string;
}

/**
 * A snapshot always carries a usable config. Errors ride alongside it rather
 * than being thrown or swallowed: a typo in one field must not take `/hunk`
 * away, but it must not be silent either.
 */
export interface ConfigSnapshot {
  config: HunkConfig;
  paths: string[];
  errors: ConfigError[];
}

/** A live session, as `hunk session list --json` reports it. */
export interface HunkSession {
  sessionId: string;
  /** The field repository matching keys on. Absent for non-VCS inputs. */
  repoRoot: string | undefined;
  title: string | undefined;
  fileCount: number | undefined;
}

/** One note, as `hunk session comment list --json` reports it. */
export interface HunkNote {
  noteId: string;
  /** `user` for notes typed in the TUI, `agent` for notes added over the CLI. */
  source: string;
  filePath: string;
  /** First line of whichever range the note carries. */
  line: number | undefined;
  side: "new" | "old";
  body: string;
  author: string | undefined;
  createdAt: string | undefined;
}

/**
 * Why a Hunk call failed. `missing-binary` is the only kind the caller words
 * itself; `hunk-error` carries Hunk's own message, which must reach the user
 * unchanged so its bundled skill still maps it to a cause.
 */
export interface HunkFailure {
  kind: "missing-binary" | "hunk-error";
  message: string;
}

export type HunkResult<T> = { ok: true; value: T } | ({ ok: false } & HunkFailure);
```

- [ ] **Step 3: Write the failing config tests**

`pi/extensions/hunk/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig, parseConfig, resolveConfigPaths } from "./config.ts";

test("an untrusted project contributes no config path", () => {
  const paths = resolveConfigPaths({
    envPath: undefined,
    startupCwd: "/work/repo",
    agentDir: "/home/u/.pi/agent",
    projectTrusted: false,
  });
  assert.deepEqual(paths, ["/home/u/.pi/agent/hunk.json"]);
});

test("a trusted project appends its own path, lower first", () => {
  const paths = resolveConfigPaths({
    envPath: undefined,
    startupCwd: "/work/repo",
    agentDir: "/home/u/.pi/agent",
    projectTrusted: true,
  });
  assert.deepEqual(paths, ["/home/u/.pi/agent/hunk.json", "/work/repo/.pi/hunk.json"]);
});

test("an env path replaces both files and resolves against the startup cwd", () => {
  const paths = resolveConfigPaths({
    envPath: "custom/hunk.json",
    startupCwd: "/work/repo",
    agentDir: "/home/u/.pi/agent",
    projectTrusted: true,
  });
  assert.deepEqual(paths, ["/work/repo/custom/hunk.json"]);
});

test("defaults are the documented ones", () => {
  assert.deepEqual(defaultConfig(), {
    version: 1,
    hunkBin: "hunk",
    spawn: "ghostty",
    noteAuthor: "pi",
  });
});

test("a partial file overrides only what it names", () => {
  const config = parseConfig({ spawn: "never" }, "/c.json");
  assert.equal(config.spawn, "never");
  assert.equal(config.hunkBin, "hunk");
  assert.equal(config.noteAuthor, "pi");
});

test("an unknown property is an error, not a silent ignore", () => {
  assert.throws(() => parseConfig({ nope: 1 }, "/c.json"), /\/c\.json\.nope: unknown property/);
});

test("an unknown spawn mode names the allowed ones", () => {
  assert.throws(() => parseConfig({ spawn: "iterm" }, "/c.json"), /expected one of ghostty, never/);
});

test("an empty hunkBin is rejected rather than producing an unrunnable command", () => {
  assert.throws(() => parseConfig({ hunkBin: "  " }, "/c.json"), /expected a non-empty string/);
});

test("a missing file loads defaults with no errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunk-config-"));
  const snapshot = await loadConfig({
    envPath: undefined,
    startupCwd: dir,
    agentDir: dir,
    projectTrusted: false,
  });
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.config.hunkBin, "hunk");
});

test("a malformed file reports the error and still yields a usable config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunk-config-"));
  writeFileSync(join(dir, "hunk.json"), "{ not json");
  const snapshot = await loadConfig({
    envPath: undefined,
    startupCwd: dir,
    agentDir: dir,
    projectTrusted: false,
  });
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.config.spawn, "ghostty");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/config.test.ts`
Expected: FAIL — cannot find module `./config.ts`.

- [ ] **Step 5: Write `config.ts`**

```ts
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULTS,
  SPAWN_MODES,
  type ConfigError,
  type ConfigSnapshot,
  type HunkConfig,
  type SpawnMode,
} from "./types.ts";

const ROOT_KEYS = new Set(["version", "hunkBin", "spawn", "noteAuthor"]);

export interface ConfigPathOptions {
  envPath: string | undefined;
  startupCwd: string;
  agentDir: string;
  projectTrusted: boolean;
}

/**
 * Config sources, lowest precedence first. An env path replaces both files; the
 * project file is only consulted for a trusted project, matching how pi gates
 * `.pi/settings.json` and how `session-title` resolves its own config.
 */
export function resolveConfigPaths(options: ConfigPathOptions): string[] {
  const selected = options.envPath?.trim();
  if (selected) {
    return [isAbsolute(selected) ? selected : resolve(options.startupCwd, selected)];
  }
  const paths = [join(options.agentDir, "hunk.json")];
  if (options.projectTrusted) {
    paths.push(join(options.startupCwd, ".pi", "hunk.json"));
  }
  return paths;
}

export function defaultConfig(): HunkConfig {
  return { version: 1, hunkBin: DEFAULTS.hunkBin, spawn: DEFAULTS.spawn, noteAuthor: DEFAULTS.noteAuthor };
}

function nonEmptyString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}: expected a non-empty string`);
  }
  return value.trim();
}

function spawnMode(value: unknown, path: string, fallback: SpawnMode): SpawnMode {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !SPAWN_MODES.includes(value as SpawnMode)) {
    throw new Error(`${path}: expected one of ${SPAWN_MODES.join(", ")}`);
  }
  return value as SpawnMode;
}

/** Throws on the first problem, naming the exact key. Callers collect. */
export function parseConfig(raw: unknown, path: string): HunkConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected object`);
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) throw new Error(`${path}.${key}: unknown property`);
  }
  const base = defaultConfig();
  return {
    version: 1,
    hunkBin: nonEmptyString(input.hunkBin, `${path}.hunkBin`, base.hunkBin),
    spawn: spawnMode(input.spawn, `${path}.spawn`, base.spawn),
    noteAuthor: nonEmptyString(input.noteAuthor, `${path}.noteAuthor`, base.noteAuthor),
  };
}

/**
 * Later paths shallow-override earlier ones. A file that fails to read is not an
 * error — it is absent. A file that fails to parse is an error that still leaves
 * the previous config standing.
 */
export async function loadConfig(options: ConfigPathOptions): Promise<ConfigSnapshot> {
  const paths = resolveConfigPaths(options);
  const errors: ConfigError[] = [];
  let config = defaultConfig();
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = parseConfig(JSON.parse(text) as unknown, path);
      config = { ...config, ...parsed };
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { config, paths, errors };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/config.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Add the extension to the test script**

In `package.json`, append `pi/extensions/hunk/*.test.ts` to the `test` script, keeping the existing entries and their order:

```json
"test": "node --test pi/extensions/agent-modes/*.test.ts pi/extensions/session-title/*.test.ts pi/extensions/subagent/*.test.ts pi/extensions/session-search/*.test.ts pi/extensions/tool-catalog/*.test.ts pi/extensions/hunk/*.test.ts"
```

- [ ] **Step 8: Verify the whole suite**

Run: `npm run typecheck && npm test`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add pi/extensions/hunk/tsconfig.json pi/extensions/hunk/types.ts \
        pi/extensions/hunk/config.ts pi/extensions/hunk/config.test.ts package.json
git commit -m "feat(hunk): scaffold the extension with a config that works when absent"
```

---

### Task 2: Talking to Hunk

**Files:**
- Create: `pi/extensions/hunk/cli.ts`
- Test: `pi/extensions/hunk/cli.test.ts`

**Interfaces:**
- Consumes: `HunkNote`, `HunkResult`, `HunkSession` from `types.ts`.
- Produces: `Exec` (type), `ExecOutcome` (type), `hunkMessage(stderr)`, `parseSessions(stdout)`, `parseNotes(stdout)`, `createCli({ exec, hunkBin, cwd })` returning `HunkCli` with `listSessions()`, `reload(sessionId, target)`, `listNotes(sessionId, type)`, `skillPath()`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/cli.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCli, hunkMessage, parseNotes, parseSessions, type Exec } from "./cli.ts";

const LIST_JSON = JSON.stringify({
  sessions: [
    {
      sessionId: "abc",
      pid: 1,
      cwd: "/private/tmp/probe",
      repoRoot: "/private/tmp/probe",
      title: "probe working tree",
      fileCount: 2,
    },
    { sessionId: "def", repoRoot: "/other" },
  ],
});

const NOTES_JSON = JSON.stringify({
  comments: [
    {
      noteId: "mcp:1",
      source: "agent",
      filePath: "a.txt",
      hunkIndex: 0,
      newRange: [2, 2],
      body: "probe note\n\nwhy",
      author: "pi",
      createdAt: "2026-08-17T13:24:55.194Z",
    },
    {
      noteId: "live:2",
      source: "user",
      filePath: "b.ts",
      oldRange: [40, 41],
      body: "this leaks",
      createdAt: "2026-08-17T13:30:00.000Z",
    },
  ],
});

/** An exec that records its calls and replays canned outcomes in order. */
function fakeExec(outcomes: Array<{ stdout?: string; stderr?: string; code?: number }>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    const next = outcomes.shift() ?? { stdout: "", stderr: "", code: 0 };
    return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 };
  };
  return { exec, calls };
}

test("hunkMessage strips the binary's prefix and trims", () => {
  assert.equal(hunkMessage("hunk: No active Hunk sessions are registered.\n"), "No active Hunk sessions are registered.");
});

test("hunkMessage passes through a message that carries no prefix", () => {
  assert.equal(hunkMessage("  boom  "), "boom");
});

test("parseSessions reads sessionId and repoRoot, tolerating a missing repoRoot", () => {
  const sessions = parseSessions(LIST_JSON);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, "abc");
  assert.equal(sessions[0].repoRoot, "/private/tmp/probe");
  assert.equal(sessions[0].fileCount, 2);
  assert.equal(sessions[1].title, undefined);
});

test("parseSessions treats an empty array as no sessions", () => {
  assert.deepEqual(parseSessions('{"sessions": []}'), []);
});

test("parseSessions treats unparseable output as no sessions rather than throwing", () => {
  assert.deepEqual(parseSessions("not json"), []);
});

test("parseNotes takes the first line of whichever range a note carries", () => {
  const notes = parseNotes(NOTES_JSON);
  assert.equal(notes.length, 2);
  assert.deepEqual(
    { line: notes[0].line, side: notes[0].side, source: notes[0].source },
    { line: 2, side: "new", source: "agent" },
  );
  assert.deepEqual(
    { line: notes[1].line, side: notes[1].side, source: notes[1].source },
    { line: 40, side: "old", source: "user" },
  );
});

test("parseNotes skips an entry with no noteId", () => {
  assert.deepEqual(parseNotes('{"comments": [{"filePath": "a.txt"}]}'), []);
});

test("listSessions succeeds on the documented empty-array response", async () => {
  const { exec, calls } = fakeExec([{ stdout: '{"sessions": []}', code: 0 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listSessions();
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, []);
  assert.deepEqual(calls[0], { command: "hunk", args: ["session", "list", "--json"] });
});

test("a non-zero exit surfaces Hunk's own message", async () => {
  const { exec } = fakeExec([{ stderr: "hunk: No diff file matches b.ts", code: 1 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listNotes("abc", "user");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "hunk-error");
  assert.equal(!result.ok && result.message, "No diff file matches b.ts");
});

test("a failure with no output at all is reported as a missing binary", async () => {
  // This is exactly the shape pi's exec resolves for a spawn failure.
  const { exec } = fakeExec([{ stdout: "", stderr: "", code: 1 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listSessions();
  assert.equal(!result.ok && result.kind, "missing-binary");
  assert.match(!result.ok ? result.message : "", /installed and on PATH/);
});

test("a real Hunk error that mentions a missing file stays a Hunk error", async () => {
  const { exec } = fakeExec([{ stderr: "hunk: No such file or directory: nope.md", code: 1 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listNotes("abc", "user");
  assert.equal(!result.ok && result.kind, "hunk-error");
  assert.equal(!result.ok && result.message, "No such file or directory: nope.md");
});

test("an exec that throws is reported as a missing binary, not a crash", async () => {
  const exec: Exec = async () => {
    throw new Error("spawn hunk ENOENT");
  };
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listSessions();
  assert.equal(!result.ok && result.kind, "missing-binary");
});

test("listNotes targets a session by id and forwards the type filter", async () => {
  const { exec, calls } = fakeExec([{ stdout: NOTES_JSON, code: 0 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listNotes("abc", "user");
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ["session", "comment", "list", "abc", "--type", "user", "--json"]);
});

test("reload puts the nested command after a bare double dash", async () => {
  const { exec, calls } = fakeExec([{ stdout: "{}", code: 0 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).reload("abc", ["diff", "main...HEAD"]);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ["session", "reload", "abc", "--json", "--", "diff", "main...HEAD"]);
});

test("skillPath returns the trimmed path Hunk prints", async () => {
  const { exec, calls } = fakeExec([{ stdout: "/opt/hunk/skills/hunk-review/SKILL.md\n", code: 0 }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).skillPath();
  assert.equal(result.ok && result.value, "/opt/hunk/skills/hunk-review/SKILL.md");
  assert.deepEqual(calls[0].args, ["skill", "path"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/cli.test.ts`
Expected: FAIL — cannot find module `./cli.ts`.

- [ ] **Step 3: Write `cli.ts`**

```ts
import type { HunkNote, HunkResult, HunkSession } from "./types.ts";

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number;
}

/** The one seam onto the outside world. `pi.exec` satisfies this. */
export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecOutcome>;

/**
 * Hunk's own words, minus its prefix. Never reworded: its bundled skill maps
 * each message to a cause, including that "No active Hunk sessions" can mean a
 * sandbox blocked localhost rather than that no window is open.
 */
export function hunkMessage(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.startsWith("hunk:") ? trimmed.slice("hunk:".length).trim() : trimmed;
}

/**
 * Whether a *thrown* spawn error names a missing executable. Only the throw
 * path needs this: pi's own `exec` never throws, so this serves other `Exec`
 * implementations. It is deliberately not applied to a failed command's output
 * — see `run`.
 */
function looksMissing(text: string): boolean {
  return /ENOENT|command not found|No such file or directory/i.test(text);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(value: unknown): number | undefined {
  return Array.isArray(value) ? optionalNumber(value[0]) : undefined;
}

/**
 * Unparseable output means no sessions, never an exception. `session list`
 * exits 0 whether or not anything is live, so its body is the only signal, and
 * a malformed body must degrade to "nothing is live".
 */
export function parseSessions(stdout: string): HunkSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const sessions = record(parsed)?.sessions;
  if (!Array.isArray(sessions)) return [];
  const result: HunkSession[] = [];
  for (const entry of sessions) {
    const fields = record(entry);
    const sessionId = optionalString(fields?.sessionId);
    if (!fields || !sessionId) continue;
    result.push({
      sessionId,
      repoRoot: optionalString(fields.repoRoot),
      title: optionalString(fields.title),
      fileCount: optionalNumber(fields.fileCount),
    });
  }
  return result;
}

export function parseNotes(stdout: string): HunkNote[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const comments = record(parsed)?.comments;
  if (!Array.isArray(comments)) return [];
  const result: HunkNote[] = [];
  for (const entry of comments) {
    const fields = record(entry);
    const noteId = optionalString(fields?.noteId);
    const filePath = optionalString(fields?.filePath);
    if (!fields || !noteId || !filePath) continue;
    const newLine = firstLine(fields.newRange);
    const oldLine = firstLine(fields.oldRange);
    result.push({
      noteId,
      source: optionalString(fields.source) ?? "unknown",
      filePath,
      line: newLine ?? oldLine,
      side: newLine === undefined ? "old" : "new",
      body: optionalString(fields.body) ?? "",
      author: optionalString(fields.author),
      createdAt: optionalString(fields.createdAt),
    });
  }
  return result;
}

export interface HunkCli {
  listSessions(): Promise<HunkResult<HunkSession[]>>;
  reload(sessionId: string, target: string[]): Promise<HunkResult<void>>;
  listNotes(sessionId: string, type: "user" | "all"): Promise<HunkResult<HunkNote[]>>;
  skillPath(): Promise<HunkResult<string>>;
}

export function createCli(deps: { exec: Exec; hunkBin: string; cwd: string }): HunkCli {
  async function run(args: string[]): Promise<HunkResult<string>> {
    let outcome: ExecOutcome;
    try {
      outcome = await deps.exec(deps.hunkBin, args, { cwd: deps.cwd, timeout: 15000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: looksMissing(message) ? "missing-binary" : "hunk-error", message };
    }
    if (outcome.code === 0) return { ok: true, value: outcome.stdout };
    // pi's `exec` resolves a spawn failure as `{stdout:"", stderr:"", code:1}`,
    // discarding the ENOENT, so blank output on a failure is the only signal
    // that the binary never ran — Hunk itself always prints a message. Matching
    // the text instead would misread a real Hunk error that happens to mention
    // a missing file, and would send the user to reinstall Hunk over a bad path.
    if (!outcome.stderr.trim() && !outcome.stdout.trim()) {
      return {
        ok: false,
        kind: "missing-binary",
        message: `\`${deps.hunkBin}\` failed without output. Check that Hunk is installed and on PATH.`,
      };
    }
    return { ok: false, kind: "hunk-error", message: hunkMessage(outcome.stderr) || hunkMessage(outcome.stdout) };
  }

  return {
    async listSessions() {
      const result = await run(["session", "list", "--json"]);
      return result.ok ? { ok: true, value: parseSessions(result.value) } : result;
    },
    async reload(sessionId, target) {
      const result = await run(["session", "reload", sessionId, "--json", "--", ...target]);
      return result.ok ? { ok: true, value: undefined } : result;
    },
    async listNotes(sessionId, type) {
      const result = await run(["session", "comment", "list", sessionId, "--type", type, "--json"]);
      return result.ok ? { ok: true, value: parseNotes(result.value) } : result;
    },
    async skillPath() {
      const result = await run(["skill", "path"]);
      return result.ok ? { ok: true, value: result.value.trim() } : result;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/cli.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/hunk/cli.ts pi/extensions/hunk/cli.test.ts
git commit -m "feat(hunk): parse Hunk's JSON and pass its errors through unreworded"
```

---

### Task 3: The addressed set

**Files:**
- Create: `pi/extensions/hunk/pending.ts`
- Test: `pi/extensions/hunk/pending.test.ts`

**Interfaces:**
- Consumes: `HunkNote` from `types.ts`.
- Produces: `ADDRESSED_ENTRY` (the string `"hunk-addressed"`), `AddressedState`, `BranchEntry`, `restoreAddressed(entries)`, `pendingNotes(notes, addressed)`, `confirmAddressed(userNotes, allNotes, options)`, `nextAddressed(addressed, confirmed)`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/pending.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HunkNote } from "./types.ts";
import {
  ADDRESSED_ENTRY,
  confirmAddressed,
  nextAddressed,
  pendingNotes,
  restoreAddressed,
} from "./pending.ts";

function note(overrides: Partial<HunkNote> & { noteId: string }): HunkNote {
  return {
    source: "user",
    filePath: "a.ts",
    line: 10,
    side: "new",
    body: "fix this",
    author: undefined,
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

function entry(noteIds: unknown) {
  return { type: "custom", customType: ADDRESSED_ENTRY, data: { noteIds } };
}

test("no entries means nothing has been addressed", () => {
  assert.equal(restoreAddressed([]).size, 0);
});

test("the latest valid entry wins", () => {
  const addressed = restoreAddressed([entry(["a"]), entry(["a", "b"])]);
  assert.deepEqual([...addressed].sort(), ["a", "b"]);
});

test("a malformed later entry does not discard a good earlier one", () => {
  const addressed = restoreAddressed([entry(["a"]), entry("nope"), { type: "custom", customType: ADDRESSED_ENTRY }]);
  assert.deepEqual([...addressed], ["a"]);
});

test("entries from other extensions are ignored", () => {
  const addressed = restoreAddressed([
    { type: "custom", customType: "tool-catalog-overrides", data: { noteIds: ["x"] } },
    { type: "message" },
  ]);
  assert.equal(addressed.size, 0);
});

test("non-string ids inside a valid entry are dropped", () => {
  assert.deepEqual([...restoreAddressed([entry(["a", 7, null])])], ["a"]);
});

test("pending means user notes not already addressed", () => {
  const notes = [note({ noteId: "a" }), note({ noteId: "b" })];
  assert.deepEqual(
    pendingNotes(notes, new Set(["a"])).map((n) => n.noteId),
    ["b"],
  );
});

test("pending ignores notes the extension itself wrote", () => {
  const notes = [note({ noteId: "a" }), note({ noteId: "b", source: "agent" })];
  assert.deepEqual(
    pendingNotes(notes, new Set()).map((n) => n.noteId),
    ["a"],
  );
});

test("a reply on the same file and line after dispatch confirms a note", () => {
  const user = [note({ noteId: "u1", filePath: "a.ts", line: 10 })];
  const all = [
    ...user,
    note({
      noteId: "mcp:r1",
      source: "agent",
      author: "pi",
      filePath: "a.ts",
      line: 10,
      createdAt: "2026-08-17T12:00:00.000Z",
    }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), ["u1"]);
});

test("a reply from before dispatch does not confirm anything", () => {
  const user = [note({ noteId: "u1" })];
  const all = [
    ...user,
    note({ noteId: "mcp:old", source: "agent", author: "pi", createdAt: "2026-08-17T09:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("a reply by another author does not confirm a note", () => {
  const user = [note({ noteId: "u1" })];
  const all = [
    ...user,
    note({ noteId: "mcp:x", source: "agent", author: "someone-else", createdAt: "2026-08-17T12:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("a reply on a different line leaves its note unconfirmed", () => {
  const user = [note({ noteId: "u1", line: 10 })];
  const all = [
    ...user,
    note({ noteId: "mcp:x", source: "agent", author: "pi", line: 99, createdAt: "2026-08-17T12:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("two notes on one line with a single reply leave both pending", () => {
  const user = [note({ noteId: "u1", filePath: "a.ts", line: 10 }), note({ noteId: "u2", filePath: "a.ts", line: 10 })];
  const all = [
    ...user,
    note({ noteId: "mcp:r1", source: "agent", author: "pi", filePath: "a.ts", line: 10, createdAt: "2026-08-17T12:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("two notes on one line with two replies confirm both", () => {
  const user = [note({ noteId: "u1", filePath: "a.ts", line: 10 }), note({ noteId: "u2", filePath: "a.ts", line: 10 })];
  const all = [
    ...user,
    note({ noteId: "mcp:r1", source: "agent", author: "pi", filePath: "a.ts", line: 10, createdAt: "2026-08-17T12:00:00.000Z" }),
    note({ noteId: "mcp:r2", source: "agent", author: "pi", filePath: "a.ts", line: 10, createdAt: "2026-08-17T12:01:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), ["u1", "u2"]);
});

test("a reply created exactly at the dispatch time does not count", () => {
  const user = [note({ noteId: "u1" })];
  const all = [
    ...user,
    note({ noteId: "mcp:r1", source: "agent", author: "pi", createdAt: "2026-08-17T11:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("nextAddressed unions and sorts, without duplicating", () => {
  assert.deepEqual(nextAddressed(new Set(["b"]), ["a", "b"]), ["a", "b"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/pending.test.ts`
Expected: FAIL — cannot find module `./pending.ts`.

- [ ] **Step 3: Write `pending.ts`**

```ts
import type { HunkNote } from "./types.ts";

export const ADDRESSED_ENTRY = "hunk-addressed";

export interface AddressedState {
  noteIds: string[];
}

/** The slice of a session entry this module reads. No pi types. */
export interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * Appended as custom session entries rather than written to a config file, so
 * forking or walking the session tree carries the answers given on that branch.
 * The last valid entry wins; a malformed later entry must never discard a good
 * earlier one, as `tool-catalog/state.ts` also guarantees.
 */
export function restoreAddressed(entries: BranchEntry[]): Set<string> {
  let latest: string[] | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ADDRESSED_ENTRY) continue;
    const data = entry.data as AddressedState | undefined;
    if (!data || !Array.isArray(data.noteIds)) continue;
    latest = data.noteIds.filter((id): id is string => typeof id === "string");
  }
  return new Set(latest ?? []);
}

/**
 * Because the extension never removes a user note, "pending" cannot mean "any
 * user note" — every later bare `/hunk` would dispatch to fix mode forever.
 */
export function pendingNotes(notes: HunkNote[], addressed: ReadonlySet<string>): HunkNote[] {
  return notes.filter((note) => note.source === "user" && !addressed.has(note.noteId));
}

/**
 * Identifies the place a note hangs on. Joined on NUL, written as an escape so
 * the separator survives being copied: a raw NUL byte in this document made it
 * unsearchable and reached an implementer as a plain space.
 */
function anchorKey(note: HunkNote): string {
  return [note.filePath, note.side, note.line ?? "?"].join("\u0000");
}

/**
 * Which notes the agent actually answered. The extension cannot know this at
 * dispatch time — the turn has not run yet — so it correlates afterwards: a
 * user note is addressed when a reply of ours sits on the same anchor and was
 * created after the dispatch. Marking notes addressed optimistically would
 * bury a note the agent silently failed to answer.
 */
export function confirmAddressed(
  userNotes: HunkNote[],
  allNotes: HunkNote[],
  options: { author: string; since: string },
): string[] {
  const replies = allNotes.filter(
    (note) =>
      note.source !== "user" &&
      note.author === options.author &&
      note.createdAt !== undefined &&
      note.createdAt > options.since,
  );

  // Hunk allows several notes on one line, and a reply carries no reference to
  // the note it answers. So notes are confirmed per anchor, and only when the
  // replies there are at least as many as the notes: two questions answered
  // once leaves both pending. Erring this way costs a re-offer; erring the
  // other way buries a note the agent never answered, permanently, because the
  // addressed set only ever grows.
  const groups = new Map<string, HunkNote[]>();
  for (const note of userNotes) {
    const key = anchorKey(note);
    const group = groups.get(key);
    if (group) group.push(note);
    else groups.set(key, [note]);
  }

  const confirmed: string[] = [];
  for (const [key, group] of groups) {
    const answered = replies.filter((reply) => anchorKey(reply) === key).length;
    if (answered >= group.length) confirmed.push(...group.map((note) => note.noteId));
  }
  return confirmed;
}

export function nextAddressed(addressed: ReadonlySet<string>, confirmed: string[]): string[] {
  return [...new Set([...addressed, ...confirmed])].sort();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/pending.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/hunk/pending.ts pi/extensions/hunk/pending.test.ts
git commit -m "feat(hunk): tell a new note from one already answered"
```

---

### Task 4: Targets

**Files:**
- Create: `pi/extensions/hunk/targets.ts`
- Test: `pi/extensions/hunk/targets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Target` (discriminated union), `PickerItem`, `TARGET_PRESETS`, `targetArgs(target)`, `targetLabel(target)`, `rawTarget(tokens)`, `smartDefaultValue(dirty)`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/targets.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { TARGET_PRESETS, rawTarget, smartDefaultValue, targetArgs, targetLabel } from "./targets.ts";

test("the working tree is a bare diff", () => {
  assert.deepEqual(targetArgs({ kind: "workingTree" }), ["diff"]);
});

test("staged changes pass Hunk's own flag", () => {
  assert.deepEqual(targetArgs({ kind: "staged" }), ["diff", "--staged"]);
});

test("a base branch uses three dots so git resolves the merge base", () => {
  assert.deepEqual(targetArgs({ kind: "baseBranch", branch: "main" }), ["diff", "main...HEAD"]);
});

test("a commit is a show", () => {
  assert.deepEqual(targetArgs({ kind: "commit", sha: "abc1234" }), ["show", "abc1234"]);
});

test("a raw target keeps the user's tokens verbatim, pathspec included", () => {
  const target = rawTarget(["main...HEAD", "--", "src/ui"]);
  assert.deepEqual(targetArgs(target), ["diff", "main...HEAD", "--", "src/ui"]);
});

test("a raw target keeps its own copy of the tokens", () => {
  const tokens = ["main...HEAD"];
  const target = rawTarget(tokens);
  tokens.push("--", "src");
  assert.deepEqual(targetArgs(target), ["diff", "main...HEAD"]);
});

test("a raw target that already names a Hunk command is not prefixed", () => {
  assert.deepEqual(targetArgs(rawTarget(["show", "HEAD~1"])), ["show", "HEAD~1"]);
  assert.deepEqual(targetArgs(rawTarget(["diff", "--staged"])), ["diff", "--staged"]);
});

test("a bare flag is still a diff", () => {
  assert.deepEqual(targetArgs(rawTarget(["--staged"])), ["diff", "--staged"]);
});

test("labels name the target the way the user asked for it", () => {
  assert.equal(targetLabel({ kind: "workingTree" }), "working tree");
  assert.equal(targetLabel({ kind: "staged" }), "staged changes");
  assert.equal(targetLabel({ kind: "baseBranch", branch: "main" }), "main...HEAD");
  assert.equal(targetLabel({ kind: "commit", sha: "abc1234" }), "commit abc1234");
  assert.equal(targetLabel(rawTarget(["main...HEAD", "--", "src"])), "main...HEAD -- src");
});

test("the picker offers exactly the four supported targets", () => {
  assert.deepEqual(
    TARGET_PRESETS.map((preset) => preset.value),
    ["workingTree", "staged", "baseBranch", "commit"],
  );
});

test("a dirty tree preselects the working tree, a clean one the base branch", () => {
  assert.equal(smartDefaultValue(true), "workingTree");
  assert.equal(smartDefaultValue(false), "baseBranch");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/targets.test.ts`
Expected: FAIL — cannot find module `./targets.ts`.

- [ ] **Step 3: Write `targets.ts`**

```ts
/**
 * What a review is pointed at. `raw` is what the user typed: Hunk owns that
 * grammar, so it is forwarded unparsed and an invalid target fails in Hunk with
 * Hunk's own message.
 */
export type Target =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "baseBranch"; branch: string }
  | { kind: "commit"; sha: string }
  | { kind: "raw"; tokens: string[] };

export type PresetValue = "workingTree" | "staged" | "baseBranch" | "commit";

export interface PickerItem {
  value: PresetValue;
  label: string;
  description: string;
}

/** Keep this order stable: the picker's smart default is chosen by value. */
export const TARGET_PRESETS: readonly PickerItem[] = [
  { value: "workingTree", label: "Review the working tree", description: "" },
  { value: "staged", label: "Review staged changes", description: "--staged" },
  { value: "baseBranch", label: "Review against a base branch", description: "(local)" },
  { value: "commit", label: "Review a commit", description: "" },
];

/** Copies the tokens, so a caller reusing its parse buffer cannot mutate a stored target. */
export function rawTarget(tokens: string[]): Target {
  return { kind: "raw", tokens: [...tokens] };
}

const HUNK_COMMANDS = new Set(["diff", "show"]);

/** Arguments for `hunk <these>`, and equally for `session reload -- <these>`. */
export function targetArgs(target: Target): string[] {
  switch (target.kind) {
    case "workingTree":
      return ["diff"];
    case "staged":
      return ["diff", "--staged"];
    case "baseBranch":
      return ["diff", `${target.branch}...HEAD`];
    case "commit":
      return ["show", target.sha];
    case "raw":
      return HUNK_COMMANDS.has(target.tokens[0] ?? "") ? [...target.tokens] : ["diff", ...target.tokens];
  }
}

export function targetLabel(target: Target): string {
  switch (target.kind) {
    case "workingTree":
      return "working tree";
    case "staged":
      return "staged changes";
    case "baseBranch":
      return `${target.branch}...HEAD`;
    case "commit":
      return `commit ${target.sha}`;
    case "raw":
      return target.tokens.join(" ");
  }
}

/** The same reasoning `/review` applies: review what is uncommitted if there is any. */
export function smartDefaultValue(dirty: boolean): PresetValue {
  return dirty ? "workingTree" : "baseBranch";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/targets.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/hunk/targets.ts pi/extensions/hunk/targets.test.ts
git commit -m "feat(hunk): let Hunk own the target grammar"
```

---

### Task 5: Parsing the command line

**Files:**
- Create: `pi/extensions/hunk/args.ts`
- Test: `pi/extensions/hunk/args.test.ts`

**Interfaces:**
- Consumes: `Target`, `rawTarget` from `targets.ts`.
- Produces: `ParsedCommand` (union of `{ mode: "auto" | "review" | "fix"; target?: Target; sessionId?: string }` and `{ error: string }`), `parseCommand(args)`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/args.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./args.ts";
import { targetArgs } from "./targets.ts";

test("no arguments means decide from live state", () => {
  assert.deepEqual(parseCommand(""), { mode: "auto" });
  assert.deepEqual(parseCommand("   "), { mode: "auto" });
});

test("a bare target implies review", () => {
  const parsed = parseCommand("main...HEAD");
  assert.equal("mode" in parsed && parsed.mode, "review");
  assert.deepEqual("mode" in parsed && parsed.target && targetArgs(parsed.target), ["diff", "main...HEAD"]);
});

test("review with no target leaves the target for the picker", () => {
  assert.deepEqual(parseCommand("review"), { mode: "review", target: undefined });
});

test("review forwards every remaining token, pathspec included", () => {
  const parsed = parseCommand("review main...HEAD -- src/ui");
  assert.deepEqual("mode" in parsed && parsed.target && targetArgs(parsed.target), [
    "diff",
    "main...HEAD",
    "--",
    "src/ui",
  ]);
});

test("fix takes no target", () => {
  assert.deepEqual(parseCommand("fix"), { mode: "fix", target: undefined });
});

test("fix with a target is an error rather than a silent ignore", () => {
  assert.deepEqual(parseCommand("fix main...HEAD"), {
    error: "/hunk fix takes no target. Use /hunk review main...HEAD to review it.",
  });
});

test("--session is lifted out of any position", () => {
  assert.deepEqual(parseCommand("fix --session abc"), { mode: "fix", target: undefined, sessionId: "abc" });
  const parsed = parseCommand("review --session abc main...HEAD");
  assert.equal("mode" in parsed && parsed.sessionId, "abc");
  assert.deepEqual("mode" in parsed && parsed.target && targetArgs(parsed.target), ["diff", "main...HEAD"]);
});

test("--session with no value is an error", () => {
  assert.deepEqual(parseCommand("--session"), { error: "--session needs a session id." });
});

test("a repeated --session takes the last one", () => {
  assert.deepEqual(parseCommand("--session abc --session def"), { mode: "auto", sessionId: "def" });
});

test("a bare --session still leaves auto mode when nothing else is given", () => {
  assert.deepEqual(parseCommand("--session abc"), { mode: "auto", sessionId: "abc" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/args.test.ts`
Expected: FAIL — cannot find module `./args.ts`.

- [ ] **Step 3: Write `args.ts`**

```ts
import { rawTarget, type Target } from "./targets.ts";

export type ParsedCommand =
  | { mode: "auto" | "review" | "fix"; target?: Target; sessionId?: string }
  | { error: string };

/**
 * `/hunk [review|fix] [target…] [--session <id>]`. A target implies review,
 * because a target says which changeset to look at and addressing notes never
 * needs one.
 */
export function parseCommand(args: string): ParsedCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  let sessionId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== "--session") {
      rest.push(tokens[i]);
      continue;
    }
    const value = tokens[i + 1];
    if (!value) return { error: "--session needs a session id." };
    sessionId = value;
    i += 1;
  }

  const withSession = <T extends { mode: "auto" | "review" | "fix"; target?: Target }>(command: T) =>
    sessionId ? { ...command, sessionId } : command;

  if (rest.length === 0) return withSession({ mode: "auto" });

  const [head, ...tail] = rest;

  if (head === "fix") {
    if (tail.length > 0) {
      return { error: `/hunk fix takes no target. Use /hunk review ${tail.join(" ")} to review it.` };
    }
    return withSession({ mode: "fix", target: undefined });
  }

  if (head === "review") {
    return withSession({ mode: "review", target: tail.length > 0 ? rawTarget(tail) : undefined });
  }

  return withSession({ mode: "review", target: rawTarget(rest) });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/args.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/hunk/args.ts pi/extensions/hunk/args.test.ts
git commit -m "feat(hunk): parse one command into three modes"
```

---

### Task 6: Spawning a window

**Files:**
- Create: `pi/extensions/hunk/ghostty.ts`
- Test: `pi/extensions/hunk/ghostty.test.ts`

**Interfaces:**
- Consumes: `Exec` from `cli.ts`.
- Produces: `GHOSTTY_SPLIT_SCRIPT`, `shellQuote(value)`, `startupInput(hunkBin, target)`, `spawnWindow(deps, options)` returning `{ ok: true } | { ok: false; message: string }`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/ghostty.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "./cli.ts";
import { shellQuote, spawnWindow, startupInput } from "./ghostty.ts";

function fakeExec(outcome: { stdout?: string; stderr?: string; code?: number }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    return { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "", code: outcome.code ?? 0 };
  };
  return { exec, calls };
}

test("shellQuote wraps in single quotes and escapes embedded ones", () => {
  assert.equal(shellQuote("src/ui"), "'src/ui'");
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  assert.equal(shellQuote(""), "''");
});

test("the startup input is one runnable line, newline terminated", () => {
  assert.equal(startupInput("hunk", ["diff", "main...HEAD"]), "'hunk' 'diff' 'main...HEAD'\n");
});

test("a non-darwin platform refuses without invoking osascript", async () => {
  const { exec, calls } = fakeExec({ code: 0 });
  const result = await spawnWindow(
    { exec, platform: "linux" },
    { cwd: "/work", hunkBin: "hunk", target: ["diff"] },
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /only opens a window on macOS/);
  assert.deepEqual(calls, []);
});

test("darwin drives osascript with the script, cwd, and startup input", async () => {
  const { exec, calls } = fakeExec({ code: 0 });
  const result = await spawnWindow(
    { exec, platform: "darwin" },
    { cwd: "/work", hunkBin: "hunk", target: ["diff", "--staged"] },
  );
  assert.equal(result.ok, true);
  assert.equal(calls[0].command, "osascript");
  assert.equal(calls[0].args[0], "-e");
  assert.match(calls[0].args[1], /tell application "Ghostty"/);
  assert.deepEqual(calls[0].args.slice(2), ["--", "/work", "'hunk' 'diff' '--staged'\n"]);
});

test("a failing osascript reports its own stderr", async () => {
  const { exec } = fakeExec({ code: 1, stderr: "Ghostty got an error: not running" });
  const result = await spawnWindow(
    { exec, platform: "darwin" },
    { cwd: "/work", hunkBin: "hunk", target: ["diff"] },
  );
  assert.equal(!result.ok && result.message, "Ghostty got an error: not running");
});

test("an osascript that throws is reported, not raised", async () => {
  const exec: Exec = async () => {
    throw new Error("spawn osascript ENOENT");
  };
  const result = await spawnWindow(
    { exec, platform: "darwin" },
    { cwd: "/work", hunkBin: "hunk", target: ["diff"] },
  );
  assert.equal(!result.ok && result.message, "spawn osascript ENOENT");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/ghostty.test.ts`
Expected: FAIL — cannot find module `./ghostty.ts`.

- [ ] **Step 3: Write `ghostty.ts`**

```ts
import type { Exec } from "./cli.ts";

/**
 * Adapted from `mitsuhiko/agent-stuff`'s `split-fork.ts`: a new surface
 * configuration carries the working directory and the command to type, and the
 * focused terminal splits to the right — falling back to a new window when
 * none is open.
 */
export const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** What Ghostty types into the new surface. The newline runs it. */
export function startupInput(hunkBin: string, target: string[]): string {
  return `${[hunkBin, ...target].map(shellQuote).join(" ")}\n`;
}

export interface SpawnDeps {
  exec: Exec;
  platform: string;
}

export type SpawnOutcome = { ok: true } | { ok: false; message: string };

/**
 * Nothing else in the extension assumes Ghostty. A window the user opened by
 * hand is indistinguishable to every other module, so failing here is always
 * recoverable by printing the command for the user to run.
 */
export async function spawnWindow(
  deps: SpawnDeps,
  options: { cwd: string; hunkBin: string; target: string[] },
): Promise<SpawnOutcome> {
  if (deps.platform !== "darwin") {
    return { ok: false, message: "pi only opens a window on macOS with Ghostty." };
  }
  const input = startupInput(options.hunkBin, options.target);
  try {
    const outcome = await deps.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", options.cwd, input]);
    if (outcome.code !== 0) {
      return { ok: false, message: outcome.stderr.trim() || outcome.stdout.trim() || "osascript failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/ghostty.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/hunk/ghostty.ts pi/extensions/hunk/ghostty.test.ts
git commit -m "feat(hunk): open a review beside pi in a Ghostty split"
```

---

### Task 7: Resolving a session

**Files:**
- Create: `pi/extensions/hunk/session.ts`
- Test: `pi/extensions/hunk/session.test.ts`

**Interfaces:**
- Consumes: `HunkCli` from `cli.ts`, `SpawnOutcome` from `ghostty.ts`, `HunkSession` from `types.ts`.
- Produces: `POLL_INTERVAL_MS` (200), `POLL_CEILING_MS` (5000), `SessionDeps`, `Resolution` (union of `{ kind: "session"; sessionId: string }`, `{ kind: "ambiguous"; sessionIds: string[] }`, `{ kind: "none"; message: string }`), `ensureSession(deps, options)`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/session.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HunkCli } from "./cli.ts";
import { ensureSession, POLL_CEILING_MS, type SessionDeps } from "./session.ts";
import type { HunkResult, HunkSession } from "./types.ts";

function session(sessionId: string, repoRoot: string): HunkSession {
  return { sessionId, repoRoot, title: undefined, fileCount: undefined };
}

/**
 * A CLI whose `listSessions` replays one response per call, so a poll loop can
 * be handed "nothing, nothing, then the window".
 */
function fakeCli(responses: Array<HunkResult<HunkSession[]>>, reload?: HunkResult<void>) {
  const reloads: Array<{ sessionId: string; target: string[] }> = [];
  let listCalls = 0;
  const cli: HunkCli = {
    async listSessions() {
      listCalls += 1;
      return responses[Math.min(listCalls - 1, responses.length - 1)];
    },
    async reload(sessionId, target) {
      reloads.push({ sessionId, target });
      return reload ?? { ok: true, value: undefined };
    },
    async listNotes() {
      return { ok: true, value: [] };
    },
    async skillPath() {
      return { ok: true, value: "/skill/SKILL.md" };
    },
  };
  return { cli, reloads, listCalls: () => listCalls };
}

function deps(overrides: Partial<SessionDeps> & { cli: HunkCli }): SessionDeps {
  let clock = 0;
  return {
    gitRoot: async () => "/work/repo",
    realpath: async (path: string) => path,
    spawn: async () => ({ ok: true }),
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
}

test("an explicit session id is trusted without listing", async () => {
  const { cli, listCalls } = fakeCli([{ ok: true, value: [] }]);
  const result = await ensureSession(deps({ cli }), { sessionId: "abc" });
  assert.deepEqual(result, { kind: "session", sessionId: "abc" });
  assert.equal(listCalls(), 0);
});

test("one matching session with no target is used as it stands", async () => {
  const { cli, reloads } = fakeCli([{ ok: true, value: [session("abc", "/work/repo")] }]);
  const result = await ensureSession(deps({ cli }), {});
  assert.deepEqual(result, { kind: "session", sessionId: "abc" });
  assert.deepEqual(reloads, []);
});

test("one matching session with a target is reloaded onto it", async () => {
  const { cli, reloads } = fakeCli([{ ok: true, value: [session("abc", "/work/repo")] }]);
  const result = await ensureSession(deps({ cli }), { target: ["diff", "main...HEAD"] });
  assert.deepEqual(result, { kind: "session", sessionId: "abc" });
  assert.deepEqual(reloads, [{ sessionId: "abc", target: ["diff", "main...HEAD"] }]);
});

test("a failed reload reports Hunk's message and resolves no session", async () => {
  const { cli } = fakeCli([{ ok: true, value: [session("abc", "/work/repo")] }], {
    ok: false,
    kind: "hunk-error",
    message: "unknown revision",
  });
  const result = await ensureSession(deps({ cli }), { target: ["diff", "nope...HEAD"] });
  assert.deepEqual(result, { kind: "none", message: "unknown revision" });
});

test("sessions are matched on resolved paths, not the strings pi was given", async () => {
  const { cli } = fakeCli([{ ok: true, value: [session("abc", "/private/tmp/repo")] }]);
  const result = await ensureSession(
    deps({
      cli,
      gitRoot: async () => "/tmp/repo",
      realpath: async (path) => path.replace(/^\/tmp\//, "/private/tmp/"),
    }),
    {},
  );
  assert.deepEqual(result, { kind: "session", sessionId: "abc" });
});

test("a session in another repository is not a match", async () => {
  const { cli } = fakeCli([{ ok: true, value: [session("abc", "/elsewhere")] }]);
  const result = await ensureSession(deps({ cli }), {});
  assert.equal(result.kind, "none");
});

test("several matching sessions ask which one", async () => {
  const { cli } = fakeCli([
    { ok: true, value: [session("abc", "/work/repo"), session("def", "/work/repo")] },
  ]);
  const result = await ensureSession(deps({ cli }), {});
  assert.deepEqual(result, { kind: "ambiguous", sessionIds: ["abc", "def"] });
});

test("no git repository resolves nothing and says why", async () => {
  const { cli } = fakeCli([{ ok: true, value: [] }]);
  const result = await ensureSession(deps({ cli, gitRoot: async () => undefined }), {});
  assert.equal(result.kind, "none");
  assert.match(result.kind === "none" ? result.message : "", /not a git repository/i);
});

test("a listing failure propagates Hunk's message", async () => {
  const { cli } = fakeCli([{ ok: false, kind: "missing-binary", message: "hunk is not installed" }]);
  const result = await ensureSession(deps({ cli }), {});
  assert.deepEqual(result, { kind: "none", message: "hunk is not installed" });
});

test("no match and no target never spawns: an empty window holds no notes", async () => {
  const { cli } = fakeCli([{ ok: true, value: [] }]);
  let spawned = 0;
  const result = await ensureSession(
    deps({
      cli,
      spawn: async () => {
        spawned += 1;
        return { ok: true };
      },
    }),
    {},
  );
  assert.equal(spawned, 0);
  assert.equal(result.kind, "none");
  assert.match(result.kind === "none" ? result.message : "", /No Hunk window is open/);
});

test("no match with a target spawns, then polls until the window registers", async () => {
  const { cli, listCalls } = fakeCli([
    { ok: true, value: [] },
    { ok: true, value: [] },
    { ok: true, value: [session("abc", "/work/repo")] },
  ]);
  const result = await ensureSession(deps({ cli }), { target: ["diff"] });
  assert.deepEqual(result, { kind: "session", sessionId: "abc" });
  assert.equal(listCalls(), 3);
});

test("a failed spawn hands the user the command to run", async () => {
  const { cli } = fakeCli([{ ok: true, value: [] }]);
  const result = await ensureSession(
    deps({ cli, spawn: async () => ({ ok: false, message: "Ghostty is not running." }) }),
    { target: ["diff", "--staged"] },
  );
  assert.equal(result.kind, "none");
  const message = result.kind === "none" ? result.message : "";
  assert.match(message, /Ghostty is not running\./);
  assert.match(message, /hunk diff --staged/);
});

test("a realpath that throws falls back to comparing the paths as given", async () => {
  const { cli } = fakeCli([{ ok: true, value: [session("abc", "/work/repo")] }]);
  const result = await ensureSession(
    deps({
      cli,
      realpath: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    }),
    {},
  );
  assert.deepEqual(result, { kind: "session", sessionId: "abc" });
});

test("a poll that keeps failing names the failure instead of blaming registration", async () => {
  const { cli } = fakeCli([
    { ok: true, value: [] },
    { ok: false, kind: "hunk-error", message: "daemon socket closed" },
  ]);
  const result = await ensureSession(deps({ cli }), { target: ["diff"] });
  assert.equal(result.kind, "none");
  assert.match(result.kind === "none" ? result.message : "", /daemon socket closed/);
});

test("a poll that never finds the window gives up instead of hanging", async () => {
  const { cli, listCalls } = fakeCli([{ ok: true, value: [] }]);
  const result = await ensureSession(deps({ cli }), { target: ["diff"] });
  assert.equal(result.kind, "none");
  assert.match(result.kind === "none" ? result.message : "", /did not register/);
  assert.ok(listCalls() <= POLL_CEILING_MS / 200 + 2, "polling must be bounded");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/session.test.ts`
Expected: FAIL — cannot find module `./session.ts`.

- [ ] **Step 3: Write `session.ts`**

```ts
import type { HunkCli } from "./cli.ts";
import type { SpawnOutcome } from "./ghostty.ts";
import type { HunkSession } from "./types.ts";

export const POLL_INTERVAL_MS = 200;
export const POLL_CEILING_MS = 5000;

export interface SessionDeps {
  cli: HunkCli;
  /** The repository root, or undefined outside a repository. */
  gitRoot: () => Promise<string | undefined>;
  realpath: (path: string) => Promise<string>;
  spawn: (target: string[]) => Promise<SpawnOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type Resolution =
  | { kind: "session"; sessionId: string }
  | { kind: "ambiguous"; sessionIds: string[] }
  | { kind: "none"; message: string };

async function resolveOrSelf(realpath: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Hunk reports resolved paths, and on macOS a repository under `/tmp` reaches
 * pi as `/tmp/…` and Hunk as `/private/tmp/…`. Comparing the raw strings would
 * silently find no session in exactly the case a user is most likely to test.
 */
async function matching(deps: SessionDeps, sessions: HunkSession[], root: string): Promise<HunkSession[]> {
  const target = await resolveOrSelf(deps.realpath, root);
  const matches: HunkSession[] = [];
  for (const session of sessions) {
    if (!session.repoRoot) continue;
    if ((await resolveOrSelf(deps.realpath, session.repoRoot)) === target) matches.push(session);
  }
  return matches;
}

/**
 * A live session showing the target, or an explanation. Called without a target
 * — as fix mode calls it — there is nothing to spawn, so an absent window is
 * reported rather than created: a window opened now would be empty of the notes
 * it exists to read.
 */
export async function ensureSession(
  deps: SessionDeps,
  options: { target?: string[]; sessionId?: string },
): Promise<Resolution> {
  if (options.sessionId) return { kind: "session", sessionId: options.sessionId };

  const root = await deps.gitRoot();
  if (!root) {
    return { kind: "none", message: "This is not a git repository, so there is no review to match." };
  }

  const listed = await deps.cli.listSessions();
  if (!listed.ok) return { kind: "none", message: listed.message };

  const matches = await matching(deps, listed.value, root);

  if (matches.length > 1) {
    return { kind: "ambiguous", sessionIds: matches.map((session) => session.sessionId) };
  }

  if (matches.length === 1) {
    const found = matches[0];
    if (!options.target) return { kind: "session", sessionId: found.sessionId };
    const reloaded = await deps.cli.reload(found.sessionId, options.target);
    if (!reloaded.ok) return { kind: "none", message: reloaded.message };
    return { kind: "session", sessionId: found.sessionId };
  }

  if (!options.target) {
    return { kind: "none", message: "No Hunk window is open for this repository." };
  }

  const spawned = await deps.spawn(options.target);
  if (!spawned.ok) {
    return {
      kind: "none",
      message: `${spawned.message} Run this in your own terminal instead: hunk ${options.target.join(" ")}`,
    };
  }

  // A failing poll is not fatal — the daemon may not be listening yet — but the
  // last failure is kept, because "did not register" misdescribes a `hunk` that
  // has started erroring, and sending the user to re-run would waste their time.
  const deadline = deps.now() + POLL_CEILING_MS;
  let lastPollError: string | undefined;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const polled = await deps.cli.listSessions();
    if (!polled.ok) {
      lastPollError = polled.message;
      continue;
    }
    const found = await matching(deps, polled.value, root);
    if (found.length > 0) return { kind: "session", sessionId: found[0].sessionId };
  }

  return {
    kind: "none",
    message: lastPollError
      ? `The Hunk window opened but could not be reached: ${lastPollError}`
      : `The Hunk window opened but did not register within ${POLL_CEILING_MS / 1000}s. Run /hunk again.`,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/session.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Verify the whole suite**

Run: `npm run typecheck && npm test`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add pi/extensions/hunk/session.ts pi/extensions/hunk/session.test.ts
git commit -m "feat(hunk): reuse the window that is open before opening another"
```

---

### Task 8: The prompts

**Files:**
- Create: `pi/extensions/hunk/prompts.ts`
- Test: `pi/extensions/hunk/prompts.test.ts`

**Interfaces:**
- Consumes: `HunkNote` from `types.ts`.
- Produces: `renderWorkList(notes)`, `reviewPrompt(options)`, `fixPrompt(options)`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/hunk/prompts.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixPrompt, renderWorkList, reviewPrompt } from "./prompts.ts";
import type { HunkNote } from "./types.ts";

function note(overrides: Partial<HunkNote> & { noteId: string }): HunkNote {
  return {
    source: "user",
    filePath: "src/a.ts",
    line: 42,
    side: "new",
    body: "this leaks a handle",
    author: undefined,
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

test("the work list anchors each note to a file, side, and line", () => {
  const rendered = renderWorkList([note({ noteId: "live:1" })]);
  assert.match(rendered, /src\/a\.ts/);
  assert.match(rendered, /line 42 \(new side\)/);
  assert.match(rendered, /this leaks a handle/);
  assert.doesNotMatch(rendered, /--new-line|--old-line/);
});

test("an old-side note names the old side", () => {
  assert.match(renderWorkList([note({ noteId: "live:2", side: "old", line: 7 })]), /line 7 \(old side\)/);
});

test("a multi-line body stays indented under its own number", () => {
  const rendered = renderWorkList([
    note({ noteId: "live:4", body: "this leaks\nand it is load bearing" }),
    note({ noteId: "live:5", body: "second" }),
  ]);
  assert.match(rendered, /1\. .*\n   this leaks\n   and it is load bearing/);
  assert.match(rendered, /2\. /);
});

test("a note with no line still appears, without inventing one", () => {
  const rendered = renderWorkList([note({ noteId: "live:3", line: undefined })]);
  assert.match(rendered, /src\/a\.ts/);
  assert.doesNotMatch(rendered, /--new-line undefined/);
});

test("the review prompt names the target and the session it applies to", () => {
  const prompt = reviewPrompt({ sessionId: "abc", targetLabel: "main...HEAD", guidelines: undefined });
  assert.match(prompt, /main\.\.\.HEAD/);
  assert.match(prompt, /abc/);
  assert.match(prompt, /session review/);
  assert.match(prompt, /comment apply/);
});

test("the review prompt tells the agent not to annotate every hunk", () => {
  const prompt = reviewPrompt({ sessionId: "abc", targetLabel: "working tree", guidelines: undefined });
  assert.match(prompt, /not.*every hunk|Do not.*every hunk/i);
});

test("project guidelines are appended when they exist", () => {
  const prompt = reviewPrompt({ sessionId: "abc", targetLabel: "working tree", guidelines: "No bare excepts." });
  assert.match(prompt, /No bare excepts\./);
});

test("the fix prompt carries the notes and the author to reply as", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], author: "pi" });
  assert.match(prompt, /this leaks a handle/);
  assert.match(prompt, /--author pi/);
  assert.match(prompt, /abc/);
});

test("the fix prompt forbids removing the user's notes", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], author: "pi" });
  assert.match(prompt, /comment rm/);
  assert.match(prompt, /comment clear/);
  // Pin the polarity, not just the words: /not/ also matches "note".
  assert.match(prompt, /Never remove or clear/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test pi/extensions/hunk/prompts.test.ts`
Expected: FAIL — cannot find module `./prompts.ts`.

- [ ] **Step 3: Write `prompts.ts`**

```ts
import type { HunkNote } from "./types.ts";

/**
 * Prompts name commands as intent, never as flag-level syntax. Hunk's own
 * bundled skill is adopted at startup and documents the flags; duplicating them
 * here would drift on every Hunk release.
 */
/**
 * Where a note hangs, in prose. Deliberately not spelled as `--new-line 42`:
 * the anchor is data the agent needs, the flag that carries it is Hunk's to
 * name, and a work list full of renamed flags is worse than one the agent
 * translates itself using the adopted skill.
 */
function anchor(note: HunkNote): string {
  if (note.line === undefined) return note.filePath;
  return `${note.filePath} line ${note.line} (${note.side} side)`;
}

export function renderWorkList(notes: HunkNote[]): string {
  return notes
    .map((note, index) => `${index + 1}. ${anchor(note)}\n   ${note.body.split("\n").join("\n   ")}`)
    .join("\n\n");
}

export function reviewPrompt(options: {
  sessionId: string;
  targetLabel: string;
  guidelines: string | undefined;
}): string {
  const parts = [
    `Review the changeset now loaded in the Hunk session \`${options.sessionId}\` (${options.targetLabel}).`,
    "",
    "Work through the Hunk session commands, not the interactive TUI:",
    "",
    "1. Read the file and hunk structure first with `session review` in its structured form; it omits patch text on purpose.",
    "2. Pull raw diff text only for the files you actually need to read closely.",
    "3. Leave your findings as inline notes in one `comment apply` batch, each anchored to the file and line it is about.",
    "4. Navigate to the first note so the user lands where the review starts.",
    "5. Summarize what you found in chat, briefly. The notes carry the detail.",
    "",
    "Do not leave a note on every hunk. The user can already see the diff; annotate what they would not spot themselves — intent, structure, risks, and follow-ups. A note per hunk turns the window into noise.",
  ];
  if (options.guidelines) {
    parts.push("", "This project has its own review guidelines:", "", options.guidelines);
  }
  return parts.join("\n");
}

export function fixPrompt(options: { sessionId: string; notes: HunkNote[]; author: string }): string {
  return [
    `The user left ${options.notes.length === 1 ? "a note" : `${options.notes.length} notes`} on the changeset in the Hunk session \`${options.sessionId}\`. Address ${options.notes.length === 1 ? "it" : "each of them"}.`,
    "",
    renderWorkList(options.notes),
    "",
    "For each one: make the change, then reply on the same file, side, and line with `comment add`, using",
    `\`--author ${options.author}\`, saying what you changed. The reply is how the user sees which notes you handled without rereading the diff.`,
    "",
    "Never remove or clear the user's notes — no `comment rm`, no `comment clear`. They decide when a note is done.",
    "",
    "If you disagree with a note, say so in the reply and leave the code alone rather than half-applying it.",
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test pi/extensions/hunk/prompts.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/hunk/prompts.ts pi/extensions/hunk/prompts.test.ts
git commit -m "feat(hunk): carry workflow in the prompts and leave syntax to Hunk's skill"
```

---

### Task 9: Wiring it to pi

**Files:**
- Create: `pi/extensions/hunk/index.ts`
- Test: none — this file is pi surface only. Everything it decides is already tested in Tasks 1–8.

**Interfaces:**
- Consumes: everything produced by Tasks 1–8.
- Produces: the extension's default export, `export default function hunkExtension(pi: ExtensionAPI)`.

- [ ] **Step 1: Write `index.ts`**

```ts
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, DynamicBorder, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { parseCommand } from "./args.ts";
import { createCli, type Exec, type HunkCli } from "./cli.ts";
import { defaultConfig, loadConfig } from "./config.ts";
import { spawnWindow } from "./ghostty.ts";
import {
  ADDRESSED_ENTRY,
  confirmAddressed,
  nextAddressed,
  pendingNotes,
  restoreAddressed,
  type AddressedState,
} from "./pending.ts";
import { fixPrompt, reviewPrompt } from "./prompts.ts";
import { ensureSession, type Resolution } from "./session.ts";
import {
  smartDefaultValue,
  TARGET_PRESETS,
  targetArgs,
  targetLabel,
  type PresetValue,
  type Target,
} from "./targets.ts";
import type { HunkConfig, HunkNote } from "./types.ts";

const SPAWN_HINT = "Open a review yourself with `hunk diff`, then run /hunk again.";

export default function hunkExtension(pi: ExtensionAPI) {
  let config: HunkConfig = defaultConfig();
  /** Set when a fix turn is in flight, so `agent_settled` knows what to confirm. */
  let outstandingFix: { sessionId: string; notes: HunkNote[]; since: string } | undefined;

  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  function cliFor(cwd: string): HunkCli {
    return createCli({ exec, hunkBin: config.hunkBin, cwd });
  }

  async function gitRoot(cwd: string): Promise<string | undefined> {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (result.code !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  async function isDirty(cwd: string): Promise<boolean> {
    const result = await pi.exec("git", ["status", "--porcelain"], { cwd });
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async function localBranches(cwd: string): Promise<string[]> {
    const result = await pi.exec(
      "git",
      ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
      { cwd },
    );
    if (result.code !== 0) return [];
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async function recentCommits(cwd: string): Promise<Array<{ sha: string; title: string }>> {
    const result = await pi.exec("git", ["log", "-n", "15", "--format=%h%x09%s"], { cwd });
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length === 2 && parts[0])
      .map(([sha, title]) => ({ sha, title }));
  }

  /** The same `ctx.ui.custom` + `SelectList` shape `code-review` and `agent-modes` use. */
  async function pick(ctx: ExtensionCommandContext, title: string, items: SelectItem[], selected: number) {
    if (items.length === 0) return undefined;
    return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));
      const list = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      if (selected >= 0) list.setSelectedIndex(selected);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "enter to confirm, esc to cancel")));
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function pickTarget(ctx: ExtensionCommandContext): Promise<Target | undefined> {
    const presets = TARGET_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }));
    const smart = smartDefaultValue(await isDirty(ctx.cwd));
    const chosen = await pick(
      ctx,
      "Review with Hunk",
      presets,
      presets.findIndex((preset) => preset.value === smart),
    );
    if (!chosen) return undefined;

    if (chosen === ("workingTree" satisfies PresetValue)) return { kind: "workingTree" };
    if (chosen === ("staged" satisfies PresetValue)) return { kind: "staged" };

    if (chosen === ("baseBranch" satisfies PresetValue)) {
      const branches = await localBranches(ctx.cwd);
      if (branches.length === 0) {
        ctx.ui.notify("No local branches to compare against.", "warning");
        return undefined;
      }
      const branch = await pick(
        ctx,
        "Base branch",
        branches.map((name) => ({ value: name, label: name, description: "" })),
        0,
      );
      return branch ? { kind: "baseBranch", branch } : undefined;
    }

    const commits = await recentCommits(ctx.cwd);
    if (commits.length === 0) {
      ctx.ui.notify("No commits to review.", "warning");
      return undefined;
    }
    const sha = await pick(
      ctx,
      "Commit",
      commits.map((commit) => ({ value: commit.sha, label: commit.sha, description: commit.title })),
      0,
    );
    return sha ? { kind: "commit", sha } : undefined;
  }

  async function resolve(ctx: ExtensionCommandContext, target: Target | undefined, sessionId: string | undefined) {
    return ensureSession(
      {
        cli: cliFor(ctx.cwd),
        gitRoot: () => gitRoot(ctx.cwd),
        realpath: (path) => realpath(path),
        spawn: (args) =>
          config.spawn === "never"
            ? Promise.resolve({ ok: false as const, message: "Opening a window is disabled (`spawn: never`)." })
            : spawnWindow({ exec, platform: process.platform }, { cwd: ctx.cwd, hunkBin: config.hunkBin, target: args }),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: () => Date.now(),
      },
      { target: target ? targetArgs(target) : undefined, sessionId },
    );
  }

  /** Takes the non-session arms only, so the union stays discriminated. */
  function reportUnresolved(ctx: ExtensionCommandContext, resolution: Exclude<Resolution, { kind: "session" }>) {
    if (resolution.kind === "ambiguous") {
      const ids = resolution.sessionIds.join(", ");
      ctx.ui.notify(`Several Hunk windows show this repository: ${ids}. Re-run with --session <id>.`, "warning");
      return;
    }
    ctx.ui.notify(resolution.message, "warning");
  }

  /** The same file `/review` reads, so guidelines written once apply to both. */
  async function projectGuidelines(cwd: string): Promise<string | undefined> {
    try {
      const text = await readFile(join(cwd, "REVIEW_GUIDELINES.md"), "utf8");
      return text.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async function startReview(ctx: ExtensionCommandContext, target: Target, sessionId: string | undefined) {
    const resolution = await resolve(ctx, target, sessionId);
    if (resolution.kind !== "session") {
      reportUnresolved(ctx, resolution);
      return;
    }
    ctx.ui.notify(`Reviewing ${targetLabel(target)} in Hunk.`, "info");
    pi.sendUserMessage(
      reviewPrompt({
        sessionId: resolution.sessionId,
        targetLabel: targetLabel(target),
        guidelines: await projectGuidelines(ctx.cwd),
      }),
    );
  }

  /**
   * `undefined` means fix mode could not even look; `{ empty: true }` means it
   * looked and found nothing new. Auto mode needs those apart: only the second
   * should fall through to a review.
   */
  async function startFix(
    ctx: ExtensionCommandContext,
    sessionId: string | undefined,
    explicit: boolean,
  ): Promise<{ empty: boolean } | undefined> {
    const resolution = await resolve(ctx, undefined, sessionId);
    if (resolution.kind !== "session") {
      if (explicit) reportUnresolved(ctx, resolution);
      return undefined;
    }

    const notes = await cliFor(ctx.cwd).listNotes(resolution.sessionId, "user");
    if (!notes.ok) {
      ctx.ui.notify(notes.message, "error");
      return undefined;
    }

    const pending = pendingNotes(notes.value, restoreAddressed(ctx.sessionManager.getBranch()));
    if (pending.length === 0) {
      if (explicit) ctx.ui.notify("No new notes in the Hunk window.", "info");
      return { empty: true };
    }

    outstandingFix = { sessionId: resolution.sessionId, notes: pending, since: new Date().toISOString() };
    ctx.ui.notify(`Addressing ${pending.length} note${pending.length === 1 ? "" : "s"} from Hunk.`, "info");
    pi.sendUserMessage(fixPrompt({ sessionId: resolution.sessionId, notes: pending, author: config.noteAuthor }));
    return { empty: false };
  }

  /**
   * Adopt the binary's own manual instead of documenting its CLI here, so the
   * agent's knowledge of Hunk tracks the installed version.
   */
  pi.on("resources_discover", async () => {
    const path = await createCli({ exec, hunkBin: config.hunkBin, cwd: process.cwd() }).skillPath();
    if (!path.ok || !path.value) return {};
    // pi's loader takes either a directory or a markdown file (core/skills.js),
    // so the printed SKILL.md path goes in verbatim: exact, and it cannot pick
    // up whatever else a future Hunk release ships alongside it.
    return { skillPaths: [path.value] };
  });

  pi.on("session_start", async (_event, ctx) => {
    const snapshot = await loadConfig({
      envPath: process.env.PI_HUNK_CONFIG,
      startupCwd: ctx.cwd,
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
    });
    config = snapshot.config;
    for (const error of snapshot.errors) ctx.ui.notify(`hunk config: ${error.message}`, "warning");
  });

  /**
   * Notes are marked addressed only after the turn, and only where a reply of
   * ours landed on the same anchor. Marking at dispatch would bury a note the
   * agent silently failed to answer.
   */
  pi.on("agent_settled", async (_event, ctx) => {
    const fix = outstandingFix;
    if (!fix) return;
    outstandingFix = undefined;

    const all = await cliFor(ctx.cwd).listNotes(fix.sessionId, "all");
    if (!all.ok) return ctx.ui.notify(all.message, "warning");

    const confirmed = confirmAddressed(fix.notes, all.value, { author: config.noteAuthor, since: fix.since });
    if (confirmed.length > 0) {
      pi.appendEntry<AddressedState>(ADDRESSED_ENTRY, {
        noteIds: nextAddressed(restoreAddressed(ctx.sessionManager.getBranch()), confirmed),
      });
    }
    const unanswered = fix.notes.length - confirmed.length;
    if (unanswered > 0) {
      ctx.ui.notify(
        `${unanswered} note${unanswered === 1 ? "" : "s"} got no reply in Hunk and stay pending.`,
        "warning",
      );
    }
  });

  pi.registerCommand("hunk", {
    description: "Review a changeset in Hunk, or address the notes left there. Usage: /hunk [review|fix] [target]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hunk requires interactive mode", "error");
        return;
      }

      const parsed = parseCommand(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      if (parsed.mode === "fix") {
        await startFix(ctx, parsed.sessionId, true);
        return;
      }

      if (parsed.mode === "auto") {
        const attempted = await startFix(ctx, parsed.sessionId, false);
        if (attempted && !attempted.empty) return;
      }

      const target = parsed.mode === "review" && parsed.target ? parsed.target : await pickTarget(ctx);
      if (!target) {
        ctx.ui.notify(`Cancelled. ${SPAWN_HINT}`, "info");
        return;
      }
      await startReview(ctx, target, parsed.sessionId);
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `ctx.ui.custom`'s generic or `SelectList`'s constructor disagrees, compare against the working call in `pi/extensions/code-review/index.ts:964` and match it exactly rather than casting.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS — no test targets `index.ts`, but nothing may regress.

- [ ] **Step 4: (resolved — no action)**

The spec's remaining unknown was whether `skillPaths` wants the skill's directory or its parent. Answered from pi's own loader rather than by experiment: `core/skills.js` resolves each entry with `statSync` and accepts **either** a directory (recursively scanned) **or** a file ending in `.md`. So the printed `SKILL.md` path is passed verbatim, as the handler above now does. Nothing to run here.

- [ ] **Step 5: Smoke-test both modes against a real window**

```bash
hunk diff                             # in a second terminal, in this repo
pi -e pi/extensions/hunk/index.ts     # then: /hunk review
```

Expected: the command finds the live window without spawning a second one, reloads it onto the chosen target, and the agent leaves inline notes. Then leave a note of your own in the TUI, and run `/hunk`: it must dispatch to fix mode, and running `/hunk` again afterwards must report no new notes.

- [ ] **Step 6: Commit**

```bash
git add pi/extensions/hunk/index.ts
git commit -m "feat(hunk): one command that reviews a changeset or answers its notes"
```

---

### Task 10: Documentation

**Files:**
- Create: `pi/extensions/hunk/README.md`
- Modify: `README.md` (the Extensions table)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the extension README**

`pi/extensions/hunk/README.md`. Follow the shape of `pi/extensions/tool-catalog/README.md`: what it does, usage, configuration table, and what it deliberately leaves out. Cover:

- The `/hunk`, `/hunk <target>`, `/hunk review`, `/hunk fix`, and `--session <id>` forms, and the dispatch rule for bare `/hunk`.
- That Hunk runs in the user's own terminal, that a live window is reused and reloaded, and that a missing one is spawned as a Ghostty right-split on macOS only.
- That the agent's knowledge of Hunk's CLI comes from `hunk skill path`, adopted at startup — so upgrading Hunk upgrades what the agent knows.
- That user notes are never removed, and that replies are how a handled note is marked; that the addressed set lives in the session, so relaunching Hunk makes every note read as new again.
- The config table: `hunkBin`, `spawn`, `noteAuthor`, plus `PI_HUNK_CONFIG` and the `~/.pi/agent/hunk.json` / `.pi/hunk.json` precedence.
- Requirements: Hunk 0.18.2+, and Ghostty plus macOS only for spawning.
- Attribution: the Ghostty split is adapted from `mitsuhiko/agent-stuff`'s `split-fork.ts`.

- [ ] **Step 2: Add the row to the root README**

In `README.md`, add to the Extensions table, after the `code-review` row:

```markdown
| [`hunk`](pi/extensions/hunk) | One `/hunk` command over a live [Hunk](https://www.hunk.dev) diff window: it reviews a changeset and leaves findings as inline notes, or collects the notes you left there and addresses them, replying on each line. Reuses the window you have open, and adopts Hunk's own agent skill so its CLI knowledge tracks the installed binary. |
```

- [ ] **Step 3: Commit**

```bash
git add pi/extensions/hunk/README.md README.md
git commit -m "docs(hunk): document the command, the config, and what it leaves alone"
```

---

### Task 11: Offer the Hunk surface from `/review`

**Files:**
- Modify: `pi/extensions/code-review/index.ts` (insert after the `projectGuidelines` block at line 1438, before `const modeHint`)
- Test: none — this is a prompt fragment behind a liveness probe. `code-review` has no test setup, and adding one is out of scope for this plan.

**Interfaces:**
- Consumes: nothing from the `hunk` extension. This file must not import it — the two extensions stay independent, and `/review` must behave exactly as it does today when Hunk is absent.
- Produces: nothing.

**This file is tab-indented. Use tabs.**

- [ ] **Step 1: Add the probe helper**

Insert next to the other module-level helpers in `pi/extensions/code-review/index.ts`, immediately before `async function loadProjectReviewGuidelines` (line 281):

```ts
/**
 * The id of a live Hunk window showing this repository, if there is one.
 *
 * Deliberately duplicated rather than imported from the `hunk` extension: a
 * shared module would couple two extensions the user can enable separately,
 * and this is one probe against a documented, stable JSON shape. When Hunk is
 * absent, `/review` behaves exactly as it did before.
 */
async function findHunkSession(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (root.code !== 0) return undefined;
	const listed = await pi.exec("hunk", ["session", "list", "--json"], { cwd });
	if (listed.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(listed.stdout) as { sessions?: Array<{ sessionId?: string; repoRoot?: string }> };
		const wanted = root.stdout.trim();
		for (const session of parsed.sessions ?? []) {
			if (session.sessionId && session.repoRoot === wanted) return session.sessionId;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
```

- [ ] **Step 2: Add the prompt fragment**

In the review dispatch path, after the `if (projectGuidelines) { … }` block and before `const modeHint`:

```ts
		const hunkSessionId = await findHunkSession(pi, ctx.cwd);
		if (hunkSessionId) {
			fullPrompt += `\n\nA Hunk review window is open on this repository (session \`${hunkSessionId}\`). As well as reporting findings here, leave each one as an inline note in that window with \`hunk session comment apply\`, anchored to the file and line it is about, so the findings land where the code is. Do not annotate every hunk, and never remove a note the user wrote.`;
		}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Verify both paths by hand**

```bash
pkill -f "hunk diff"                  # ensure no window is live
pi                                    # then: /review uncommitted
```

Expected: the prompt carries no Hunk paragraph and the review runs exactly as before. Then open `hunk diff` in a second terminal and repeat: the paragraph appears, naming the live session id.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/code-review/index.ts
git commit -m "feat(code-review): put findings where the code is when Hunk is open"
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: the command surface and dispatch to Tasks 5 and 9; target selection to Tasks 4 and 9; session lifecycle, reload-before-spawn, and the Ghostty split to Tasks 6 and 7; both workflows and their prompts to Task 8; user notes staying standing and the addressed set to Tasks 3 and 9; skill adoption to Task 9; combining with `/review` to Task 11; configuration to Task 1; modules to Tasks 1–9; failure behavior across Tasks 2, 7, and 9; documentation to Task 10.

**The spec's ten testing behaviors**, in order, are pinned by: (1) `cli.test.ts` "listSessions succeeds on the documented empty-array response"; (2) "a non-zero exit surfaces Hunk's own message"; (3) `session.test.ts`, the four resolution tests; (4) "no match with a target spawns, then polls" and "a poll that never finds the window gives up"; (5) and (6) `args.test.ts` "no arguments means decide from live state" and "a bare target implies review", with the live-state half exercised in Task 9's Step 5 smoke test; (7) `pending.test.ts` "pending means user notes not already addressed"; (8) "a malformed later entry does not discard a good earlier one"; (9) `targets.test.ts` picker and raw-target tests; (10) `ghostty.test.ts` "a non-darwin platform refuses without invoking osascript".

**One spec behavior is checked by hand, not by a test:** bare `/hunk` choosing fix mode over review mode, because the choice lives in `index.ts`, which has no test harness. Task 9 Step 5 is that check. Moving the dispatch into `args.ts` would not help — the decision needs live note counts, not arguments.

**Type consistency.** `HunkResult<T>`, `HunkNote`, `HunkSession`, and `HunkFailure` are defined once in Task 1 and consumed unchanged afterwards. `targetArgs` returns the same `string[]` shape that `ensureSession` takes as `options.target` and that `startupInput` takes as `target`. `ADDRESSED_ENTRY` is the single source of the entry name. `Exec` is defined in `cli.ts` and reused by `ghostty.ts` and `index.ts`.

**Known rough edge, accepted.** Task 11 duplicates a nine-line session probe rather than importing one from the `hunk` extension. That is deliberate — the spec's whole argument for two extensions is that neither depends on the other — but it is the one place where the same idea exists twice, and it is worth a comment in the code saying so (Step 1 includes it).
