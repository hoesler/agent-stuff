import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorktreeList, resolveScope } from "./scope.ts";

const FILES = [
  { path: "/s/a.jsonl", parentPath: null, created: "2026-07-01T00:00:00.000Z" },
  { path: "/s/b.jsonl", parentPath: "/s/a.jsonl", created: "2026-07-02T00:00:00.000Z" },
  { path: "/s/c.jsonl", parentPath: "/s/b.jsonl", created: "2026-07-03T00:00:00.000Z" },
  { path: "/s/x.jsonl", parentPath: null, created: "2026-07-04T00:00:00.000Z" },
];

const DEPS = {
  cwd: "/work/repo",
  sessionFile: "/s/b.jsonl",
  files: () => FILES,
  worktrees: () => ["/work/repo", "/work/trees/feat-a"],
};

test("an absent scope and an explicit all both search everything", () => {
  assert.deepEqual(resolveScope(undefined, DEPS).filter, { kind: "all" });
  assert.deepEqual(resolveScope("all", DEPS).filter, { kind: "all" });
});

test("project scopes to the current working directory", () => {
  assert.deepEqual(resolveScope("project", DEPS).filter, { kind: "roots", roots: ["/work/repo"] });
});

test("repo scopes to every worktree of the current repository", () => {
  assert.deepEqual(resolveScope("repo", DEPS).filter, {
    kind: "roots",
    roots: ["/work/repo", "/work/trees/feat-a"],
  });
});

test("repo outside a git repository falls back to project, and says so", () => {
  const resolved = resolveScope("repo", { ...DEPS, worktrees: () => undefined });
  assert.deepEqual(resolved.filter, { kind: "roots", roots: ["/work/repo"] });
  assert.match(resolved.note!, /not a git repository/i);
});

test("lineage scopes to the current session's fork family, ancestors and descendants alike", () => {
  const resolved = resolveScope("lineage", DEPS);
  assert.deepEqual(resolved.filter, {
    kind: "paths",
    paths: ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"],
  });
  assert.equal(resolved.note, undefined);
});

test("lineage without a resolvable session falls back to all, and says so", () => {
  const resolved = resolveScope("lineage", { ...DEPS, sessionFile: undefined });
  assert.deepEqual(resolved.filter, { kind: "all" });
  assert.match(resolved.note!, /whole index/i);
});

test("git worktree porcelain output yields one root per worktree", () => {
  const porcelain = [
    "worktree /work/repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /work/trees/feat-a",
    "HEAD 2222222222222222222222222222222222222222",
    "detached",
    "locked",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(porcelain), ["/work/repo", "/work/trees/feat-a"]);
  assert.deepEqual(parseWorktreeList(""), []);
});

test("anything that is not a reserved word is a path glob", () => {
  assert.deepEqual(resolveScope("/work/**", DEPS).filter, { kind: "glob", pattern: "/work/**" });
  assert.deepEqual(resolveScope("**/repo", DEPS).filter, { kind: "glob", pattern: "**/repo" });
});
