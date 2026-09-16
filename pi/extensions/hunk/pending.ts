import type { HunkNote } from "./types.ts";

/**
 * Because the extension never removes a user note, "pending" cannot mean "any
 * user note" — every later bare `/hunk` would dispatch to fix mode forever.
 * Pending means *a user note with no reply of ours hanging off it*.
 *
 * Hunk states that relationship exactly: `comment add --reply-to <note-id>`
 * records the parent, and `comment list` reports it back as `parentId`. Nothing
 * here is inferred, because every inference this replaces failed in a way that
 * buried a note for good — an answer on the same line but a different anchor, a
 * reply that arrived a turn after the extension stopped looking, a reply whose
 * `--author` the agent left off, or two questions on one line answered once.
 *
 * Read from the live window on every probe rather than remembered in the
 * session, so an answer counts whenever it lands: in the fix turn, in a later
 * turn, or after pi has been restarted around a window left open.
 */
export function pendingNotes(notes: HunkNote[]): HunkNote[] {
  const answered = new Set<string>();
  for (const note of notes) {
    // A reply the user wrote to their own note does not answer it.
    if (note.source === "user" || note.parentId === undefined) continue;
    answered.add(note.parentId);
  }
  return notes.filter((note) => note.source === "user" && !answered.has(note.noteId));
}
