import type { ResolvedRoute } from "./routes.ts";
import type { ModeConfig, ModeDefinition } from "./types.ts";

const INTRO = [
  "## Available agent modes (agent-modes extension)",
  "",
  "When dispatching subagents (e.g. via the `subagent` tool's `model` parameter), pass the backticked value that *starts* one of the lines below, verbatim and including any `:level` suffix. A mode's name is shown for orientation only — it is not a value this parameter accepts.",
  "",
];

function modelString(mode: ModeDefinition): string {
  const base = `${mode.provider}/${mode.model}`;
  return mode.thinkingLevel === "off" ? base : `${base}:${mode.thinkingLevel}`;
}

/**
 * Model string first and backticked, mode name second and bare.
 *
 * Both lists in this block are read under one rule — the backticked token that
 * starts a line is the string to pass — and the routes list below makes that
 * rule literally true. A mode line that led with a backticked id would break it
 * in the one place where the id is the wrong value: mode ids are not route keys
 * and resolve to nothing, so the child is spawned on a bare word (or, for an id
 * that happens to name a thinking level, the dispatch is refused outright).
 * Leaving the id unbackticked costs the reader nothing and removes the only
 * token here that looks passable and is not.
 */
function formatModeLine(mode: ModeDefinition): string {
  const suffix = mode.description ? ` — ${mode.description}` : "";
  return `- \`${modelString(mode)}\` (mode: ${mode.id})${suffix}`;
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
