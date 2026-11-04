/**
 * program-status-blocked
 *
 * Reports pi as "blocked" over OSC 7501 (the Program Status Protocol Rex and
 * other terminals read) while rpiv's questionnaire waits on you.
 *
 * pi reports program status itself, and marks `select`, `confirm`, `input` and
 * `editor` dialogs as blocked. It does not mark `ctx.ui.custom`, which is how
 * @juicesharp/rpiv-ask-user-question draws its questionnaire, so the terminal
 * shows "working" for as long as the question is open. rpiv announces the wait
 * on its own channel; this turns that into a terminal report.
 *
 * Extensions get no handle on pi's reporter or terminal. A widget factory is
 * handed the TUI, so one is mounted for a moment to pick up `tui.terminal`, and
 * removed again before anything renders it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type Terminal } from "@earendil-works/pi-tui";
import { ASK_USER_BLOCKED_EVENT, ASK_USER_PROMPT_EVENT, blockedActive, questionnaireLabel } from "../herdr-blocked/rpiv.ts";
import { type BlockedHold, holdOn } from "./status.ts";

const PROBE_WIDGET = "program-status-blocked:probe";

export default function (pi: ExtensionAPI): void {
  let hold: BlockedHold | undefined;
  let questionnaire: unknown;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || hold) return;
    let terminal: Terminal | undefined;
    ctx.ui.setWidget(PROBE_WIDGET, (tui) => {
      terminal = tui.terminal;
      return new Container();
    });
    ctx.ui.setWidget(PROBE_WIDGET, undefined);
    // RPC hosts have no terminal, and draw widgets — if at all — without a TUI.
    if (terminal) hold = holdOn(terminal);
  });

  pi.on("session_shutdown", async () => {
    hold?.detach();
    hold = undefined;
  });

  // rpiv publishes the questionnaire before the wait; the label comes out of it.
  pi.events.on(ASK_USER_PROMPT_EVENT, (payload) => {
    questionnaire = payload;
  });

  pi.events.on(ASK_USER_BLOCKED_EVENT, (payload) => {
    if (blockedActive(payload)) {
      hold?.block(questionnaireLabel(questionnaire));
      return;
    }
    questionnaire = undefined;
    hold?.release();
  });
}
