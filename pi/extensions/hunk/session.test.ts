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
