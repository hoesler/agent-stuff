import assert from "node:assert/strict";
import { test } from "node:test";
import { rawTarget, targetArgs, targetLabel } from "./targets.ts";

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
