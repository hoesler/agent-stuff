/**
 * pstack — run poteto's pstack skills in pi.
 *
 * The skills themselves are generated into `pi/pstack` by `scripts/generate-pstack.mjs`
 * and loaded through the package's `pi.skills`. This extension adds what a skill
 * file cannot: `/poteto-mode <task>`, the installed pstack path, and the role
 * lines from `pstack-models.md`, on every turn.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pstackPrompt, pstackRoot, skillBlock, skillCommand } from "./pstack.ts";

const SKILL = "poteto-mode";

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export default function pstackExtension(pi: ExtensionAPI): void {
  const root = pstackRoot(import.meta.url);

  pi.registerCommand(SKILL, {
    description: "Work in poteto's pstack style: pick a playbook for <task> and run it",
    handler: async (args, ctx) => {
      const deliverAs = ctx.isIdle() ? undefined : "followUp";
      if (pi.getCommands().some((command) => command.name === `skill:${SKILL}`)) {
        pi.sendUserMessage(skillCommand(SKILL, args), { expandPromptTemplates: true, deliverAs });
        return;
      }
      const filePath = join(root, "skills", SKILL, "SKILL.md");
      const content = await readIfPresent(filePath);
      if (content === undefined) {
        ctx.ui.notify(`pstack: ${filePath} is missing`, "error");
        return;
      }
      pi.sendUserMessage(skillBlock(SKILL, filePath, content, args), { deliverAs });
    },
  });

  pi.on("before_agent_start", async (event) => {
    const modelsPath = join(getAgentDir(), "pstack-models.md");
    const models = await readIfPresent(modelsPath);
    return { systemPrompt: `${event.systemPrompt}\n\n${pstackPrompt(root, modelsPath, models)}` };
  });
}
