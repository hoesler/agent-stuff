/**
 * The message herdr shows beside a blocked pane.
 *
 * pi names the prompt it is waiting on for four of the five `ctx.ui` kinds, but
 * not for `custom`: its runner wraps that one as
 * `withUIPrompt("custom", undefined, ...)`, passing no title at all. `custom` is
 * exactly the kind that matters here — @juicesharp/rpiv-ask-user-question, the
 * questionnaire this was written for, blocks through `ctx.ui.custom()` — so a
 * title-or-nothing label would be empty in the common case. Hence a phrase to
 * fall back on per kind, which at least says what pi is waiting for.
 */

import type { UIPromptKind } from "@earendil-works/pi-coding-agent";

/** Read as the tail of "pi is …", which is how herdr renders it. */
const WAITING_ON: Record<UIPromptKind, string> = {
  select: "waiting for a choice",
  confirm: "waiting for confirmation",
  input: "waiting for input",
  editor: "waiting for an edit",
  custom: "waiting for an answer",
};

/** Kept for a `kind` a later pi adds that this map has not caught up with. */
const WAITING_ON_SOMETHING = "waiting for input";

/** The prompt part of a `ui_prompt_start`, all this needs to know about one. */
interface TitledPrompt {
  kind: UIPromptKind;
  title?: string;
}

/**
 * A prompt's own title when it has one, else what its kind is waiting for.
 *
 * A title of nothing but whitespace is treated as absent: it would render as a
 * blank message, which reads as a herdr bug rather than as a pane with no title
 * to show.
 */
export function promptLabel(prompt: TitledPrompt): string {
  const title = prompt.title?.trim();
  if (title) return title;
  return WAITING_ON[prompt.kind] ?? WAITING_ON_SOMETHING;
}
