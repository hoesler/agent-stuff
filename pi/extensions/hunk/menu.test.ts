import assert from "node:assert/strict";
import { test } from "node:test";
import { menuChoice, menuFooter, menuNote, menuRows } from "./menu.ts";
import type { RepoFacts } from "./repo.ts";
import { targetArgs } from "./targets.ts";

const EMPTY: RepoFacts = { uncommitted: 0, staged: 0, base: undefined, branches: [], commits: [] };

const FULL: RepoFacts = {
  uncommitted: 7,
  staged: 2,
  base: { branch: "main", changed: 12 },
  branches: ["main"],
  commits: [{ sha: "abc1234", title: "First" }],
};

function labels(facts: RepoFacts, notes = 0) {
  return menuRows({ facts, notes }).map((row) => row.item.label);
}

test("every row a full repository can offer, in the order they are read in", () => {
  assert.deepEqual(labels(FULL, 3), [
    "3 notes you left in Hunk",
    "Uncommitted changes",
    "Staged changes only",
    "This branch vs main",
    "A commit…",
    "Another branch…",
  ]);
});

test("the descriptions say how much there is and what will run", () => {
  const rows = menuRows({ facts: FULL, notes: 3 });
  assert.deepEqual(
    rows.map((row) => row.item.description),
    [
      "reply to each, mark them handled",
      "7 files · hunk diff",
      "2 files · hunk diff --staged",
      "12 files · hunk diff main...HEAD",
      "choose from the last 1",
      "choose what to compare against",
    ],
  );
});

test("one of anything is not pluralised", () => {
  const rows = menuRows({
    facts: { ...EMPTY, uncommitted: 1, staged: 1, base: { branch: "main", changed: 1 } },
    notes: 1,
  });
  assert.deepEqual(
    rows.map((row) => `${row.item.label} — ${row.item.description}`),
    [
      "1 note you left in Hunk — reply to each, mark them handled",
      "Uncommitted changes — 1 file · hunk diff",
      "Staged changes only — 1 file · hunk diff --staged",
      "This branch vs main — 1 file · hunk diff main...HEAD",
    ],
  );
});

test("a row whose diff would be empty is not offered", () => {
  assert.deepEqual(labels({ ...EMPTY, staged: 2 }), ["Staged changes only"]);
  assert.deepEqual(labels({ ...EMPTY, uncommitted: 4 }), ["Uncommitted changes"]);
});

test("a branch that has not moved from its base offers no comparison", () => {
  assert.deepEqual(labels({ ...EMPTY, base: { branch: "main", changed: 0 } }), []);
});

test("the sub-picker rows appear only when they have something to show", () => {
  assert.deepEqual(labels({ ...EMPTY, commits: [{ sha: "abc1234", title: "First" }] }), ["A commit…"]);
  assert.deepEqual(labels({ ...EMPTY, branches: ["main"] }), ["Another branch…"]);
});

test("a repository with nothing to review offers nothing, rather than dead rows", () => {
  assert.deepEqual(menuRows({ facts: EMPTY, notes: 0 }), []);
});

test("each row carries the choice it stands for", () => {
  const rows = menuRows({ facts: FULL, notes: 3 });
  const choices = new Map(rows.map((row) => [row.item.value, row.choice]));
  assert.deepEqual(choices.get("notes"), { kind: "notes" });
  assert.deepEqual(choices.get("uncommitted"), { kind: "target", target: { kind: "workingTree" } });
  assert.deepEqual(choices.get("staged"), { kind: "target", target: { kind: "staged" } });
  assert.deepEqual(choices.get("base"), { kind: "target", target: { kind: "baseBranch", branch: "main" } });
  assert.deepEqual(choices.get("commit"), { kind: "pickCommit" });
  assert.deepEqual(choices.get("branch"), { kind: "pickBranch" });
});

test("the branch row compares against the base git reported", () => {
  const rows = menuRows({ facts: { ...EMPTY, base: { branch: "origin/main", changed: 3 } }, notes: 0 });
  const choice = rows[0].choice;
  assert.deepEqual(choice.kind === "target" && targetArgs(choice.target), ["diff", "origin/main...HEAD"]);
});

test("the first row — where the cursor rests — is notes when there are notes", () => {
  assert.equal(menuRows({ facts: FULL, notes: 3 })[0].item.value, "notes");
});

test("and the working tree when there are none", () => {
  assert.equal(menuRows({ facts: FULL, notes: 0 })[0].item.value, "uncommitted");
});

test("the dim line carries the reason there is no notes row", () => {
  assert.equal(
    menuNote({ facts: FULL, notes: 0, notesReason: "no Hunk window open for this repository" }),
    "no Hunk window open for this repository",
  );
});

test("a clean tree says so, since both rows about it are gone", () => {
  assert.equal(menuNote({ facts: { ...EMPTY, commits: [{ sha: "a", title: "t" }] }, notes: 0 }), "nothing uncommitted or staged");
});

test("a reason that came as a sentence is trimmed to a fragment, since it sits in a list", () => {
  assert.equal(
    menuNote({ facts: FULL, notes: 0, notesReason: "No Hunk window is open for this repository." }),
    "No Hunk window is open for this repository",
  );
});

test("both reasons are said together rather than one hiding the other", () => {
  assert.equal(
    menuNote({ facts: EMPTY, notes: 0, notesReason: "no new notes in wB:p2" }),
    "no new notes in wB:p2 · nothing uncommitted or staged",
  );
});

test("nothing is said when every row is there to speak for itself", () => {
  assert.equal(menuNote({ facts: FULL, notes: 3 }), undefined);
});

test("the footer names the verbs that the highlighted row actually has", () => {
  assert.equal(menuFooter("notes", ["review", "open"]), "enter to address these notes · esc to cancel");
  assert.equal(
    menuFooter("uncommitted", ["review", "open"]),
    "enter to review with the agent · o to open it yourself · esc to cancel",
  );
  assert.equal(menuFooter("uncommitted", ["review"]), "enter to review with the agent · esc to cancel");
  assert.equal(menuFooter("uncommitted", ["open"]), "enter to open it in Hunk · esc to cancel");
});

test("a value no row carries is not a choice", () => {
  assert.equal(menuChoice(menuRows({ facts: FULL, notes: 3 }), "nothing"), undefined);
  assert.deepEqual(menuChoice(menuRows({ facts: FULL, notes: 3 }), "staged"), {
    kind: "target",
    target: { kind: "staged" },
  });
});
