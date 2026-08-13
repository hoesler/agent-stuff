import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeTime, renderResults, renderTranscript } from "./render.ts";
import type { SearchResult } from "./search.ts";

const NOW = new Date("2026-08-13T12:00:00.000Z");

const RESULT: SearchResult = {
  sessionId: "8f2a1c3d4e5f",
  path: "/sessions/--work-repo--/8f2a1c.jsonl",
  cwd: "/Users/me/Develop/private/agent-stuff",
  name: "Ripgrep vs SQLite for session search",
  entryId: "e7f3a2b1",
  ts: "2026-07-14T10:00:00.000Z",
  role: "user",
  kind: "message",
  snippet: "convinced that ripgrep might be problematic because of JSON",
  branch: {
    onMainLine: false,
    leafId: "f2",
    divergedAt: "2026-07-14T10:02:00.000Z",
    entriesPastDivergence: 40,
  },
  continuations: [
    { sessionId: "bbb", path: "/sessions/--work-repo--/b.jsonl" },
    { sessionId: "ccc", path: "/sessions/--work-repo--/c.jsonl" },
  ],
};

test("a result carries a name, a cwd, an openable id, and the branch story", () => {
  const text = renderResults([RESULT], { now: NOW, home: "/Users/me" });
  assert.match(text, /1\. "Ripgrep vs SQLite for session search"/);
  assert.match(text, /~\/Develop\/private\/agent-stuff/);
  assert.match(text, /2026-07-14 \(4 weeks ago\)/);
  assert.match(text, /session 8f2a1c/);
  assert.match(text, /entry e7f3a2b1/);
  assert.match(text, /side branch, diverged 07-14, ran 40 more entries/);
  assert.match(text, /also in 2 forks/);
  assert.match(text, /convinced that ripgrep/);
});

test("a main-line hit says nothing about branches and forks", () => {
  const text = renderResults(
    [
      {
        ...RESULT,
        branch: { onMainLine: true, leafId: "z", divergedAt: undefined, entriesPastDivergence: 0 },
        continuations: [],
      },
    ],
    { now: NOW, home: "/Users/me" },
  );
  assert.doesNotMatch(text, /side branch/);
  assert.doesNotMatch(text, /forks/);
});

test("an unnamed session still renders", () => {
  const text = renderResults([{ ...RESULT, name: undefined }], { now: NOW, home: "/Users/me" });
  assert.match(text, /\(unnamed\)/);
});

test("an empty result set says so once", () => {
  assert.match(renderResults([], { now: NOW, home: "/Users/me" }), /No matching sessions/);
});

test("a backlog note rides along with the results", () => {
  const text = renderResults([RESULT], {
    now: NOW,
    home: "/Users/me",
    backlog: { files: 120, bytes: 200000000 },
  });
  assert.match(text, /120 files/);
  assert.match(text, /\/session-index/);
});

test("relativeTime reads naturally at every scale", () => {
  assert.equal(relativeTime("2026-08-13T11:00:00.000Z", NOW), "1 hour ago");
  assert.equal(relativeTime("2026-08-12T12:00:00.000Z", NOW), "yesterday");
  assert.equal(relativeTime("2026-07-14T10:00:00.000Z", NOW), "4 weeks ago");
  assert.equal(relativeTime("2025-08-13T10:00:00.000Z", NOW), "1 year ago");
});

test("a transcript renders dialogue, and tools only on request, never their output", () => {
  const entries = [
    {
      entryId: "e1",
      parentId: null,
      kind: "message",
      role: "user",
      ts: "2026-07-14T10:00:00.000Z",
      text: "why not duckdb",
      evidence: [],
    },
    {
      entryId: "e2",
      parentId: "e1",
      kind: "message",
      role: "assistant",
      ts: "2026-07-14T10:01:00.000Z",
      text: "its fts index does not refresh",
      evidence: [{ tool: "read", action: "read" as const, target: "/work/auth.ts" }],
    },
    {
      entryId: "e3",
      parentId: "e2",
      kind: "message",
      role: "toolResult",
      ts: "2026-07-14T10:02:00.000Z",
      text: undefined,
      evidence: [],
    },
  ];
  const plain = renderTranscript(entries, { includeTools: false, maxChars: 4000, offset: 0 });
  assert.match(plain, /user: why not duckdb/);
  assert.match(plain, /assistant: its fts index does not refresh/);
  assert.doesNotMatch(plain, /auth\.ts/);

  const withTools = renderTranscript(entries, { includeTools: true, maxChars: 4000, offset: 0 });
  assert.match(withTools, /read \/work\/auth\.ts/);
});

test("a transcript over the cap is truncated and says how to page on", () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    entryId: `e${index}`,
    parentId: null,
    kind: "message",
    role: "user",
    ts: "2026-07-14T10:00:00.000Z",
    text: `line number ${index} with enough text to add up`,
    evidence: [],
  }));
  const text = renderTranscript(many, { includeTools: false, maxChars: 300, offset: 0 });
  assert.ok(text.length < 600);
  assert.match(text, /truncated/i);
  assert.match(text, /offset/);
});

test("a non-message kind is labelled by its kind", () => {
  const text = renderTranscript(
    [
      {
        entryId: "c1",
        parentId: null,
        kind: "compaction",
        role: undefined,
        ts: "2026-07-14T10:00:00.000Z",
        text: "we chose sqlite",
        evidence: [],
      },
    ],
    { includeTools: false, maxChars: 4000, offset: 0 },
  );
  assert.match(text, /compaction: we chose sqlite/);
});
