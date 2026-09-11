import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec, ExecOutcome } from "./cli.ts";
import { chooseBase, countLines, parseBranches, parseCommits, parseDefaultBranch, parseStatus, repoFacts } from "./repo.ts";

test("the status header names the branch and the rest are the changed files", () => {
  assert.deepEqual(parseStatus("## main...origin/main\n M a.ts\n?? b.ts\n"), { branch: "main", changed: 2 });
});

test("a branch with no upstream still parses", () => {
  assert.deepEqual(parseStatus("## feat/menu\n M a.ts\n"), { branch: "feat/menu", changed: 1 });
});

test("a clean tree is zero changed files, not a missing count", () => {
  assert.deepEqual(parseStatus("## main...origin/main\n"), { branch: "main", changed: 0 });
});

test("a detached HEAD has no branch to name", () => {
  assert.deepEqual(parseStatus("## HEAD (no branch)\n M a.ts\n"), { branch: undefined, changed: 1 });
});

test("a repository before its first commit still names the branch it is on", () => {
  assert.deepEqual(parseStatus("## No commits yet on main\n?? a.ts\n"), { branch: "main", changed: 1 });
});

test("counting ignores the trailing newline and any blank line", () => {
  assert.equal(countLines("a.ts\nb.ts\n"), 2);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("\n\n"), 0);
});

test("the default branch is read without its remote", () => {
  assert.equal(parseDefaultBranch("origin/main\n"), "main");
  assert.equal(parseDefaultBranch(""), undefined);
});

test("a default branch git reports without a remote prefix is taken as it is", () => {
  assert.equal(parseDefaultBranch("main\n"), "main");
});

test("the detected base is used when it exists locally", () => {
  assert.equal(chooseBase({ detected: "main", branches: ["main", "feat/menu"], current: "feat/menu" }), "main");
});

test("a detected base with no local branch falls back to the remote-tracking ref", () => {
  assert.equal(chooseBase({ detected: "main", branches: ["feat/menu"], current: "feat/menu" }), "origin/main");
});

test("the branch you are on is never offered as its own base", () => {
  assert.equal(chooseBase({ detected: "main", branches: ["main"], current: "main" }), undefined);
});

test("with nothing detected, a local main or master stands in", () => {
  assert.equal(chooseBase({ detected: undefined, branches: ["main", "feat/x"], current: "feat/x" }), "main");
  assert.equal(chooseBase({ detected: undefined, branches: ["master", "feat/x"], current: "feat/x" }), "master");
});

test("main wins over master when a repository somehow carries both", () => {
  assert.equal(chooseBase({ detected: undefined, branches: ["master", "main"], current: "feat/x" }), "main");
});

test("with no convention to fall back on there is no base", () => {
  assert.equal(chooseBase({ detected: undefined, branches: ["topic", "other"], current: "topic" }), undefined);
});

test("branches and commits are read the way their pickers need them", () => {
  assert.deepEqual(parseBranches("main\nfeat/menu\n\n"), ["main", "feat/menu"]);
  assert.deepEqual(parseCommits("abc1234\tFirst\ndef5678\tSecond\n"), [
    { sha: "abc1234", title: "First" },
    { sha: "def5678", title: "Second" },
  ]);
});

test("a commit subject containing a tab keeps everything after the first one", () => {
  assert.deepEqual(parseCommits("abc1234\tfix\ttabbed\n"), [{ sha: "abc1234", title: "fix\ttabbed" }]);
});

function fakeGit(replies: Record<string, Partial<ExecOutcome>>) {
  const calls: string[][] = [];
  const exec: Exec = async (_command, args) => {
    calls.push(args);
    const key = Object.keys(replies).find((prefix) => args.join(" ").startsWith(prefix));
    const reply = key ? replies[key] : undefined;
    return { stdout: reply?.stdout ?? "", stderr: reply?.stderr ?? "", code: reply?.code ?? (reply ? 0 : 1) };
  };
  return { exec, calls };
}

test("the facts a full repository reports", async () => {
  const { exec } = fakeGit({
    "status": { stdout: "## feat/menu...origin/feat/menu\n M a.ts\n M b.ts\n" },
    "diff --cached": { stdout: "a.ts\n" },
    "symbolic-ref": { stdout: "origin/main\n" },
    "for-each-ref": { stdout: "feat/menu\nmain\n" },
    "log": { stdout: "abc1234\tFirst\n" },
    "diff --name-only main...HEAD": { stdout: "a.ts\nb.ts\nc.ts\n" },
  });

  assert.deepEqual(await repoFacts({ exec }, "/repo"), {
    uncommitted: 2,
    staged: 1,
    base: { branch: "main", changed: 3 },
    branches: ["main"],
    commits: [{ sha: "abc1234", title: "First" }],
  });
});

test("the branch you are on is kept out of the branch picker", async () => {
  const { exec } = fakeGit({
    "status": { stdout: "## feat/menu\n" },
    "for-each-ref": { stdout: "feat/menu\nmain\ntopic\n" },
  });
  const facts = await repoFacts({ exec }, "/repo");
  assert.deepEqual(facts.branches, ["main", "topic"]);
});

test("a failing git call costs its own fact and nothing else", async () => {
  const { exec } = fakeGit({
    "status": { stdout: "## feat/menu\n M a.ts\n" },
    "diff --cached": { code: 128, stderr: "fatal: not a git repository" },
    "log": { stdout: "abc1234\tFirst\n" },
  });

  assert.deepEqual(await repoFacts({ exec }, "/repo"), {
    uncommitted: 1,
    staged: 0,
    base: undefined,
    branches: [],
    commits: [{ sha: "abc1234", title: "First" }],
  });
});

test("no base is looked up when there is no base to diff against", async () => {
  const { exec, calls } = fakeGit({
    "status": { stdout: "## main\n" },
    "symbolic-ref": { stdout: "origin/main\n" },
    "for-each-ref": { stdout: "main\n" },
  });
  const facts = await repoFacts({ exec }, "/repo");
  assert.equal(facts.base, undefined);
  assert.equal(calls.some((args) => args.join(" ").includes("...HEAD")), false);
});
