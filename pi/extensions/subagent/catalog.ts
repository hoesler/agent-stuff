/**
 * Turns discovered personas into the parts of the tool contract the model sees:
 * the `agent` parameter's schema and the tool description.
 *
 * The catalog lives in the tool contract rather than the system prompt on
 * purpose. Descriptions of active tools are sent with every request anyway, so
 * the system prompt buys no extra visibility, and only the schema can make an
 * invented persona name a validation failure instead of a runtime error.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import type { AgentConfig } from "./agents.ts";

/**
 * What to say when nothing is configured. This is the only guidance a fresh
 * install gets, so it names both the destination and the examples to start
 * from — the examples ship as files to copy and edit, never as live personas.
 */
function noAgentsHint(examplesDir: string | undefined): string {
	const source = examplesDir ? ` Examples to copy live in ${examplesDir}.` : "";
	return `No subagents are configured. Add persona files to ~/.pi/agent/agents (or .pi/agents in a trusted project).${source} Do not call this tool until at least one exists.`;
}

/** One `name (source) — description` line per persona. */
export function formatAgentCatalog(agents: AgentConfig[], examplesDir?: string): string {
	if (agents.length === 0) return noAgentsHint(examplesDir);
	return agents.map((a) => `${a.name} (${a.source}) — ${a.description}`).join("\n");
}

/** Compact single-line form, for error messages and non-schema contexts. */
export function formatAgentNames(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `"${a.name}"`).join(", ");
}

/**
 * Schema for an `agent` field. With personas available this is a closed enum,
 * so a name outside the catalog fails schema validation before `execute` runs —
 * and providers that constrain decoding to the tool schema cannot emit one at
 * all. With none available it degrades to a plain string: an empty enum is not
 * valid JSON Schema for several providers, and the tool should explain itself
 * rather than fail to register.
 */
export function buildAgentNameSchema(agents: AgentConfig[], examplesDir?: string): TSchema {
	const description = `Persona to invoke. Available agents:\n${formatAgentCatalog(agents, examplesDir)}`;
	if (agents.length === 0) return Type.String({ description });
	return StringEnum(
		agents.map((a) => a.name),
		{ description },
	);
}

/** Tool-level description, including the catalog for models that weight it over per-parameter text. */
export function buildToolDescription(agents: AgentConfig[], examplesDir?: string): string {
	const lines = [
		"Delegate tasks to specialized subagents, each running in a separate pi process with its own context window.",
		"Modes (provide exactly one): single (agent + task), parallel (tasks array), chain (sequential, with {previous} substituted from the prior step's output).",
		"",
		"Available agents:",
		formatAgentCatalog(agents, examplesDir),
	];
	return lines.join("\n");
}
