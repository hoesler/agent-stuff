/**
 * herdr-blocked
 *
 * Shows a pi pane as "blocked" in herdr while pi is waiting on you, instead of
 * leaving it on "working" until you happen to look at it.
 *
 * herdr's own extension (`~/.pi/agent/extensions/herdr-agent-state.ts`, written
 * by `herdr integration install pi`) already knows how to report the state. It
 * derives "working" and "idle" from `agent_start`/`agent_settled`, and takes
 * "blocked" from an event on pi's bus:
 *
 *     pi.events.on("herdr:blocked", (data) => { ... data.active, data.label })
 *
 * Nothing emits that event. It is herdr's own name, so only an extension
 * written against herdr would, and the one extension here that does block —
 * @juicesharp/rpiv-ask-user-question — publishes its equivalent under its own
 * namespace instead, as `rpiv:ask-user:blocked`. The two never meet, so the
 * blocked state has no source and a pending questionnaire reads as "working".
 *
 * This bridges the gap from pi's side rather than from either extension's.
 * `ui_prompt_start`/`ui_prompt_end` (pi 0.84.4+) fire around every
 * `ctx.ui.select/confirm/input/editor/custom` call, which is what "pi is
 * blocked on a human" actually means, so translating those into `herdr:blocked`
 * covers any extension that blocks — not only the questionnaire this started
 * with, and without a private agreement with each extension's author.
 *
 * Listening for `rpiv:ask-user:blocked` directly was the other option. pi's own
 * events are the better source twice over: pi emits the end from a `finally` in
 * its extension runner, so the unblock cannot be lost to an extension that
 * throws, and pi coalesces nested prompts into a single outer span, so the
 * count herdr keeps stays balanced without this having to track depth.
 *
 * Deliberately not part of herdr's managed file: `herdr integration install`
 * overwrites that on every update, and its header says to add hooks beside it.
 */

import type { ExtensionAPI, UIPromptStartEvent } from "@earendil-works/pi-coding-agent";
import { promptLabel } from "./label.ts";

/** herdr's name for the event, from `herdr-agent-state.ts`. Not ours to change. */
const HERDR_BLOCKED_EVENT = "herdr:blocked";

export default function (pi: ExtensionAPI): void {
  pi.on("ui_prompt_start", (event: UIPromptStartEvent) => {
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: promptLabel(event) });
  });

  // No label: herdr clears the message it is holding when the count reaches zero.
  pi.on("ui_prompt_end", () => {
    pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
  });
}
