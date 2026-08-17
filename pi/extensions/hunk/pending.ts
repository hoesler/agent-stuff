import type { HunkNote } from "./types.ts";

export const ADDRESSED_ENTRY = "hunk-addressed";

export interface AddressedState {
  noteIds: string[];
}

/** The slice of a session entry this module reads. No pi types. */
export interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * Appended as custom session entries rather than written to a config file, so
 * forking or walking the session tree carries the answers given on that branch.
 * The last valid entry wins; a malformed later entry must never discard a good
 * earlier one, as `tool-catalog/state.ts` also guarantees.
 */
export function restoreAddressed(entries: BranchEntry[]): Set<string> {
  let latest: string[] | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ADDRESSED_ENTRY) continue;
    const data = entry.data as AddressedState | undefined;
    if (!data || !Array.isArray(data.noteIds)) continue;
    latest = data.noteIds.filter((id): id is string => typeof id === "string");
  }
  return new Set(latest ?? []);
}

/**
 * Because the extension never removes a user note, "pending" cannot mean "any
 * user note" — every later bare `/hunk` would dispatch to fix mode forever.
 */
export function pendingNotes(notes: HunkNote[], addressed: ReadonlySet<string>): HunkNote[] {
  return notes.filter((note) => note.source === "user" && !addressed.has(note.noteId));
}

function sameAnchor(a: HunkNote, b: HunkNote): boolean {
  return a.filePath === b.filePath && a.side === b.side && a.line === b.line;
}

/**
 * Which notes the agent actually answered. The extension cannot know this at
 * dispatch time — the turn has not run yet — so it correlates afterwards: a
 * user note is addressed when a reply of ours sits on the same anchor and was
 * created after the dispatch. Marking notes addressed optimistically would
 * bury a note the agent silently failed to answer.
 */
export function confirmAddressed(
  userNotes: HunkNote[],
  allNotes: HunkNote[],
  options: { author: string; since: string },
): string[] {
  const replies = allNotes.filter(
    (note) =>
      note.source !== "user" &&
      note.author === options.author &&
      note.createdAt !== undefined &&
      note.createdAt > options.since,
  );
  return userNotes.filter((note) => replies.some((reply) => sameAnchor(note, reply))).map((note) => note.noteId);
}

export function nextAddressed(addressed: ReadonlySet<string>, confirmed: string[]): string[] {
  return [...new Set([...addressed, ...confirmed])].sort();
}
