import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "./cli.ts";
import { spawnWindow } from "./ghostty.ts";

function fakeExec(outcome: { stdout?: string; stderr?: string; code?: number; killed?: boolean }) {
  const calls: Array<{ command: string; args: string[]; options?: { timeout?: number } }> = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "", code: outcome.code ?? 0, killed: outcome.killed };
  };
  return { exec, calls };
}

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

test("osascript is given a timeout, so an unanswered consent dialog cannot wedge it forever", async () => {
  const { exec, calls } = fakeExec({ code: 0 });
  await spawnWindow({ exec, platform: "darwin" }, { cwd: "/work", hunkBin: "hunk", target: ["diff"] });
  assert.ok(calls[0].options?.timeout && calls[0].options.timeout > 0, "a timeout must be passed to exec");
});

test("a killed osascript (e.g. a timed-out consent dialog) is a failure, not a code: 0 success", async () => {
  // pi's own exec resolves a kill as `{ code: 0, killed: true }`, so `killed` must be checked
  // before `code === 0` is trusted.
  const { exec } = fakeExec({ code: 0, killed: true });
  const result = await spawnWindow(
    { exec, platform: "darwin" },
    { cwd: "/work", hunkBin: "hunk", target: ["diff"] },
  );
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /did not respond|timed out/i);
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
