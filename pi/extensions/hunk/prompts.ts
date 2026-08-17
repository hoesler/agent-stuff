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

export function renderWorkList(notes: HunkNote[]): string {
  return notes
    .map((note, index) => `${index + 1}. ${anchor(note)}\n   ${note.body.split("\n").join("\n   ")}`)
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

export function fixPrompt(options: { sessionId: string; notes: HunkNote[]; author: string }): string {
  return [
    `The user left ${options.notes.length === 1 ? "a note" : `${options.notes.length} notes`} on the changeset in the Hunk session \`${options.sessionId}\`. Address ${options.notes.length === 1 ? "it" : "each of them"}.`,
    "",
    renderWorkList(options.notes),
    "",
    "For each one: make the change, then reply on the same file, side, and line with `comment add`, using",
    `\`--author ${options.author}\`, saying what you changed. The reply is how the user sees which notes you handled without rereading the diff.`,
    "",
    "Never remove or clear the user's notes — no `comment rm`, no `comment clear`. They decide when a note is done.",
    "",
    "If you disagree with a note, say so in the reply and leave the code alone rather than half-applying it.",
  ].join("\n");
}
