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
import { createOracleTool } from "./oracle-tool.ts";
import { formatPromotedGuidance } from "./promotion.ts";
import { createSubagentTool } from "./subagent-tool.ts";

/** Identity of a catalog, for deciding whether a re-registration is worthwhile. */
function catalogFingerprint(result: AgentDiscoveryResult): string {
	return result.agents.map((a) => `${a.source}:${a.name}:${a.description}`).join("|");
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
		if (nextFingerprint === fingerprint) return;
		discovery = next;
		fingerprint = nextFingerprint;
		pi.registerTool(createSubagentTool(discovery));
	});

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
