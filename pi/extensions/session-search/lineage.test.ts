import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseOrigin, familyRoot, groupByFamily } from "./lineage.ts";

const FILES = [
  { path: "/s/a.jsonl", parentPath: null, created: "2026-07-01T00:00:00.000Z" },
  { path: "/s/b.jsonl", parentPath: "/s/a.jsonl", created: "2026-07-02T00:00:00.000Z" },
  { path: "/s/c.jsonl", parentPath: "/s/b.jsonl", created: "2026-07-03T00:00:00.000Z" },
  { path: "/s/x.jsonl", parentPath: null, created: "2026-07-04T00:00:00.000Z" },
];

test("a fork chain resolves to its root file", () => {
  assert.equal(familyRoot(FILES, "/s/c.jsonl"), "/s/a.jsonl");
  assert.equal(familyRoot(FILES, "/s/a.jsonl"), "/s/a.jsonl");
  assert.equal(familyRoot(FILES, "/s/unknown.jsonl"), "/s/unknown.jsonl");
});

test("a missing ancestor and a cycle both stop the walk", () => {
  const orphan = [{ path: "/s/o.jsonl", parentPath: "/s/gone.jsonl", created: "2026-07-01T00:00:00.000Z" }];
  assert.equal(familyRoot(orphan, "/s/o.jsonl"), "/s/o.jsonl");
  const cyclic = [
    { path: "/s/p.jsonl", parentPath: "/s/q.jsonl", created: "2026-07-01T00:00:00.000Z" },
    { path: "/s/q.jsonl", parentPath: "/s/p.jsonl", created: "2026-07-01T00:00:00.000Z" },
  ];
  assert.ok(["/s/p.jsonl", "/s/q.jsonl"].includes(familyRoot(cyclic, "/s/p.jsonl")));
});

test("files group by family root", () => {
  const groups = groupByFamily(FILES, ["/s/c.jsonl", "/s/b.jsonl", "/s/x.jsonl"]);
  assert.deepEqual([...groups.keys()].sort(), ["/s/a.jsonl", "/s/x.jsonl"]);
  assert.deepEqual(groups.get("/s/a.jsonl"), ["/s/c.jsonl", "/s/b.jsonl"]);
});

test("the oldest file holding the entry is the origin; the rest are continuations", () => {
  const chosen = chooseOrigin([
    { path: "/s/c.jsonl", created: "2026-07-03T00:00:00.000Z" },
    { path: "/s/a.jsonl", created: "2026-07-01T00:00:00.000Z" },
    { path: "/s/b.jsonl", created: "2026-07-02T00:00:00.000Z" },
  ]);
  assert.equal(chosen.origin.path, "/s/a.jsonl");
  assert.deepEqual(
    chosen.continuations.map((candidate) => candidate.path),
    ["/s/b.jsonl", "/s/c.jsonl"],
  );
});
