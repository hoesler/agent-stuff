import assert from "node:assert/strict";
import { test } from "node:test";
import type { HunkNote } from "./types.ts";
import {
  ADDRESSED_ENTRY,
  confirmAddressed,
  nextAddressed,
  pendingNotes,
  restoreAddressed,
} from "./pending.ts";

function note(overrides: Partial<HunkNote> & { noteId: string }): HunkNote {
  return {
    source: "user",
    filePath: "a.ts",
    line: 10,
    side: "new",
    body: "fix this",
    author: undefined,
    createdAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

function entry(noteIds: unknown) {
  return { type: "custom", customType: ADDRESSED_ENTRY, data: { noteIds } };
}

test("no entries means nothing has been addressed", () => {
  assert.equal(restoreAddressed([]).size, 0);
});

test("the latest valid entry wins", () => {
  const addressed = restoreAddressed([entry(["a"]), entry(["a", "b"])]);
  assert.deepEqual([...addressed].sort(), ["a", "b"]);
});

test("a malformed later entry does not discard a good earlier one", () => {
  const addressed = restoreAddressed([entry(["a"]), entry("nope"), { type: "custom", customType: ADDRESSED_ENTRY }]);
  assert.deepEqual([...addressed], ["a"]);
});

test("entries from other extensions are ignored", () => {
  const addressed = restoreAddressed([
    { type: "custom", customType: "tool-catalog-overrides", data: { noteIds: ["x"] } },
    { type: "message" },
  ]);
  assert.equal(addressed.size, 0);
});

test("non-string ids inside a valid entry are dropped", () => {
  assert.deepEqual([...restoreAddressed([entry(["a", 7, null])])], ["a"]);
});

test("pending means user notes not already addressed", () => {
  const notes = [note({ noteId: "a" }), note({ noteId: "b" })];
  assert.deepEqual(
    pendingNotes(notes, new Set(["a"])).map((n) => n.noteId),
    ["b"],
  );
});

test("pending ignores notes the extension itself wrote", () => {
  const notes = [note({ noteId: "a" }), note({ noteId: "b", source: "agent" })];
  assert.deepEqual(
    pendingNotes(notes, new Set()).map((n) => n.noteId),
    ["a"],
  );
});

test("a reply on the same file and line after dispatch confirms a note", () => {
  const user = [note({ noteId: "u1", filePath: "a.ts", line: 10 })];
  const all = [
    ...user,
    note({
      noteId: "mcp:r1",
      source: "agent",
      author: "pi",
      filePath: "a.ts",
      line: 10,
      createdAt: "2026-08-17T12:00:00.000Z",
    }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), ["u1"]);
});

test("a reply from before dispatch does not confirm anything", () => {
  const user = [note({ noteId: "u1" })];
  const all = [
    ...user,
    note({ noteId: "mcp:old", source: "agent", author: "pi", createdAt: "2026-08-17T09:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("a reply by another author does not confirm a note", () => {
  const user = [note({ noteId: "u1" })];
  const all = [
    ...user,
    note({ noteId: "mcp:x", source: "agent", author: "someone-else", createdAt: "2026-08-17T12:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("a reply on a different line leaves its note unconfirmed", () => {
  const user = [note({ noteId: "u1", line: 10 })];
  const all = [
    ...user,
    note({ noteId: "mcp:x", source: "agent", author: "pi", line: 99, createdAt: "2026-08-17T12:00:00.000Z" }),
  ];
  assert.deepEqual(confirmAddressed(user, all, { author: "pi", since: "2026-08-17T11:00:00.000Z" }), []);
});

test("nextAddressed unions and sorts, without duplicating", () => {
  assert.deepEqual(nextAddressed(new Set(["b"]), ["a", "b"]), ["a", "b"]);
});
