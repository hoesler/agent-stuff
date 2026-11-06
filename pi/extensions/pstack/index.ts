/**
 * pstack — run poteto's pstack skills in pi.
 *
 * The skills are generated into `./pstack` by `generate.mjs`, which `npm install` runs. pi does not
 * load them as skills: 57 `/skill:` commands and generic names like `tdd` would crowd the
 * command list, and pstack reaches its own skills by path. This extension adds
 * `/poteto-mode`, `/poteto-help`, `/setup-pstack`, `/pstack <skill> <task>`, and, on every turn, the installed pstack
 * path.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillsFromDir, type ExtensionAPI, type ExtensionCommandContext, type Skill } from "@earendil-works/pi-coding-agent";
import { pstackPrompt, pstackRoot, skillBlock, skillCompletions, splitSkillArgs } from "./pstack.ts";

/** The skills a newcomer needs before they know `/pstack`, under the names upstream's docs use. */
const SHORTCUTS: Record<string, string> = {
  "poteto-mode": "Work in poteto's pstack style: pick a playbook for <task> and run it",
  "poteto-help": "Ask how to set up pstack or which skill, playbook, or principle fits a task",
  "setup-pstack": "Check the agent modes pstack's subagents run on, and install its personas",
};

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export default function pstackExtension(pi: ExtensionAPI): void {
  const root = pstackRoot(import.meta.url);
  let skills: Skill[] | undefined;
  const loadSkills = () => (skills ??= loadSkillsFromDir({ dir: join(root, "skills"), source: "pstack" }).skills);

  async function runSkill(name: string, task: string, ctx: ExtensionCommandContext): Promise<void> {
    const skill = loadSkills().find((candidate) => candidate.name === name);
    const content = skill && (await readIfPresent(skill.filePath));
    if (!existsSync(join(root, "skills"))) {
      ctx.ui.notify(`pstack: its skills are not generated yet. Run \`npm install\` in ${join(root, "..", "..", "..", "..")}.`, "error");
      return;
    }
    if (!skill || content === undefined) {
      ctx.ui.notify(`pstack: no skill named ${name} in ${join(root, "skills")}`, "error");
      return;
    }
    pi.sendUserMessage(skillBlock(skill.name, skill.filePath, content, task), { deliverAs: ctx.isIdle() ? undefined : "followUp" });
  }

  for (const [name, description] of Object.entries(SHORTCUTS)) {
    pi.registerCommand(name, { description, handler: (args, ctx) => runSkill(name, args.trim(), ctx) });
  }

  pi.registerCommand("pstack", {
    description: "Run a pstack skill: /pstack <skill> [task]",
    getArgumentCompletions: (prefix) => skillCompletions(loadSkills(), prefix),
    handler: async (args, ctx) => {
      const { name, task } = splitSkillArgs(args);
      if (!name) {
        ctx.ui.notify("Usage: /pstack <skill> [task]", "warning");
        return;
      }
      await runSkill(name, task, ctx);
    },
  });

  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${pstackPrompt(root)}` }));
}
