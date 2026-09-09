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
function fakeExec(outcomes: Array<{ stdout?: string; stderr?: string; code?: number; killed?: boolean }>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    const next = outcomes.shift() ?? { stdout: "", stderr: "", code: 0 };
    return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0, killed: next.killed };
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

test("a killed process is reported as a timeout, never as an empty success", async () => {
  // pi's own exec resolves a timed-out process as `{ stdout: "", stderr: "", code: 0, killed: true }` —
  // code 0 alone must not be read as success once `killed` is set.
  const { exec } = fakeExec([{ stdout: "", stderr: "", code: 0, killed: true }]);
  const result = await createCli({ exec, hunkBin: "hunk", cwd: "/work" }).listSessions();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "hunk-error");
  assert.match(!result.ok ? result.message : "", /timed out/i);
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
