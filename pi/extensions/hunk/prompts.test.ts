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
  const rendered = renderWorkList([note({ noteId: "live:1" })]);
  assert.match(rendered, /src\/a\.ts/);
  assert.match(rendered, /line 42 \(new side\)/);
  assert.match(rendered, /this leaks a handle/);
  assert.doesNotMatch(rendered, /--new-line|--old-line/);
});

test("the work list carries the id the agent has to reply to", () => {
  assert.match(renderWorkList([note({ noteId: "user:1789-3" })]), /note id `user:1789-3`/);
});

test("an old-side note names the old side", () => {
  assert.match(renderWorkList([note({ noteId: "live:2", side: "old", line: 7 })]), /line 7 \(old side\)/);
});

test("a note with no line still appears, without inventing one", () => {
  const rendered = renderWorkList([note({ noteId: "live:3", line: undefined })]);
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
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], author: "pi" });
  assert.match(prompt, /this leaks a handle/);
  assert.match(prompt, /--author pi/);
  assert.match(prompt, /abc/);
});

test("the fix prompt sends the answer to the note, not to its line", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "user:1789-3" })], author: "pi" });
  assert.match(prompt, /comment add --reply-to/);
  assert.match(prompt, /replyTo/);
  // The consequence of skipping it is the part the agent has to read.
  assert.match(prompt, /offered again/);
});

test("the fix prompt forbids removing the user's notes", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], author: "pi" });
  assert.match(prompt, /comment rm/);
  assert.match(prompt, /comment clear/);
  // Pin the polarity, not just the words: /not/ also matches "note".
  assert.match(prompt, /Never remove or clear/);
});

test("a multi-line body stays indented under its own number", () => {
  const rendered = renderWorkList([
    note({ noteId: "live:4", body: "this leaks\nand it is load bearing" }),
    note({ noteId: "live:5", body: "second" }),
  ]);
  assert.match(rendered, /1\. .*\n   this leaks\n   and it is load bearing/);
  assert.match(rendered, /2\. /);
});
