/**
 * The herdr side of the bridge: the one channel herdr listens on, and the
 * discipline of keeping its pairs balanced.
 *
 * `herdr-agent-state.ts` — the extension `herdr integration install pi` writes —
 * counts the spans it is told about and clears the pane's message when the count
 * reaches zero. An `active: true` that never gets its `false` therefore strands
 * the pane on "blocked" for the rest of the session. `whileBlocked` exists so a
 * caller cannot make that mistake: the clear runs from a `finally`.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** herdr's name for the event, from `herdr-agent-state.ts`. Not ours to change. */
export const HERDR_BLOCKED_EVENT = "herdr:blocked";

/** Report that pi is waiting on a human, and say what for. */
export function reportBlocked(events: EventBus, label: string): void {
  events.emit(HERDR_BLOCKED_EVENT, { active: true, label });
}

/** Report that the wait is over. herdr drops the label at zero, so none is sent. */
export function clearBlocked(events: EventBus): void {
  events.emit(HERDR_BLOCKED_EVENT, { active: false });
}

/**
 * Run a prompt of our own, reported as blocked for exactly as long as it is up.
 *
 * For the blocking sites this package owns, where there is no lifecycle event to
 * listen for. `events` is optional because pi hands the bus to extensions, not
 * to tools: a tool built without one prompts as usual and reports nothing.
 */
export async function whileBlocked<T>(
  events: EventBus | undefined,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!events) return run();
  reportBlocked(events, label);
  try {
    return await run();
  } finally {
    clearBlocked(events);
  }
}
