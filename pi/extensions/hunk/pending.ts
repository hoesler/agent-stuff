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

/** Identifies the place a note hangs on. ` ` cannot occur in a path. */
function anchorKey(note: HunkNote): string {
  return `${note.filePath} ${note.side} ${note.line ?? "?"}`;
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

  // Hunk allows several notes on one line, and a reply carries no reference to
  // the note it answers. So notes are confirmed per anchor, and only when the
  // replies there are at least as many as the notes: two questions answered
  // once leaves both pending. Erring this way costs a re-offer; erring the
  // other way buries a note the agent never answered, permanently, because the
  // addressed set only ever grows.
  const groups = new Map<string, HunkNote[]>();
  for (const note of userNotes) {
    const key = anchorKey(note);
    const group = groups.get(key);
    if (group) group.push(note);
    else groups.set(key, [note]);
  }

  const confirmed: string[] = [];
  for (const [key, group] of groups) {
    const answered = replies.filter((reply) => anchorKey(reply) === key).length;
    if (answered >= group.length) confirmed.push(...group.map((note) => note.noteId));
  }
  return confirmed;
}

export function nextAddressed(addressed: ReadonlySet<string>, confirmed: string[]): string[] {
  return [...new Set([...addressed, ...confirmed])].sort();
}
