import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyEntry, mainLine } from "./tree.ts";

/** root e1 → e2 → e3 (main line), with e2 → f1 → f2 as an abandoned side branch. */
const FORKED = [
  { id: "e1", parentId: null, ts: "2026-07-14T10:00:00.000Z" },
  { id: "e2", parentId: "e1", ts: "2026-07-14T10:01:00.000Z" },
  { id: "f1", parentId: "e2", ts: "2026-07-14T10:02:00.000Z" },
  { id: "f2", parentId: "f1", ts: "2026-07-14T10:03:00.000Z" },
  { id: "e3", parentId: "e2", ts: "2026-07-14T11:00:00.000Z" },
];

test("the main line runs from the chronologically last entry to the root", () => {
  assert.deepEqual(mainLine(FORKED), ["e1", "e2", "e3"]);
});

test("a hit on the main line reports the session leaf as its branch identity", () => {
  const info = classifyEntry(FORKED, "e2");
  assert.equal(info.onMainLine, true);
  assert.equal(info.leafId, "e3");
  assert.equal(info.divergedAt, undefined);
  assert.equal(info.entriesPastDivergence, 0);
});

test("a hit on a side branch reports the divergence and how far the branch ran", () => {
  const info = classifyEntry(FORKED, "f1");
  assert.equal(info.onMainLine, false);
  assert.equal(info.leafId, "f2");
  assert.equal(info.divergedAt, "2026-07-14T10:02:00.000Z");
  assert.equal(info.entriesPastDivergence, 2);
});

test("branch identity is the leaf id, and it does not move when a new branch diverges earlier", () => {
  const withEarlierFork = [...FORKED, { id: "g1", parentId: "e1", ts: "2026-07-14T10:00:30.000Z" }];
  assert.equal(classifyEntry(withEarlierFork, "f1").leafId, "f2");
  assert.equal(classifyEntry(withEarlierFork, "g1").leafId, "g1");
});

test("a branch running through non-prose entries still resolves to the root", () => {
  const withStructural = [
    { id: "e1", parentId: null, ts: "2026-07-14T10:00:00.000Z" },
    { id: "m1", parentId: "e1", ts: "2026-07-14T10:00:10.000Z" },
    { id: "t1", parentId: "m1", ts: "2026-07-14T10:00:20.000Z" },
    { id: "e2", parentId: "t1", ts: "2026-07-14T10:01:00.000Z" },
  ];
  assert.deepEqual(mainLine(withStructural), ["e1", "m1", "t1", "e2"]);
  assert.equal(classifyEntry(withStructural, "e1").onMainLine, true);
});

test("an orphaned entry and a parent cycle degrade instead of hanging", () => {
  const broken = [
    { id: "a", parentId: "missing", ts: "2026-07-14T10:00:00.000Z" },
    { id: "c1", parentId: "c2", ts: "2026-07-14T10:01:00.000Z" },
    { id: "c2", parentId: "c1", ts: "2026-07-14T10:02:00.000Z" },
  ];
  assert.equal(classifyEntry(broken, "a").leafId, "a");
  // A cycle has no meaningful verdict; the requirement is that it terminates.
  assert.equal(typeof classifyEntry(broken, "c1").leafId, "string");
  assert.equal(classifyEntry([], "nope").leafId, "nope");
});
