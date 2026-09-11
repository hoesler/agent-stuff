/**
 * The rpiv side of the bridge: the channels @juicesharp/rpiv-ask-user-question
 * publishes, and what this reads out of their payloads.
 *
 * Both names are quoted rather than imported. The package's `events.ts` states
 * the policy they live under — channel names are immutable once shipped, payload
 * changes are append-only, breaking changes ship as a new channel — so the
 * strings cannot drift out from under us, and importing them would pull
 * `rpiv-config` and `typebox` into this package's tree to spell two constants.
 *
 * The payloads are read defensively for the same reason the policy exists: the
 * bus hands every listener `unknown`, so nothing here may assume a shape it has
 * not checked, and a payload from a later rpiv must still produce a label.
 */

/** Fires with the questionnaire, just before the wait begins. */
export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";

/** Fires `{ active: true }` while input is awaited, `{ active: false }` after. */
export const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

/** Said when the questionnaire tells us nothing usable. Reads as the tail of "pi is …". */
const WAITING_FOR_AN_ANSWER = "waiting for an answer";

/** Enough room for a question, little enough to sit beside a pane. */
const LABEL_MAX = 60;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function fit(label: string): string {
  return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1)}…`;
}

/**
 * What herdr shows beside the blocked pane.
 *
 * The first question's `header` is rpiv's own short chip — one to three words,
 * authored to be read at a glance — which is the shape a pane label wants. The
 * question itself is the fallback, cut to fit, and a phrase covers a payload
 * with no question in it at all.
 */
export function questionnaireLabel(payload: unknown): string {
  const questions = (payload as { questions?: unknown })?.questions;
  const first = Array.isArray(questions) ? questions[0] : undefined;
  const label = text(first?.header) || text(first?.question);
  return label ? fit(label) : WAITING_FOR_AN_ANSWER;
}

/**
 * Whether the payload says pi is still waiting.
 *
 * Only a literal `active: true` blocks. A pane stranded on "blocked" outlasts
 * the session that caused it, so anything unrecognised clears instead.
 */
export function blockedActive(payload: unknown): boolean {
  return (payload as { active?: unknown })?.active === true;
}
