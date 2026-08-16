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
