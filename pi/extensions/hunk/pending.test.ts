import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingNotes } from "./pending.ts";
import type { HunkNote } from "./types.ts";

function note(overrides: Partial<HunkNote> & { noteId: string }): HunkNote {
  return {
    source: "user",
    parentId: undefined,
    filePath: "a.ts",
    line: 10,
    side: "new",
    body: "fix this",
    author: undefined,
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

function reply(noteId: string, parentId: string): HunkNote {
  return note({ noteId, parentId, source: "agent", author: "pi", createdAt: "2026-08-17T12:00:00.000Z" });
}

test("a user note with no reply of ours is pending", () => {
  assert.deepEqual(
    pendingNotes([note({ noteId: "u1" }), note({ noteId: "u2" })]).map((n) => n.noteId),
    ["u1", "u2"],
  );
});

test("a reply of ours takes its note off the list", () => {
  const notes = [note({ noteId: "u1" }), note({ noteId: "u2" }), reply("mcp:r1", "u1")];
  assert.deepEqual(
    pendingNotes(notes).map((n) => n.noteId),
    ["u2"],
  );
});

test("our own notes are never pending, answered or not", () => {
  const notes = [note({ noteId: "mcp:review", source: "agent", author: "pi" }), note({ noteId: "u1" })];
  assert.deepEqual(
    pendingNotes(notes).map((n) => n.noteId),
    ["u1"],
  );
});

test("a reply the user wrote does not answer their own note", () => {
  const notes = [note({ noteId: "u1" }), note({ noteId: "u2", parentId: "u1" })];
  assert.deepEqual(
    pendingNotes(notes).map((n) => n.noteId),
    ["u1", "u2"],
  );
});

test("a note the user wrote under one of ours is pending until we answer it", () => {
  const thread = [note({ noteId: "mcp:review", source: "agent", author: "pi" }), note({ noteId: "u1", parentId: "mcp:review" })];
  assert.deepEqual(
    pendingNotes(thread).map((n) => n.noteId),
    ["u1"],
  );
  assert.deepEqual(pendingNotes([...thread, reply("mcp:r1", "u1")]), []);
});

test("one reply answers only the note it names, not its neighbour on the same line", () => {
  const notes = [note({ noteId: "u1", line: 10 }), note({ noteId: "u2", line: 10 }), reply("mcp:r1", "u1")];
  assert.deepEqual(
    pendingNotes(notes).map((n) => n.noteId),
    ["u2"],
  );
});

test("a reply counts however late it lands, and whatever it is anchored to", () => {
  // Nothing about the answer is inferred: not the anchor, not the clock, not
  // the author. Only the parent Hunk itself recorded.
  const notes = [
    note({ noteId: "u1", filePath: "a.ts", line: 10, createdAt: "2026-08-17T10:00:00.000Z" }),
    note({
      noteId: "mcp:r1",
      parentId: "u1",
      source: "agent",
      author: undefined,
      filePath: "b.ts",
      line: 99,
      createdAt: "2026-08-17T09:00:00.000Z",
    }),
  ];
  assert.deepEqual(pendingNotes(notes), []);
});

test("a reply naming a note that is no longer there changes nothing", () => {
  assert.deepEqual(
    pendingNotes([note({ noteId: "u1" }), reply("mcp:r1", "gone")]).map((n) => n.noteId),
    ["u1"],
  );
});
