/**
 * Lifts each promoted persona's own "when to use" guidance into the *calling*
 * agent's system prompt, so the escalation is described in a file the user edits
 * rather than in this extension's source. The extension learns no domain concept
 * from it; it only moves text.
 */

import { resolveRoute } from "./routes.ts";

export interface PromotablePersona {
	name: string;
	model?: string;
	promotedPrompt?: string;
}

/**
 * A persona is promotable when it carries promoted text and — if its `model` is
 * a bare route key — that key currently resolves.
 *
 * The route gate is what makes a per-mode opt-out complete. Without it, a mode
 * that switched its route off would still promote "consult X for…"; the agent
 * would obey, the bare value would pass through unresolved, and the child would
 * die on an unknown model — the dangling instruction this design avoids.
 *
 * Dispatch is deliberately not gated the same way: this extension cannot tell a
 * route key from a model name the caller typed, so an unresolved value still
 * passes through. Gating promotion is enough — the agent is never told to use
 * what cannot run, and a caller who names the persona anyway keeps the escape
 * hatch. A skipped persona stays in the `agent` enum either way.
 *
 * Called per turn from `before_agent_start`, so promotion tracks the active mode
 * with no new event, no catalog rebuild, and a static `agent` enum.
 */
export function formatPromotedGuidance(
	agents: PromotablePersona[],
	resolve: (key: string) => string | undefined = resolveRoute,
): string | undefined {
	const sections: string[] = [];
	for (const agent of agents) {
		const text = agent.promotedPrompt?.trim();
		if (!text) continue;
		if (agent.model && !agent.model.includes("/") && !resolve(agent.model)) continue;
		sections.push(`### ${agent.name}\n\n${text}`);
	}
	if (sections.length === 0) return undefined;
	return `## Subagent guidance (subagent extension)\n\n${sections.join("\n\n")}`;
}
