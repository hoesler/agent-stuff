import assert from "node:assert/strict";
import { test } from "node:test";
import { fixPrompt, renderWorkList, reviewPrompt } from "./prompts.ts";
import type { HunkNote } from "./types.ts";

function note(overrides: Partial<HunkNote> & { noteId: string }): HunkNote {
  return {
    source: "user",
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
  assert.match(rendered, /--new-line 42/);
  assert.match(rendered, /this leaks a handle/);
});

test("an old-side note is rendered with the old-line flag", () => {
  assert.match(renderWorkList([note({ noteId: "live:2", side: "old", line: 7 })]), /--old-line 7/);
});

test("a note with no line still appears, without inventing one", () => {
  const rendered = renderWorkList([note({ noteId: "live:3", line: undefined })]);
  assert.match(rendered, /src\/a\.ts/);
  assert.doesNotMatch(rendered, /--new-line undefined/);
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

test("the fix prompt forbids removing the user's notes", () => {
  const prompt = fixPrompt({ sessionId: "abc", notes: [note({ noteId: "live:1" })], author: "pi" });
  assert.match(prompt, /comment rm|comment clear/);
  assert.match(prompt, /never|Never|not/);
});
