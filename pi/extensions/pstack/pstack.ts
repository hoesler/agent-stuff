import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The generated pstack tree ships beside the extensions, so its path follows the package wherever it is installed. */
export function pstackRoot(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..", "..", "pstack");
}

/**
 * What every turn's system prompt carries for pstack: where it is installed, and the role lines.
 * The role lines are what Cursor's always-applied `pstack-models.mdc` rule puts in context.
 */
export function pstackPrompt(root: string, modelsPath: string, models: string | undefined): string {
  const lines = [
    "## pstack",
    "",
    `pstack is installed at ${root}. In pstack skills, personas, and docs, \`<pstack>\` means this folder. ` +
      `Before you follow a pstack skill or persona, read ${join(root, "docs", "harness", "pi.md")} once per session. It maps pstack's Cursor names to pi.`,
    "",
  ];
  if (models?.trim()) {
    lines.push(`### pstack role models (${modelsPath})`, "", models.trim());
  } else {
    lines.push(`No pstack role file exists at ${modelsPath}, so every pstack role runs on \`inherit-parent\`. /setup-pstack writes one.`);
  }
  return lines.join("\n");
}

/** `/poteto-mode <task>` is `/skill:poteto-mode <task>`, which pi expands itself when it knows the skill. */
export function skillCommand(name: string, args: string): string {
  const task = args.trim();
  return task ? `/skill:${name} ${task}` : `/skill:${name}`;
}

/** The block pi's own `/skill:` expansion sends, for when pi has not loaded the skill (for example, disabled in `pi config`). */
export function skillBlock(name: string, filePath: string, content: string, args: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const block = `<skill name="${name}" location="${filePath}">\nReferences are relative to ${dirname(filePath)}.\n\n${body}\n</skill>`;
  const task = args.trim();
  return task ? `${block}\n\n${task}` : block;
}
