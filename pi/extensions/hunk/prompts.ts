import type { HunkNote } from "./types.ts";

/**
 * Where a note hangs, in prose. Deliberately not spelled as `--new-line 42`:
 * the anchor is data the agent needs, the flag that carries it is Hunk's to
 * name, and a work list full of renamed flags is worse than one the agent
 * translates itself using the adopted skill.
 */
function anchor(note: HunkNote): string {
  if (note.line === undefined) return note.filePath;
  return `${note.filePath} line ${note.line} (${note.side} side)`;
}

/**
 * The notes a pending one hangs off, oldest first. A note the user wrote under
 * one of ours is usually the half that does not stand alone — "agreed, do that",
 * "no, the second one" — and the note it answers is ours, written in a turn that
 * may have been compacted away, or belong to a session that is not this one.
 *
 * Walks `parentId`, the same relationship `pendingNotes` reads, and stops on a
 * parent the window no longer holds or one already walked: a chain that loops
 * must cost the render nothing, because it would otherwise cost it everything.
 */
function ancestors(note: HunkNote, byId: Map<string, HunkNote>): HunkNote[] {
  const chain: HunkNote[] = [];
  const seen = new Set<string>([note.noteId]);
  let parentId = note.parentId;
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    chain.unshift(parent);
    parentId = parent.parentId;
  }
  return chain;
}

/** Quoted so the agent reads the thread as context, not as a second instruction. */
function quote(note: HunkNote): string {
  return `${note.author ?? note.source} wrote: ${note.body}`
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The anchor tells the agent what the note is about; the id is what it answers
 * with. Both are needed: `--reply-to` inherits the anchor, so the id alone
 * would leave the agent reading the work list without knowing where to look.
 *
 * `all` is every note in the window, not just the pending ones, because the
 * thread above a pending note is made of notes that are not themselves pending.
 */
export function renderWorkList(notes: HunkNote[], all: HunkNote[]): string {
  const byId = new Map(all.map((note) => [note.noteId, note]));
  return notes
    .map((note, index) => {
      const body = [...ancestors(note, byId).map(quote), note.body].join("\n").split("\n").join("\n   ");
      return `${index + 1}. ${anchor(note)} · note id \`${note.noteId}\`\n   ${body}`;
    })
    .join("\n\n");
}

export function reviewPrompt(options: {
  sessionId: string;
  targetLabel: string;
  guidelines: string | undefined;
}): string {
  const parts = [
    `Review the changeset now loaded in the Hunk session \`${options.sessionId}\` (${options.targetLabel}).`,
    "",
    "Work through the Hunk session commands, not the interactive TUI:",
    "",
    "1. Read the file and hunk structure first with `session review` in its structured form; it omits patch text on purpose.",
    "2. Pull raw diff text only for the files you actually need to read closely.",
    "3. Leave your findings as inline notes in one `comment apply` batch, each anchored to the file and line it is about.",
    "4. Navigate to the first note so the user lands where the review starts.",
    "5. Summarize what you found in chat, briefly. The notes carry the detail.",
    "",
    "Do not leave a note on every hunk. The user can already see the diff; annotate what they would not spot themselves — intent, structure, risks, and follow-ups. A note per hunk turns the window into noise.",
  ];
  if (options.guidelines) {
    parts.push("", "This project has its own review guidelines:", "", options.guidelines);
  }
  return parts.join("\n");
}

export function fixPrompt(options: { sessionId: string; notes: HunkNote[]; all: HunkNote[]; author: string }): string {
  return [
    `The user left ${options.notes.length === 1 ? "a note" : `${options.notes.length} notes`} on the changeset in the Hunk session \`${options.sessionId}\`. Address ${options.notes.length === 1 ? "it" : "each of them"}.`,
    "",
    renderWorkList(options.notes, options.all),
    "",
    "For each one: make the change, then answer the note itself with `comment add --reply-to <note id>`, using",
    `\`--author ${options.author}\`, saying what you changed. Batch several answers with \`comment apply\`, each item carrying its own \`replyTo\`.`,
    "",
    "Reply to the note by its id, not to its line. A note with a reply of yours under it is handled; a note without one is offered again the next time the user asks, however much you changed in the code.",
    "",
    "Never remove or clear the user's notes — no `comment rm`, no `comment clear`. They decide when a note is done.",
    "",
    "If you disagree with a note, say so in the reply and leave the code alone rather than half-applying it.",
  ].join("\n");
}
