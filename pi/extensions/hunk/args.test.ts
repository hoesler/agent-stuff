import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "./args.ts";
import { targetArgs } from "./targets.ts";

test("no arguments opens the menu", () => {
  assert.deepEqual(parseCommand(""), { mode: "menu" });
  assert.deepEqual(parseCommand("   "), { mode: "menu" });
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

test("open with no target leaves the target for the picker", () => {
  assert.deepEqual(parseCommand("open"), { mode: "open", target: undefined });
});

test("open forwards its target the way review does", () => {
  const parsed = parseCommand("open main...HEAD");
  assert.equal("mode" in parsed && parsed.mode, "open");
  assert.deepEqual("mode" in parsed && parsed.target && targetArgs(parsed.target), ["diff", "main...HEAD"]);
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

test("a bare --session still opens the menu when nothing else is given", () => {
  assert.deepEqual(parseCommand("--session abc"), { mode: "menu", sessionId: "abc" });
});

test("a repeated --session takes the last one", () => {
  assert.deepEqual(parseCommand("--session abc --session def"), { mode: "menu", sessionId: "def" });
});

test("a head nobody recognizes stays a raw target, so Hunk reports its own error", () => {
  const parsed = parseCommand("auto");
  assert.equal("mode" in parsed && parsed.mode, "review");
  assert.deepEqual("mode" in parsed && parsed.target && targetArgs(parsed.target), ["diff", "auto"]);
});
