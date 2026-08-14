import type { ResolvedRoute } from "./routes.ts";
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

const ROUTES_INTRO = [
  "",
  "Routes (resolved for the active mode; pass the key, not a model string):",
  "",
];

function formatRouteLine(route: ResolvedRoute): string {
  const suffix = route.description ? ` — ${route.description}` : "";
  return `- \`${route.key}\`${suffix}`;
}

/**
 * Renders the configured modes as a system-prompt block giving the agent a
 * ready-to-use `provider/model[:thinkingLevel]` string per mode, plus the route
 * keys that currently resolve.
 *
 * Routes carry the key only. The prompt is built once per turn while the active
 * mode can change at any moment, so a literal model string here would hand the
 * agent a stale route; a key is resolved at dispatch time instead. Listing the
 * keys in the same menu as the modes also stops an agent from "helpfully"
 * passing a mode string as `model` and silently overriding a persona's route.
 *
 * Callers are responsible for checking `exposeCatalogInSystemPrompt` and config
 * validity before appending this to a system prompt.
 */
export function formatModeCatalog(config: ModeConfig, routes: ResolvedRoute[] = []): string {
  const lines = [...INTRO, ...config.modes.map(formatModeLine)];
  if (routes.length > 0) lines.push(...ROUTES_INTRO, ...routes.map(formatRouteLine));
  return lines.join("\n");
}
