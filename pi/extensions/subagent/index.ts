/**
 * Delegation to a child `pi` process, as two tools:
 *
 *   - `subagent` delegates a task to a persona, in its own context window.
 *   - `oracle` escalates a question to a deliberately different model.
 *
 * One extension owns both because they share a child-process runner, and an
 * extension directory has to be copyable on its own. Everything here is
 * registration and event wiring; the tools themselves live next door.
 */

import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentDiscoveryResult, discoverAgents } from "./agents.ts";
import { nextActiveTools } from "./availability.ts";
import { createOracleTool, ORACLE_TOOL_NAME } from "./oracle-tool.ts";
import { formatPromotedGuidance } from "./promotion.ts";
import { ORACLE_ROUTE_KEY, resolveRoute } from "./routes.ts";
import { createSubagentTool, SUBAGENT_TOOL_NAME } from "./subagent-tool.ts";

/** Identity of a catalog, for deciding whether a re-registration is worthwhile. */
function catalogFingerprint(result: AgentDiscoveryResult): string {
	return result.agents.map((a) => `${a.source}:${a.name}:${a.description}`).join("|");
}

/**
 * Bring the active tool list in line with what each tool can currently do:
 * `oracle` while its route resolves, `subagent` while at least one persona was
 * discovered. There is no `unregisterTool`; active-list membership is the
 * mechanism.
 *
 * `getActiveTools`/`setActiveTools` live on `ExtensionAPI` (the `pi` handed to
 * the entry point), not on the per-event `ExtensionContext` — so this takes
 * `pi` directly rather than the `ctx` each handler also receives. Both tools
 * are folded into one list before a single write, so neither can undo the
 * other's decision.
 */
function syncAvailability(pi: ExtensionAPI, discovery: AgentDiscoveryResult): void {
	let active = pi.getActiveTools();
	let changed = false;
	const apply = (name: string, available: boolean) => {
		const next = nextActiveTools(name, available, active);
		if (!next) return;
		active = next;
		changed = true;
	};

	apply(ORACLE_TOOL_NAME, resolveRoute(ORACLE_ROUTE_KEY) !== undefined);
	apply(SUBAGENT_TOOL_NAME, discovery.agents.length > 0);
	if (changed) pi.setActiveTools(active);
}

export default function (pi: ExtensionAPI) {
	const userAgentsDir = path.join(getAgentDir(), "agents");

	/**
	 * Load-time discovery leaves project personas out: pi's trust decision is only
	 * readable from an event context, and `.pi/agents` is repo-controlled content
	 * whose descriptions would otherwise reach the model unvetted. `session_start`
	 * re-runs discovery with the session's real cwd and trust state.
	 */
	let discovery = discoverAgents({
		cwd: process.cwd(),
		userDir: userAgentsDir,
		includeProject: false,
	});
	let fingerprint = catalogFingerprint(discovery);
	pi.registerTool(createSubagentTool(discovery));
	pi.registerTool(createOracleTool());

	pi.on("session_start", (_event, ctx) => {
		const next = discoverAgents({
			cwd: ctx.cwd,
			userDir: userAgentsDir,
			includeProject: ctx.isProjectTrusted(),
		});
		const nextFingerprint = catalogFingerprint(next);
		if (nextFingerprint !== fingerprint) {
			discovery = next;
			fingerprint = nextFingerprint;
			// `registerTool` is keyed by tool name, so re-registering replaces the
			// definition and refreshes the live tool list. Sync after it, never
			// before: a re-registration can put the name back into the active list.
			pi.registerTool(createSubagentTool(discovery));
		}
		syncAvailability(pi, discovery);
	});

	// `turn_start` is the cheap catch-all: it covers `/mode` switches and config
	// reloads without this extension needing to know which events `agent-modes`
	// recomputes on, preserving the pull-not-push property that makes the whole
	// route contract order-independent.
	pi.on("model_select", () => syncAvailability(pi, discovery));
	pi.on("thinking_level_select", () => syncAvailability(pi, discovery));
	pi.on("turn_start", () => syncAvailability(pi, discovery));

	/**
	 * Per turn, not per session: a promoted persona's route can stop resolving
	 * when the active mode changes, and the gate inside formatPromotedGuidance
	 * must see the state at this turn's start. Promotion inherits the discovery
	 * trust gate — an untrusted repo's personas are not in `discovery` at all —
	 * and emits nothing when no persona is promotable, so there is never a heading
	 * without a section under it.
	 */
	pi.on("before_agent_start", async (event) => {
		const guidance = formatPromotedGuidance(discovery.agents);
		if (!guidance) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});
}
