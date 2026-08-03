import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentConfig } from "./agents.ts";
import { buildAgentNameSchema, buildToolDescription, formatAgentCatalog, formatAgentNames } from "./catalog.ts";

const agents = [
	{ name: "reviewer", description: "Reviews code", source: "user" },
	{ name: "scout", description: "Recon", source: "project" },
] as AgentConfig[];

describe("formatAgentCatalog", () => {
	test("lists each persona with its source and description", () => {
		assert.equal(formatAgentCatalog(agents), "reviewer (user) — Reviews code\nscout (project) — Recon");
	});

	test("explains where to add personas when there are none", () => {
		assert.match(formatAgentCatalog([]), /No subagents are configured/);
	});

	test("points at the shipped examples when there are none", () => {
		assert.match(formatAgentCatalog([], "/pkg/examples/agents"), /Examples to copy live in \/pkg\/examples\/agents/);
	});

	test("tells the caller not to invent a persona when there are none", () => {
		assert.match(formatAgentCatalog([]), /Do not call this tool until at least one exists/);
	});
});

describe("formatAgentNames", () => {
	test("quotes each name", () => {
		assert.equal(formatAgentNames(agents), '"reviewer", "scout"');
	});

	test('renders "none" for an empty catalog', () => {
		assert.equal(formatAgentNames([]), "none");
	});
});

describe("buildAgentNameSchema", () => {
	test("closes the enum over the discovered names", () => {
		const schema = buildAgentNameSchema(agents) as { enum?: string[]; type?: string };
		assert.deepEqual(schema.enum, ["reviewer", "scout"]);
	});

	test("carries the catalog in the description", () => {
		const schema = buildAgentNameSchema(agents) as { description?: string };
		assert.match(schema.description ?? "", /reviewer \(user\) — Reviews code/);
	});

	test("degrades to a plain string with no personas, since an empty enum is not valid schema", () => {
		const schema = buildAgentNameSchema([]) as { enum?: string[]; type?: string };
		assert.equal(schema.type, "string");
		assert.equal(schema.enum, undefined);
	});
});

describe("buildToolDescription", () => {
	test("names every available agent", () => {
		const description = buildToolDescription(agents);
		assert.match(description, /reviewer/);
		assert.match(description, /scout/);
	});
});
