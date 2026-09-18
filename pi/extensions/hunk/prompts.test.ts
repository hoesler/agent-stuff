import assert from "node:assert/strict";
import { test } from "node:test";
import { fixPrompt, renderWorkList, reviewPrompt } from "./prompts.ts";
import type { HunkNote } from "./types.ts";

function note(overrides: Partial<HunkNote> & { noteId: string }): HunkNote {
  return {
    source: "user",
    parentId: undefined,
    filePath: "src/a.ts",
    line: 42,
    side: "new",
    body: "this leaks a handle",
    author: undefined,
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

test("the work list anchors each note to a file, side, and line", () => {
  const rendered = renderWorkList([note({ noteId: "live:1" })], []);
  assert.match(rendered, /src\/a\.ts/);
  assert.match(rendered, /line 42 \(new side\)/);
  assert.match(rendered, /this leaks a handle/);
  assert.doesNotMatch(rendered, /--new-line|--old-line/);
});

test("the work list carries the id the agent has to reply to", () => {
  assert.match(renderWorkList([note({ noteId: "user:1789-3" })], []), /note id `user:1789-3`/);
});

test("an old-side note names the old side", () => {
  assert.match(renderWorkList([note({ noteId: "live:2", side: "old", line: 7 })], []), /line 7 \(old side\)/);
});

test("a note with no line still appears, without inventing one", () => {
  const rendered = renderWorkList([note({ noteId: "live:3", line: undefined })], []);
  assert.match(rendered, /src\/a\.ts/);
  assert.doesNotMatch(rendered, /undefined/);
});

test("the review prompt names the target and the session it applies to", () => {
  const prompt = reviewPrompt({ sessionId: "abc", targetLabel: "main...HEAD", guidelines: undefined });
  assert.match(prompt, /main\.\.\.HEAD/);
  assert.match(prompt, /abc/);
  assert.match(prompt, /session review/);
  assert.match(prompt, /comment apply/);
});

test("the review prompt tells the agent not to annotate every hunk", () => {
  const prompt = reviewPrompt({ sessionId: "abc", targetLabel: "working tree", guidelines: undefined });
  assert.match(prompt, /not.*every hunk|Do not.*every hunk/i);
});

test("project guidelines are appended when they exist", () => {
  const prompt = reviewPrompt({ sessionId: "abc", targetLabel: "working tree", guidelines: "No bare excepts." });
  assert.match(prompt, /No bare excepts\./);
});

test("the fix prompt carries the notes and the author to reply as", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], all: [], author: "pi" });
  assert.match(prompt, /this leaks a handle/);
  assert.match(prompt, /--author pi/);
  assert.match(prompt, /abc/);
});

test("the fix prompt sends the answer to the note, not to its line", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "user:1789-3" })], all: [], author: "pi" });
  assert.match(prompt, /comment add --reply-to/);
  assert.match(prompt, /replyTo/);
  // The consequence of skipping it is the part the agent has to read.
  assert.match(prompt, /offered again/);
});

test("the fix prompt forbids removing the user's notes", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], all: [], author: "pi" });
  assert.match(prompt, /comment rm/);
  assert.match(prompt, /comment clear/);
  // Pin the polarity, not just the words: /not/ also matches "note".
  assert.match(prompt, /Never remove or clear/);
});

test("a multi-line body stays indented under its own number", () => {
  const rendered = renderWorkList(
    [note({ noteId: "live:4", body: "this leaks\nand it is load bearing" }), note({ noteId: "live:5", body: "second" })],
    [],
  );
  assert.match(rendered, /1\. .*\n   this leaks\n   and it is load bearing/);
  assert.match(rendered, /2\. /);
});

test("a note the user wrote under one of ours carries our note above it", () => {
  const ours = note({ noteId: "mcp:1", source: "agent", author: "pi", body: "the retry loop swallows the error" });
  const theirs = note({ noteId: "u1", parentId: "mcp:1", body: "no, keep the retry" });
  const rendered = renderWorkList([theirs], [ours, theirs]);
  assert.match(rendered, /the retry loop swallows the error/);
  assert.match(rendered, /no, keep the retry/);
  assert.ok(
    rendered.indexOf("the retry loop swallows the error") < rendered.indexOf("no, keep the retry"),
    "the note being answered has to read before the answer, not after it",
  );
});

test("the thread names who wrote each note above the pending one", () => {
  const ours = note({ noteId: "mcp:1", source: "agent", author: "pi", body: "this leaks" });
  const theirs = note({ noteId: "u1", parentId: "mcp:1", body: "it does not" });
  assert.match(renderWorkList([theirs], [ours, theirs]), /pi/);
});

test("a whole thread reads oldest first", () => {
  const ours = note({ noteId: "mcp:1", source: "agent", author: "pi", body: "first finding" });
  const reply = note({ noteId: "u1", parentId: "mcp:1", body: "why?" });
  const answer = note({ noteId: "mcp:2", parentId: "u1", source: "agent", author: "pi", body: "because of the lock" });
  const last = note({ noteId: "u2", parentId: "mcp:2", body: "then leave it" });
  const rendered = renderWorkList([last], [ours, reply, answer, last]);
  const order = ["first finding", "why?", "because of the lock", "then leave it"].map((text) => rendered.indexOf(text));
  assert.ok(order.every((at) => at >= 0), "every note in the thread has to appear");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the thread has to read oldest first");
});

test("a note that starts its own thread renders with nothing above it", () => {
  const standalone = note({ noteId: "u1" });
  assert.equal(renderWorkList([standalone], [standalone]), renderWorkList([standalone], []));
});

test("a parent that is no longer in the window is skipped, not printed as a hole", () => {
  const orphan = note({ noteId: "u1", parentId: "gone" });
  const rendered = renderWorkList([orphan], [orphan]);
  assert.match(rendered, /this leaks a handle/);
  assert.doesNotMatch(rendered, /undefined|gone/);
});

test("a note that claims itself as its parent does not hang the render", () => {
  const loop = note({ noteId: "u1", parentId: "u1" });
  assert.match(renderWorkList([loop], [loop]), /this leaks a handle/);
});

test("the fix prompt carries the thread each note hangs off", () => {
  const ours = note({ noteId: "mcp:1", source: "agent", author: "pi", body: "the retry loop swallows the error" });
  const theirs = note({ noteId: "u1", parentId: "mcp:1", body: "no, keep the retry" });
  const prompt = fixPrompt({ sessionId: "abc", notes: [theirs], all: [ours, theirs], author: "pi" });
  assert.match(prompt, /the retry loop swallows the error/);
});
