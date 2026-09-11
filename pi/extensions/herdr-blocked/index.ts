/**
 * herdr-blocked
 *
 * Shows a pi pane as "blocked" in herdr while the agent is waiting on you,
 * instead of leaving it on "working" until you happen to look at it.
 *
 * herdr's own extension (`~/.pi/agent/extensions/herdr-agent-state.ts`, written
 * by `herdr integration install pi`) already knows how to report the state. It
 * derives "working" and "idle" from `agent_start`/`agent_settled`, and takes
 * "blocked" from an event on pi's bus:
 *
 *     pi.events.on("herdr:blocked", (data) => { ... data.active, data.label })
 *
 * Nothing emits it. `herdr:blocked` is herdr's own name, so only an extension
 * written against herdr would send it, and the extension here that actually
 * blocks — @juicesharp/rpiv-ask-user-question — publishes its equivalent under
 * its own namespace, as `rpiv:ask-user:blocked`. The two never meet, so a
 * questionnaire waiting on an answer reads as "working" in herdr.
 *
 * This joins the two by name. Every blocking source is named on purpose:
 * rpiv's questionnaire here, our own prompts through `whileBlocked` where they
 * are raised. pi's `ui_prompt_start`/`ui_prompt_end` are deliberately not used —
 * see the README — because they say a modal is up, not that the agent is
 * waiting on one, and every menu you open yourself reads the same as a question
 * the agent asked.
 *
 * Deliberately not part of herdr's managed file: `herdr integration install`
 * overwrites that on every update, and its header says to add hooks beside it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearBlocked, reportBlocked } from "./blocked.ts";
import { ASK_USER_BLOCKED_EVENT, ASK_USER_PROMPT_EVENT, blockedActive, questionnaireLabel } from "./rpiv.ts";

export default function (pi: ExtensionAPI): void {
  // rpiv publishes the questionnaire and the wait on separate channels, the
  // questionnaire first, so the label is held between the two. The payload is
  // kept rather than the label it yields: `questionnaireLabel` covers the case
  // where no questionnaire arrived at all, and this way that path is the same
  // code as every other.
  let questionnaire: unknown;

  pi.events.on(ASK_USER_PROMPT_EVENT, (payload) => {
    questionnaire = payload;
  });

  pi.events.on(ASK_USER_BLOCKED_EVENT, (payload) => {
    if (blockedActive(payload)) {
      reportBlocked(pi.events, questionnaireLabel(questionnaire));
      return;
    }
    questionnaire = undefined;
    clearBlocked(pi.events);
  });
}
