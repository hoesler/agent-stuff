import type { ModeConfig, ModeDefinition } from "./types.ts";

const INTRO = [
  "## Available model modes (model-modes extension)",
  "",
  "When dispatching subagents (e.g. via the `subagent` tool's `model` parameter), pass one of these exact strings — including the `:level` suffix — to pin both the model and its thinking level for that task:",
  "",
];

function modelString(mode: ModeDefinition): string {
  const base = `${mode.provider}/${mode.model}`;
  return mode.thinkingLevel === "off" ? base : `${base}:${mode.thinkingLevel}`;
}

function formatModeLine(mode: ModeDefinition): string {
  const suffix = mode.description ? ` — ${mode.description}` : "";
  return `- \`${mode.id}\` → \`${modelString(mode)}\`${suffix}`;
}

/**
 * Renders the configured modes as a system-prompt block giving the agent a
 * ready-to-use `provider/model[:thinkingLevel]` string per mode. Callers are
 * responsible for checking `exposeCatalogInSystemPrompt` and config validity
 * before appending this to a system prompt.
 */
export function formatModeCatalog(config: ModeConfig): string {
  return [...INTRO, ...config.modes.map(formatModeLine)].join("\n");
}
