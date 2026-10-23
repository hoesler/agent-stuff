import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** The generated pstack tree ships beside the extensions, so its path follows the package wherever it is installed. */
export function pstackRoot(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..", "..", "pstack");
}

/** What every turn's system prompt carries for pstack: where it is installed, and where its skills are. */
export function pstackPrompt(root: string): string {
  return [
    "## pstack",
    "",
    `pstack is installed at ${root}. In pstack skills, personas, and docs, \`<pstack>\` means this folder. ` +
      `Before you follow a pstack skill or persona, read ${join(root, "docs", "harness", "pi.md")} once per session. It maps pstack's Cursor names to pi.`,
    "",
    `pstack's skills are not in the skill list. To use one, read ${join(root, "skills", "<name>", "SKILL.md")}. ` +
      "For setting up pstack, including which models its subagents use, that is `setup-pstack`.",
  ].join("\n");
}

/** `/pstack <skill> <task>` splits at the first whitespace. */
export function splitSkillArgs(args: string): { name: string; task: string } {
  const [name = "", ...rest] = args.trim().split(/\s+/);
  return { name, task: rest.join(" ") };
}

/** Skill names for `/pstack`, until the name is complete and the task begins. */
export function skillCompletions(skills: readonly Skill[], prefix: string): AutocompleteItem[] | null {
  if (/\s/.test(prefix.trimStart())) return null;
  const typed = prefix.trim();
  const items = skills
    .filter((skill) => skill.name.startsWith(typed))
    .map((skill) => ({ value: `${skill.name} `, label: skill.name, description: skill.description }));
  return items.length > 0 ? items : null;
}

/** The block pi's own `/skill:` expansion sends. pi does not load pstack's skills, so the extension sends it. */
export function skillBlock(name: string, filePath: string, content: string, task: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const block = `<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`;
  return task ? `${block}\n\n${task}` : block;
}
