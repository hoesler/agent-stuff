import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endsOnNewline, listSessionFiles, planFile, readLines } from "./scan.ts";

test("listSessionFiles finds jsonl one level down and tolerates a missing root", () => {
  const root = mkdtempSync(join(tmpdir(), "ss-scan-"));
  mkdirSync(join(root, "--work-repo--"));
  writeFileSync(join(root, "--work-repo--", "a.jsonl"), "{}\n");
  writeFileSync(join(root, "--work-repo--", "notes.txt"), "ignored");
  const found = listSessionFiles(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, join(root, "--work-repo--", "a.jsonl"));
  assert.ok(found[0].size > 0);
  assert.deepEqual(listSessionFiles(join(root, "absent")), []);
});

test("planFile classifies unchanged, new, grown, and rewritten", () => {
  const current = { path: "/a", size: 100, mtimeMs: 5 };
  assert.equal(planFile({ size: 100, mtimeMs: 5, bytesIndexed: 100 }, current).kind, "unchanged");
  assert.equal(planFile(undefined, current).kind, "new");
  assert.equal(planFile({ size: 60, mtimeMs: 1, bytesIndexed: 60 }, current).kind, "grown");
  assert.equal(planFile({ size: 200, mtimeMs: 1, bytesIndexed: 200 }, current).kind, "rewritten");
  assert.equal(planFile({ size: 60, mtimeMs: 1, bytesIndexed: 80 }, current).kind, "grown");
  assert.equal(planFile({ size: 100, mtimeMs: 9, bytesIndexed: 100 }, current).kind, "grown");
  assert.equal(planFile({ size: 100, mtimeMs: 9, bytesIndexed: 140 }, current).kind, "rewritten");
  assert.equal(planFile(undefined, current).from, 0);
  assert.equal(planFile({ size: 60, mtimeMs: 1, bytesIndexed: 60 }, current).from, 60);
  assert.equal(planFile({ size: 200, mtimeMs: 1, bytesIndexed: 200 }, current).from, 0);
});

test("readLines returns only complete lines and stops at the last newline", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ss-tail-")), "s.jsonl");
  writeFileSync(path, '{"a":1}\n{"b":2}\n');
  const first = readLines(path, 0);
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(first.nextOffset, 16);

  appendFileSync(path, '{"c":3}');
  const partial = readLines(path, first.nextOffset);
  assert.deepEqual(partial.lines, []);
  assert.equal(partial.nextOffset, first.nextOffset);

  appendFileSync(path, "\n");
  const completed = readLines(path, partial.nextOffset);
  assert.deepEqual(completed.lines, ['{"c":3}']);
  assert.equal(completed.nextOffset, 24);
});

test("endsOnNewline detects an offset that no longer lands on a record boundary", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ss-boundary-")), "s.jsonl");
  writeFileSync(path, '{"a":1}\n{"b":2}\n');
  assert.equal(endsOnNewline(path, 8), true);
  assert.equal(endsOnNewline(path, 0), true);
  assert.equal(endsOnNewline(path, 5), false);
});
