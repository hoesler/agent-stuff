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
import {
	displayedFailureReason,
	emptyUsage,
	RUNNING_EXIT_CODE,
	runFailureReason,
	type SpawnChild,
	spawnAgentRun,
} from "./run.ts";

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

/**
 * The reason a failure is reported with, read by both the tool result the
 * calling agent receives and every TUI surface. Two fields can carry it, and
 * which one is populated depends on how far the run got — so a reader that
 * consults only one of them goes silent for a whole class of failure.
 */
describe("runFailureReason", () => {
	const base = { exitCode: 1, messages: [], stderr: "", usage: emptyUsage() };

	test("prefers errorMessage, which is how a started child reports", () => {
		assert.equal(runFailureReason({ ...base, errorMessage: "Timed out after 5s." }), "Timed out after 5s.");
	});

	test("falls back to stderr, the only field a pre-dispatch failure sets", () => {
		assert.equal(runFailureReason({ ...base, stderr: '  Invalid model "medium"\n' }), 'Invalid model "medium"');
	});

	test("is empty when a run left no account of itself", () => {
		assert.equal(runFailureReason(base), "");
	});
});

/**
 * What a rendered surface shows. One rule for every mode, so a failure cannot
 * be reported in the tool result and stay invisible in the TUI — which is what
 * happened while the renderers read `errorMessage` alone and a failure that
 * happened before any child existed set only `stderr`.
 */
describe("displayedFailureReason", () => {
	const base = { exitCode: 1, messages: [], stderr: "", usage: emptyUsage() };

	test("shows the reason a pre-dispatch failure left in stderr", () => {
		assert.equal(displayedFailureReason({ ...base, stderr: 'Unknown agent: "ghost".' }), 'Unknown agent: "ghost".');
	});

	test("shows the reason a started child left in errorMessage", () => {
		const timedOut = { ...base, exitCode: 0, stopReason: "timeout", errorMessage: "Timed out after 5s." };
		assert.equal(displayedFailureReason(timedOut), "Timed out after 5s.");
	});

	test("says nothing about a run that succeeded", () => {
		assert.equal(displayedFailureReason({ ...base, exitCode: 0, stderr: "a harmless warning" }), "");
	});

	// A live parallel batch re-renders on every update, and the running sentinel
	// is a non-zero exit code — so without the guard a task that merely wrote to
	// stderr would be labelled an error while it was still working.
	test("says nothing about a task that is still running", () => {
		const running = { ...base, exitCode: RUNNING_EXIT_CODE, stderr: "a warning, mid-flight" };
		assert.equal(displayedFailureReason(running), "");
	});
});

/**
 * A wall-clock budget is a guess the caller has no way to calibrate: it cannot
 * know whether the delegated work is a one-file read or a module-wide
 * refactor, so a low guess kills a run that was working. Silence is a fact
 * about the run rather than a prediction about it, and it is what a deadlocked
 * child actually produces.
 *
 * Every test that expects a child to be killed carries its own `timeout`: a
 * deadline that fails to fire would otherwise hang the suite instead of
 * failing it.
 */
describe("idle deadline", () => {
	/** Emits `event` every 50ms, forever, so the child is alive but never finishes. */
	const chattyChild = (event: unknown): SpawnChild => () =>
		spawn(process.execPath, ["-e", `setInterval(() => console.log(${JSON.stringify(JSON.stringify(event))}), 50);`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

	const thinkingDelta = {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "..." },
	};

	test("terminates a child that has gone silent", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: hangingChild, idleSeconds: 0.3 });

		assert.equal(result.stopReason, "timeout");
		assert.match(result.errorMessage ?? "", /no output for 0\.3s/);
		assert.notEqual(result.exitCode, 0);
	});

	test("keeps what the child produced before it went silent", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: hangingChild, idleSeconds: 0.3 });

		assert.equal(result.messages.length, 1);
		assert.equal(result.usage.turns, 1);
	});

	// The reason this is measured on every parsed event rather than on the two
	// the result records: a high-effort turn streams nothing but thinking
	// deltas, and an idle timer blind to them would kill the child precisely on
	// the hard task it was delegated.
	test("a child streaming only thinking deltas is not silent", { timeout: 5000 }, async () => {
		const controller = new AbortController();
		const pending = run({ spawnChild: chattyChild(thinkingDelta), idleSeconds: 0.3, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 900));
		controller.abort();

		const result = await pending;

		assert.equal(result.stopReason, "aborted");
	});

	test("a run that finishes before going idle is untouched", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: quickChild, idleSeconds: 30 });

		assert.equal(result.stopReason, undefined);
		assert.equal(result.exitCode, 0);
	});

	test("a non-positive threshold is ignored rather than killing the run on the spot", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: quickChild, idleSeconds: 0 });

		assert.equal(result.stopReason, undefined);
		assert.equal(result.exitCode, 0);
	});

	// The wall clock is demoted to a ceiling, not deleted: a child that streams
	// steadily forever never goes idle, and unattended it would run until the
	// session ended.
	test("the wall-clock ceiling still stops a child that never goes idle", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: chattyChild(thinkingDelta), idleSeconds: 30, timeoutSeconds: 0.4 });

		assert.equal(result.stopReason, "timeout");
		assert.match(result.errorMessage ?? "", /Timed out after 0\.4s/);
	});
});

/**
 * What the calling agent is told about a termination. Without this it reads the
 * child's last prose — "now let me run the test suite" — and learns nothing
 * about the `bash` call that swallowed the remaining budget, so it cannot tell
 * a deadlock from a task that merely needed longer.
 */
describe("in-flight diagnostics", () => {
	const assistantWithCall = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Now let me run the test suite." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
			],
			provider: "stub",
			model: "stub-model",
		},
	};

	/** Emits each event as its own line, then hangs until it is killed. */
	const emitting = (...events: unknown[]): SpawnChild => {
		const lines = events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))});`).join("");
		return () =>
			spawn(process.execPath, ["-e", `${lines} setInterval(() => {}, 1000);`], {
				stdio: ["ignore", "pipe", "pipe"],
			});
	};

	test("names the tool call that was still running when the child was killed", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: emitting(assistantWithCall), idleSeconds: 0.3 });

		assert.match(result.errorMessage ?? "", /In flight: bash\(npm test\)/);
	});

	test("says nothing about tool calls when the child was between turns", { timeout: 5000 }, async () => {
		const result = await run({ spawnChild: hangingChild, idleSeconds: 0.3 });

		assert.doesNotMatch(result.errorMessage ?? "", /In flight/);
	});

	test("a call whose result arrived is not reported as in flight", { timeout: 5000 }, async () => {
		const answered = {
			type: "tool_result_end",
			message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], isError: false },
		};

		const result = await run({ spawnChild: emitting(assistantWithCall, answered), idleSeconds: 0.3 });

		assert.doesNotMatch(result.errorMessage ?? "", /In flight/);
	});
});
