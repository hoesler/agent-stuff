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
