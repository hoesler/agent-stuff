/**
 * session-search — find a past conversation again.
 *
 * The one question this answers is *where is that conversation*, and it returns
 * enough to act on: a session id to open by hand, and a snippet the calling
 * agent can read further from. The user stays in the current session throughout.
 *
 * The agent reaches it through `cli.ts` and the skill next to it, not through a
 * tool: nothing here needs the running pi process, so it costs one skill line
 * until used. See docs/adr/ADR-001-tools-only-when-a-cli-cannot.md.
 *
 * The index refreshes itself from file tails at query time — no daemon, no
 * background writer, no event hook. See `ingest.ts` for why files beat events.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { status } from "./service.ts";

const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md");

export default function sessionSearchExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({ skillPaths: [SKILL_PATH] }));

  pi.registerCommand("session-index", {
    description: "Show session-search index status, or --rebuild it from scratch",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command !== "" && command !== "--rebuild") {
        ctx.ui.notify("Usage: /session-index [--rebuild]", "warning");
        return;
      }

      try {
        const text = await status(
          {
            cwd: ctx.cwd,
            agentDir: getAgentDir(),
            sessionFile: ctx.sessionManager?.getSessionFile() ?? undefined,
            configPath: process.env.PI_SESSION_SEARCH_CONFIG,
          },
          { rebuild: command === "--rebuild" },
        );
        ctx.ui.notify(text, "info");
      } catch (cause) {
        ctx.ui.notify(
          `session-search: ${cause instanceof Error ? cause.message : String(cause)}`,
          "warning",
        );
      }
    },
  });
}
