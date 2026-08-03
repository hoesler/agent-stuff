/**
 * Termination behaviour of a subagent run, exercised against real child
 * processes: a run that is killed must still hand back what it produced.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AgentConfig } from "./agents.ts";
import { runSingleAgent, type SpawnChild } from "./index.ts";

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

/** A child that emits one assistant message, then hangs until it is killed. */
const hangingChild: SpawnChild = () => {
	const message = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "partial work" }],
			provider: "stub",
			model: "stub-model",
			usage: { input: 10, output: 5, cost: { total: 0.01 } },
		},
	};
	return spawn(
		process.execPath,
		["-e", `console.log(${JSON.stringify(JSON.stringify(message))}); setInterval(() => {}, 1000);`],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
};

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

describe("timeout", () => {
	test("terminates the child and returns the partial run instead of throwing", async () => {
		const result = await run({ spawnChild: hangingChild, timeoutSeconds: 0.3 });

		assert.equal(result.stopReason, "timeout");
		assert.match(result.errorMessage ?? "", /Timed out after 0\.3s/);
		assert.notEqual(result.exitCode, 0);
	});

	test("keeps the output and usage the child produced before it was killed", async () => {
		const result = await run({ spawnChild: hangingChild, timeoutSeconds: 0.3 });

		assert.equal(result.messages.length, 1);
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.cost, 0.01);
		assert.equal(result.resolvedModel, "stub/stub-model");
	});

	test("a run that finishes inside its budget is untouched", async () => {
		const result = await run({ spawnChild: quickChild, timeoutSeconds: 30 });

		assert.equal(result.stopReason, undefined);
		assert.equal(result.exitCode, 0);
	});

	test("a non-positive budget is ignored rather than killing the run on the spot", async () => {
		const result = await run({ spawnChild: quickChild, timeoutSeconds: 0 });

		assert.equal(result.stopReason, undefined);
		assert.equal(result.exitCode, 0);
	});
});

describe("abort", () => {
	test("returns the partial run rather than throwing it away", async () => {
		const controller = new AbortController();
		const pending = run({ spawnChild: hangingChild, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 200));
		controller.abort();

		const result = await pending;

		assert.equal(result.stopReason, "aborted");
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.messages.length, 1);
	});

	test("an already-aborted signal stops the run immediately", async () => {
		const result = await run({ spawnChild: hangingChild, signal: AbortSignal.abort() });

		assert.equal(result.stopReason, "aborted");
	});

	test("releases its abort listener when the child exits on its own", async () => {
		// One signal drives every step of a chain, so a listener left behind by a
		// finished step would accumulate across the whole chain.
		const controller = new AbortController();
		for (let i = 0; i < 3; i++) {
			await run({ spawnChild: quickChild, signal: controller.signal });
		}

		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
});

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
