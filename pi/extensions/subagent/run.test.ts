/**
 * Termination behaviour of an agent run, exercised against real child
 * processes: a run that is killed must still hand back what it produced.
 * Both tools in this extension reach the child through this one seam.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type SpawnChild, spawnAgentRun } from "./run.ts";

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
	return spawnAgentRun({
		task: "do a thing",
		cwd: mkdtempSync(join(tmpdir(), "agent-run-")),
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

describe("dispatch arguments", () => {
	test("omits --model and --tools when none are given, and never appends a system prompt", async () => {
		let captured: string[] = [];
		await run({
			spawnChild: ((args: string[]) => {
				captured = args;
				return quickChild([], "");
			}) as SpawnChild,
		});

		assert.deepEqual(captured, ["--mode", "json", "-p", "--no-session", "do a thing"]);
	});

	test("passes the resolved model and tool list through verbatim", async () => {
		let captured: string[] = [];
		await run({
			model: "anthropic/claude-fable-5:high",
			tools: ["read", "grep", "find", "ls"],
			spawnChild: ((args: string[]) => {
				captured = args;
				return quickChild([], "");
			}) as SpawnChild,
		});

		assert.deepEqual(captured.slice(0, 8), [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"anthropic/claude-fable-5:high",
			"--tools",
			"read,grep,find,ls",
		]);
	});
});

describe("system prompt", () => {
	/** Captures the child's argv and the prompt file's contents before it is unlinked. */
	function capturing(sink: { args: string[]; prompt?: string }): SpawnChild {
		return (args) => {
			sink.args = args;
			for (const flag of ["--system-prompt", "--append-system-prompt"]) {
				const i = args.indexOf(flag);
				if (i >= 0) sink.prompt = readFileSync(args[i + 1], "utf-8");
			}
			return quickChild([], "");
		};
	}

	test("an appending prompt stacks on pi's own framing", async () => {
		const sink = { args: [] as string[] };
		await run({ systemPrompt: "be terse", spawnChild: capturing(sink) });

		assert.ok(sink.args.includes("--append-system-prompt"));
		assert.ok(!sink.args.includes("--system-prompt"));
	});

	test("a replacing prompt replaces it, and its text reaches the child", async () => {
		const sink = { args: [] as string[], prompt: undefined as string | undefined };
		await run({ replaceSystemPrompt: "you are consulted", spawnChild: capturing(sink) });

		assert.ok(sink.args.includes("--system-prompt"));
		assert.ok(!sink.args.includes("--append-system-prompt"));
		assert.equal(sink.prompt, "you are consulted");
	});

	test("supplying both is a programming error, not a silent choice", async () => {
		await assert.rejects(
			run({ systemPrompt: "a", replaceSystemPrompt: "b", spawnChild: quickChild }),
			/systemPrompt and replaceSystemPrompt/,
		);
	});
});

describe("skills", () => {
	test("--no-skills is passed only when asked for", async () => {
		let captured: string[] = [];
		const capture: SpawnChild = (args) => {
			captured = args;
			return quickChild([], "");
		};

		await run({ spawnChild: capture });
		assert.ok(!captured.includes("--no-skills"));

		await run({ noSkills: true, spawnChild: capture });
		assert.ok(captured.includes("--no-skills"));
	});
});
