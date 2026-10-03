/**
 * ghostty-title
 *
 * Ghostty window title and progress bar for pi: project, session and model in
 * the title, a braille spinner and a pulsing progress bar while the agent
 * works, and a brief completion flash when it is done.
 *
 * Forked from pi-ghostty (MIT, HazAT) so the spinner can pause while a prompt
 * waits on you; see the README for why. The logic lives in `title.ts`; this
 * module only connects it to pi's events and the terminal.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GhosttyTitle } from "./title.ts";

function ghosttyWrite(seq: string): void {
  try {
    writeFileSync("/dev/tty", seq);
  } catch {
    // /dev/tty unavailable (e.g. subagent context)
  }
}

export default function (pi: ExtensionAPI): void {
  let title: GhosttyTitle | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    title?.shutdown();
    title = new GhosttyTitle(
      {
        setTitle: (t) => {
          // A spinner frame can fire after session replacement made this ctx stale.
          try {
            ctx.ui.setTitle(t);
          } catch {}
        },
        setProgress: (state, value) => ghosttyWrite(`\x1b]9;4;${value === undefined ? state : `${state};${value}`}\x07`),
      },
      { setInterval, clearInterval, setTimeout, clearTimeout },
      path.basename(process.cwd()),
    );
    title.sessionStart(ctx.model?.id, pi.getSessionName());
  });

  pi.on("model_select", async (event) => title?.modelSelect(event.model.id));
  pi.on("agent_start", async () => title?.agentStart());
  pi.on("agent_end", async () => title?.agentEnd());
  pi.on("tool_execution_start", async (event) => title?.toolStart(event.toolName));
  pi.on("tool_execution_end", async () => title?.toolEnd());
  pi.on("ui_prompt_start", async () => title?.promptStart());
  pi.on("ui_prompt_end", async () => title?.promptEnd());
  pi.on("session_shutdown", async () => {
    title?.shutdown();
    title = undefined;
  });
}
