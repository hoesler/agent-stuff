/**
 * Persona lookup and persona dispatch — the half of a subagent run that is not
 * the child process. Termination and partial results are covered in
 * `run.test.ts`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AgentConfig } from "./agents.ts";
import { runSingleAgent, type SpawnChild } from "./subagent-tool.ts";

const agents = [
	{
		name: "stub",
		description: "Stub persona",
		systemPrompt: "",
		source: "user",
		filePath: "/dev/null",
	},
] as AgentConfig[];

const makeDetails = (results: unknown[]) => ({ mode: "single", projectAgentsDir: null, results }) as never;

/** A child that exits cleanly straight away. */
const quickChild: SpawnChild = () => spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"] });

function run(overrides: Record<string, unknown>) {
	return runSingleAgent({
		defaultCwd: mkdtempSync(join(tmpdir(), "subagent-run-")),
		agents,
		agentName: "stub",
		task: "do a thing",
		makeDetails,
		...overrides,
	});
}

describe("unknown agent", () => {
	test("fails without spawning anything, naming the closest match", async () => {
		let spawned = false;
		const result = await run({
			agentName: "scowt",
			spawnChild: (() => {
				spawned = true;
				return quickChild([], "");
			}) as SpawnChild,
		});

		assert.equal(spawned, false);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Unknown agent: "scowt"/);
	});
});

describe("dispatch", () => {
	test("passes the persona's tools and the Task: framing to the child", async () => {
		let captured: string[] = [];
		await run({
			agents: [{ ...agents[0], tools: ["read", "grep"] }] as AgentConfig[],
			spawnChild: ((args: string[]) => {
				captured = args;
				return quickChild([], "");
			}) as SpawnChild,
		});

		assert.ok(captured.includes("--tools"));
		assert.equal(captured[captured.indexOf("--tools") + 1], "read,grep");
		assert.equal(captured.at(-1), "Task: do a thing");
	});
});

/**
 * The mistake this guards against is a caller reaching for "run this harder"
 * and writing the thinking level alone. Left to pass through, it costs a child
 * process before pi rejects it.
 */
describe("model given as a bare thinking level", () => {
	/** Records whether a child was started, and with which `--model`. */
	function spy() {
		const calls: (string | undefined)[] = [];
		const spawnChild = ((args: string[]) => {
			const i = args.indexOf("--model");
			calls.push(i === -1 ? undefined : args[i + 1]);
			return quickChild([], "");
		}) as SpawnChild;
		return { calls, spawnChild };
	}

	test("fails without spawning anything, naming the mistake", async () => {
		const { calls, spawnChild } = spy();
		const result = await run({ globalModel: "medium", spawnChild });

		assert.deepEqual(calls, []);
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /Invalid model "medium": that is a thinking level, not a model/);
	});

	test("suggests the persona's own model carrying the requested level", async () => {
		const { spawnChild } = spy();
		const result = await run({
			agents: [{ ...agents[0], model: "github-copilot/claude-sonnet-5" }] as AgentConfig[],
			taskModel: "high",
			spawnChild,
		});

		assert.match(result.stderr, /"github-copilot\/claude-sonnet-5:high"/);
	});

	test("does not stack one level on top of another when suggesting", async () => {
		const { spawnChild } = spy();
		const result = await run({
			agents: [{ ...agents[0], model: "github-copilot/claude-sonnet-5:low" }] as AgentConfig[],
			taskModel: "max",
			spawnChild,
		});

		assert.match(result.stderr, /"github-copilot\/claude-sonnet-5:max"/);
		assert.doesNotMatch(result.stderr, /:low:max/);
	});

	test("falls back to a generic example when the persona names no usable model", async () => {
		const { spawnChild } = spy();
		// A route key is not a model reference: appending a level to it defeats
		// the lookup, so it must not be offered as the fix.
		const result = await run({
			agents: [{ ...agents[0], model: "ultra" }] as AgentConfig[],
			taskModel: "high",
			spawnChild,
		});

		assert.doesNotMatch(result.stderr, /"ultra:high"/);
		assert.match(result.stderr, /provider\/model/);
	});

	test("blames the persona file when the level came from its frontmatter", async () => {
		const { spawnChild } = spy();
		const result = await run({
			agents: [{ ...agents[0], model: "medium" }] as AgentConfig[],
			spawnChild,
		});

		assert.equal(result.modelSource, "frontmatter");
		assert.match(result.stderr, /"stub" persona/);
	});

	test("a level attached to a model reference dispatches untouched", async () => {
		const { calls, spawnChild } = spy();
		const result = await run({ globalModel: "github-copilot/claude-sonnet-5:medium", spawnChild });

		assert.deepEqual(calls, ["github-copilot/claude-sonnet-5:medium"]);
		assert.equal(result.exitCode, 0);
	});

	test("a route key that happens to be named after a level still resolves and dispatches", async () => {
		const g = globalThis as { __piModelRouteResolvers?: Set<(key: string) => string | undefined> };
		const resolver = (key: string) => (key === "high" ? "anthropic/claude-opus-5:max" : undefined);
		(g.__piModelRouteResolvers ??= new Set()).add(resolver);
		try {
			const { calls, spawnChild } = spy();
			const result = await run({ globalModel: "high", spawnChild });

			assert.deepEqual(calls, ["anthropic/claude-opus-5:max"]);
			assert.equal(result.exitCode, 0);
		} finally {
			g.__piModelRouteResolvers?.delete(resolver);
		}
	});
});
