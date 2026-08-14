/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Where a persona came from. A name defined in both places resolves to the
 * project file, so a repo can shadow one of the user's own personas.
 */
export type AgentSource = "user" | "project";

const SOURCE_PRECEDENCE: AgentSource[] = ["user", "project"];

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	/**
	 * The persona's `## When to use` section, lifted out of `systemPrompt` for the
	 * *calling* agent's prompt. Only present for a `promote: true` persona that
	 * actually has such a section.
	 */
	promotedPrompt?: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** True when a project agents directory exists but was excluded for lack of trust. */
	projectAgentsSkipped: boolean;
}

export interface DiscoverAgentsOptions {
	cwd: string;
	/** The user's own persona directory (`~/.pi/agent/agents`). */
	userDir: string;
	/**
	 * Whether to include project-local personas. Callers pass pi's own
	 * project-trust decision: `.pi/agents` is repo-controlled content, and both
	 * its prompt bodies and its descriptions end up in the model's context.
	 */
	includeProject: boolean;
}

/** `## When to use`, exactly at heading level 2. */
const WHEN_TO_USE = /^##[ \t]+when to use[ \t]*$/i;
/** The next level-2 heading, which ends the section. `###` and deeper stay inside it. */
const SECTION_END = /^##(?!#)/;

/**
 * Split a persona body into the guidance meant for the caller and the prompt
 * meant for the child. A `promote: true` persona with no `## When to use`
 * section promotes nothing and still works, so the body comes back untouched.
 */
export function splitPromotedSection(body: string): { systemPrompt: string; promotedPrompt?: string } {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => WHEN_TO_USE.test(line));
	if (start === -1) return { systemPrompt: body };

	const offset = lines.slice(start + 1).findIndex((line) => SECTION_END.test(line));
	const end = offset === -1 ? lines.length : start + 1 + offset;

	const promoted = lines.slice(start + 1, end).join("\n").trim();
	const remainder = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
	return {
		systemPrompt: remainder,
		...(promoted ? { promotedPrompt: promoted } : {}),
	};
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		// YAML yields a real boolean, but a quoted "true" is a natural thing to
		// write and should not silently do nothing.
		const promoteRaw = frontmatter.promote as unknown;
		const promote = promoteRaw === true || String(promoteRaw).trim() === "true";
		const { systemPrompt, promotedPrompt } = promote
			? splitPromotedSection(body)
			: { systemPrompt: body, promotedPrompt: undefined };

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt,
			...(promotedPrompt ? { promotedPrompt } : {}),
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Collect every persona visible to this session, sorted by name so the catalog
 * the model sees is stable across turns.
 */
export function discoverAgents(options: DiscoverAgentsOptions): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(options.cwd);
	const includeProject = options.includeProject && projectAgentsDir !== null;

	const byName = new Map<string, AgentConfig>();
	const loaded: AgentConfig[] = [
		...loadAgentsFromDir(options.userDir, "user"),
		...(includeProject ? loadAgentsFromDir(projectAgentsDir as string, "project") : []),
	];

	for (const agent of loaded) {
		const existing = byName.get(agent.name);
		if (existing && SOURCE_PRECEDENCE.indexOf(agent.source) < SOURCE_PRECEDENCE.indexOf(existing.source)) {
			continue;
		}
		byName.set(agent.name, agent);
	}

	return {
		agents: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		projectAgentsDir,
		projectAgentsSkipped: projectAgentsDir !== null && !options.includeProject,
	};
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * Best "did you mean" candidate for a name that matched no persona. A model
 * that invents a plausible-looking name (`code-reviewer` for `reviewer`) can
 * then correct itself in one turn instead of guessing again.
 */
export function suggestAgentName(requested: string, agents: AgentConfig[]): string | undefined {
	const target = requested.trim().toLowerCase();
	if (!target) return undefined;

	const caseInsensitive = agents.find((a) => a.name.toLowerCase() === target);
	if (caseInsensitive) return caseInsensitive.name;

	let best: { name: string; distance: number } | undefined;
	for (const agent of agents) {
		const candidate = agent.name.toLowerCase();
		const distance = candidate.includes(target) || target.includes(candidate) ? 1 : editDistance(target, candidate);
		if (!best || distance < best.distance) best = { name: agent.name, distance };
	}

	if (!best) return undefined;
	const budget = Math.max(2, Math.floor(target.length * 0.4));
	return best.distance <= budget ? best.name : undefined;
}
