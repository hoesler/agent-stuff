import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
	type AgentConfig,
	discoverAgents,
	findNearestProjectAgentsDir,
	splitPromotedSection,
	suggestAgentName,
} from "./agents.ts";

const roots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-agents-"));
	roots.push(dir);
	return dir;
}

function writeAgent(dir: string, file: string, frontmatter: string, body = "Body."): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`);
	return path;
}

/** A discovery setup whose source dirs are all empty unless written to. */
function setup() {
	const root = tempRoot();
	const userDir = join(root, "user");
	const cwd = join(root, "project", "nested");
	mkdirSync(cwd, { recursive: true });
	const projectDir = join(root, "project", ".pi", "agents");
	return { root, userDir, cwd, projectDir };
}

afterEach(() => {
	// Temp dirs are small and the OS reclaims them; keep them for failure triage.
	roots.length = 0;
});

describe("discoverAgents", () => {
	test("reads name, description, tools and model from frontmatter", () => {
		const s = setup();
		writeAgent(s.userDir, "scout.md", "name: scout\ndescription: Recon\ntools: read, grep , find\nmodel: haiku");

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.equal(agents.length, 1);
		assert.deepEqual(agents[0].tools, ["read", "grep", "find"]);
		assert.equal(agents[0].model, "haiku");
		assert.equal(agents[0].source, "user");
		assert.match(agents[0].systemPrompt, /Body\./);
	});

	test("skips files missing name or description", () => {
		const s = setup();
		writeAgent(s.userDir, "no-name.md", "description: orphan");
		writeAgent(s.userDir, "no-desc.md", "name: orphan");
		writeAgent(s.userDir, "ok.md", "name: ok\ndescription: fine");

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.deepEqual(
			agents.map((a) => a.name),
			["ok"],
		);
	});

	test("a project persona shadows a user persona of the same name", () => {
		const s = setup();
		writeAgent(s.userDir, "a.md", "name: dup\ndescription: from user");
		writeAgent(s.projectDir, "a.md", "name: dup\ndescription: from project");

		const userOnly = discoverAgents({ ...s, includeProject: false });
		assert.deepEqual(
			userOnly.agents.map((a) => a.description),
			["from user"],
		);

		const withProject = discoverAgents({ ...s, includeProject: true });
		assert.deepEqual(
			withProject.agents.map((a) => a.description),
			["from project"],
		);
	});

	test("excludes project agents when the project is not trusted, and says so", () => {
		const s = setup();
		writeAgent(s.projectDir, "evil.md", "name: evil\ndescription: repo-controlled");

		const result = discoverAgents({ ...s, includeProject: false });

		assert.deepEqual(result.agents, []);
		assert.equal(result.projectAgentsDir, s.projectDir);
		assert.equal(result.projectAgentsSkipped, true);
	});

	test("reports no skip when the project has no agents directory", () => {
		const s = setup();

		const result = discoverAgents({ ...s, includeProject: false });

		assert.equal(result.projectAgentsDir, null);
		assert.equal(result.projectAgentsSkipped, false);
	});

	test("follows symlinked agent files", () => {
		const s = setup();
		const target = writeAgent(join(s.root, "elsewhere"), "real.md", "name: linked\ndescription: via symlink");
		mkdirSync(s.userDir, { recursive: true });
		symlinkSync(target, join(s.userDir, "linked.md"));

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.deepEqual(
			agents.map((a) => a.name),
			["linked"],
		);
	});

	test("returns agents sorted by name so the catalog is stable", () => {
		const s = setup();
		writeAgent(s.userDir, "z.md", "name: zulu\ndescription: z");
		writeAgent(s.userDir, "a.md", "name: alpha\ndescription: a");
		writeAgent(s.userDir, "m.md", "name: mike\ndescription: m");

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.deepEqual(
			agents.map((a) => a.name),
			["alpha", "mike", "zulu"],
		);
	});

	test("tolerates a missing directory", () => {
		const s = setup();
		assert.deepEqual(discoverAgents({ ...s, includeProject: true }).agents, []);
	});
});

describe("findNearestProjectAgentsDir", () => {
	test("walks up from the cwd", () => {
		const s = setup();
		mkdirSync(s.projectDir, { recursive: true });
		assert.equal(findNearestProjectAgentsDir(s.cwd), s.projectDir);
	});
});

describe("suggestAgentName", () => {
	const agents = [
		{ name: "reviewer" },
		{ name: "planner" },
		{ name: "scout" },
	] as AgentConfig[];

	test("matches a near miss", () => {
		assert.equal(suggestAgentName("reviewr", agents), "reviewer");
	});

	test("matches a differently-cased name exactly", () => {
		assert.equal(suggestAgentName("Reviewer", agents), "reviewer");
	});

	test("matches a name the caller padded out", () => {
		assert.equal(suggestAgentName("code-reviewer", agents), "reviewer");
	});

	test("returns nothing for an unrelated name", () => {
		assert.equal(suggestAgentName("database-migrator", agents), undefined);
	});

	test("returns nothing when there are no agents", () => {
		assert.equal(suggestAgentName("reviewer", []), undefined);
	});
});

describe("promotion", () => {
	test("splits the When to use section out of the child prompt", () => {
		const { systemPrompt, promotedPrompt } = splitPromotedSection(
			"## When to use\n\nConsult it for hard bugs.\n\n### Not for\n\nGreps.\n\n## Advisor prompt\n\nYou are an advisor.",
		);
		assert.equal(promotedPrompt, "Consult it for hard bugs.\n\n### Not for\n\nGreps.");
		assert.equal(systemPrompt, "## Advisor prompt\n\nYou are an advisor.");
	});

	test("takes the section to end of file when nothing follows it", () => {
		const { systemPrompt, promotedPrompt } = splitPromotedSection("Intro.\n\n## When to use\n\nAlways.");
		assert.equal(promotedPrompt, "Always.");
		assert.equal(systemPrompt, "Intro.");
	});

	test("promotes nothing and leaves the body intact when there is no such section", () => {
		const { systemPrompt, promotedPrompt } = splitPromotedSection("You are an advisor.\n\n## Output\n\nBe brief.");
		assert.equal(promotedPrompt, undefined);
		assert.equal(systemPrompt, "You are an advisor.\n\n## Output\n\nBe brief.");
	});

	test("matches the heading case-insensitively and ignores deeper headings", () => {
		assert.equal(splitPromotedSection("### When to use\n\nNo.").promotedPrompt, undefined);
		assert.equal(splitPromotedSection("## WHEN TO USE\n\nYes.").promotedPrompt, "Yes.");
	});

	test("reads promotedPrompt from a persona with promote: true", () => {
		const s = setup();
		writeAgent(
			s.userDir,
			"advisor.md",
			"name: advisor\ndescription: Advice\nmodel: oracle\npromote: true",
			"## When to use\n\nFor hard bugs.\n\n## Advisor prompt\n\nYou advise.",
		);

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.equal(agents[0].promotedPrompt, "For hard bugs.");
		assert.equal(agents[0].systemPrompt, "## Advisor prompt\n\nYou advise.");
		assert.equal(agents[0].model, "oracle");
	});

	test("leaves the body alone when promote is absent", () => {
		const s = setup();
		writeAgent(s.userDir, "advisor.md", "name: advisor\ndescription: Advice", "## When to use\n\nFor hard bugs.");

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.equal(agents[0].promotedPrompt, undefined);
		assert.match(agents[0].systemPrompt, /## When to use/);
	});

	test("accepts promote given as a string", () => {
		const s = setup();
		writeAgent(s.userDir, "advisor.md", 'name: advisor\ndescription: Advice\npromote: "true"', "## When to use\n\nX.");

		const { agents } = discoverAgents({ ...s, includeProject: false });

		assert.equal(agents[0].promotedPrompt, "X.");
	});
});
