/**
 * Persona lookup, persona dispatch, and the orchestration `execute` wraps
 * around them — the half of a subagent run that is not the child process.
 * Termination and partial results are covered in `run.test.ts`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { HERDR_BLOCKED_EVENT } from "../herdr-blocked/blocked.ts";
import type { AgentConfig, AgentDiscoveryResult } from "./agents.ts";
import { displayedFailureReason } from "./run.ts";
import { createSubagentTool, runSingleAgent, type SpawnChild, TRUST_PROMPT_TITLE } from "./subagent-tool.ts";

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

/**
 * A run that fails before a child exists has no `errorMessage` and no messages
 * — only `stderr`. The TUI used to render exactly those two fields and nothing
 * else, so both branches below reached the user as a bare "(no output)" while
 * the calling agent was handed the explanation. Anything that renders a failure
 * goes through `displayedFailureReason`, so asserting it is non-empty is the guard.
 */
describe("a failure that happens before any child is spawned", () => {
	const spawnChild = (() => quickChild([], "")) as SpawnChild;

	test("an unknown persona still carries a renderable reason", async () => {
		const result = await run({ agentName: "scowt", spawnChild });

		assert.equal(result.messages.length, 0, "no messages, so the renderer has only the reason");
		assert.equal(result.errorMessage, undefined, "no child ran, so nothing set errorMessage");
		assert.match(displayedFailureReason(result), /Unknown agent: "scowt"/);
	});

	test("a model that cannot be one still carries a renderable reason", async () => {
		const result = await run({ globalModel: "medium", spawnChild });

		assert.equal(result.messages.length, 0);
		assert.equal(result.errorMessage, undefined);
		assert.match(displayedFailureReason(result), /that is a thinking level, not a model/);
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

/**
 * `execute`'s own orchestration, reached through the `spawnChild` seam so the
 * real persona lookup and model precedence stay in the path. Everything here
 * runs between the tool call and `runSingleAgent`, and nothing else asserts it.
 */
describe("execute", () => {
	/** A child that emits one assistant message carrying `text`, then exits. */
	const emittingChild = (text: string) => {
		const message = {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }], provider: "stub", model: "stub-model" },
		};
		return spawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(message))})`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	};

	/** Records the task each child was handed, and replies with a scripted output. */
	function children(...outputs: string[]) {
		const tasks: string[] = [];
		const spawnChild: SpawnChild = (args) => {
			const text = outputs[tasks.length] ?? "";
			tasks.push(args.at(-1) ?? "");
			return emittingChild(text);
		};
		return { tasks, spawnChild };
	}

	const discovery = (...configs: AgentConfig[]): AgentDiscoveryResult => ({
		agents: configs.length > 0 ? configs : agents,
		projectAgentsDir: "/repo/.pi/agents",
		projectAgentsSkipped: false,
	});

	const projectAgent = (name: string): AgentConfig =>
		({ ...agents[0], name, source: "project" }) as AgentConfig;

	const cwd = mkdtempSync(join(tmpdir(), "subagent-exec-"));

	/** A ctx with no UI, so the trust gate does not apply. */
	const headless = { cwd, hasUI: false };

	/**
	 * What a caller actually sees. Narrowed here rather than at each assertion:
	 * `AgentToolResult` reaches this package through `@earendil-works/pi-agent-core`,
	 * which is not installed, so its members are not visible to read.
	 */
	interface ExecuteResult {
		isError?: boolean;
		content: { type: string; text: string }[];
		details: { mode: string; results: { exitCode: number; step?: number }[] };
	}

	async function execute(
		result: AgentDiscoveryResult,
		params: unknown,
		ctx: unknown,
		spawnChild?: SpawnChild,
		events?: EventBus,
	): Promise<ExecuteResult> {
		const tool = createSubagentTool(result, { spawnChild, events });
		const outcome = await tool.execute(
			"call-id",
			params as never,
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		return outcome as unknown as ExecuteResult;
	}

	describe("chain", () => {
		test("substitutes the prior step's output into the next step's task", async () => {
			const { tasks, spawnChild } = children("the first answer");
			await execute(
				discovery(),
				{
					chain: [
						{ agent: "stub", task: "start" },
						{ agent: "stub", task: "continue from {previous}" },
					],
				},
				headless,
				spawnChild,
			);

			assert.equal(tasks[1], "Task: continue from the first answer");
		});

		test("treats the prior output as text, never as a replacement pattern", async () => {
			// `$&` in a string replacement expands to the matched substring, so a
			// step whose output contains one would corrupt the next step's prompt.
			const { tasks, spawnChild } = children("costs $& and $1");
			await execute(
				discovery(),
				{
					chain: [
						{ agent: "stub", task: "start" },
						{ agent: "stub", task: "report {previous}" },
					],
				},
				headless,
				spawnChild,
			);

			assert.equal(tasks[1], "Task: report costs $& and $1");
		});

		test("substitutes every occurrence, not just the first", async () => {
			const { tasks, spawnChild } = children("X");
			await execute(
				discovery(),
				{
					chain: [
						{ agent: "stub", task: "start" },
						{ agent: "stub", task: "{previous} then {previous}" },
					],
				},
				headless,
				spawnChild,
			);

			assert.equal(tasks[1], "Task: X then X");
		});

		test("a failed step stops the chain before the later steps run", async () => {
			// An unknown agent fails without spawning, so the recorded tasks are
			// exactly the steps that got as far as a child.
			const { tasks, spawnChild } = children("first", "third");
			const result = await execute(
				discovery(),
				{
					chain: [
						{ agent: "stub", task: "one" },
						{ agent: "ghost", task: "two" },
						{ agent: "stub", task: "three" },
					],
				},
				headless,
				spawnChild,
			);

			assert.deepEqual(tasks, ["Task: one"]);
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /Chain stopped at step 2 \(ghost\)/);
		});

		test("the steps that already completed survive the stop", async () => {
			// Returning an empty list here would discard the record of work already
			// done and paid for — the same guarantee a killed run makes in run.ts.
			const { spawnChild } = children("first");
			const result = await execute(
				discovery(),
				{
					chain: [
						{ agent: "stub", task: "one" },
						{ agent: "ghost", task: "two" },
					],
				},
				headless,
				spawnChild,
			);

			const { results } = result.details;
			assert.equal(results.length, 2);
			assert.deepEqual(
				results.map((r) => [r.step, r.exitCode]),
				[
					[1, 0],
					[2, 1],
				],
			);
		});
	});

	describe("parallel", () => {
		test("a batch with one survivor is not an error", async () => {
			// Siblings are independent: one bad task must not condemn the rest.
			const { tasks, spawnChild } = children("done");
			const result = await execute(
				discovery(),
				{
					tasks: [
						{ agent: "stub", task: "one" },
						{ agent: "ghost", task: "two" },
					],
				},
				headless,
				spawnChild,
			);

			assert.deepEqual(tasks, ["Task: one"]);
			assert.notEqual(result.isError, true);
			assert.match(result.content[0].text, /Parallel: 1\/2 succeeded/);
		});

		test("a batch is an error only once nothing at all succeeded", async () => {
			const { spawnChild } = children();
			const result = await execute(
				discovery(),
				{
					tasks: [
						{ agent: "ghost", task: "one" },
						{ agent: "phantom", task: "two" },
					],
				},
				headless,
				spawnChild,
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /Parallel: 0\/2 succeeded/);
		});

		test("each failure carries the reason the caller needs to retry", async () => {
			// The summary is all the caller sees of a failed sibling, so a bare
			// "failed" would strand it with no way to correct the call.
			const { spawnChild } = children("done");
			const result = await execute(
				discovery(),
				{
					tasks: [
						{ agent: "stub", task: "one" },
						{ agent: "ghost", task: "two" },
					],
				},
				headless,
				spawnChild,
			);

			const text = result.content[0].text;
			assert.match(text, /\[ghost\].*Unknown agent: "ghost"/s);
			assert.match(text, /Available agents: "stub"/);
		});
	});

	describe("project-agent trust gate", () => {
		/** A ctx whose confirmation always answers `approved`, recording the prompts. */
		function ui(approved: boolean) {
			const prompts: string[] = [];
			const ctx = {
				cwd,
				hasUI: true,
				ui: {
					confirm: async (_title: string, body: string) => {
						prompts.push(body);
						return approved;
					},
				},
			};
			return { prompts, ctx };
		}

		test("a declined confirmation spawns nothing", async () => {
			const { ctx } = ui(false);
			const { tasks, spawnChild } = children("never runs");
			const result = await execute(
				discovery(projectAgent("repo-agent")),
				{ agent: "repo-agent", task: "do a thing" },
				ctx,
				spawnChild,
			);

			assert.deepEqual(tasks, []);
			assert.match(result.content[0].text, /Canceled: project-local agents not approved/);
		});

		test("an approved confirmation lets the run proceed", async () => {
			const { ctx } = ui(true);
			const { tasks, spawnChild } = children("done");
			await execute(
				discovery(projectAgent("repo-agent")),
				{ agent: "repo-agent", task: "do a thing" },
				ctx,
				spawnChild,
			);

			assert.deepEqual(tasks, ["Task: do a thing"]);
		});

		test("a user-owned persona is never gated", async () => {
			const { prompts, ctx } = ui(false);
			const { tasks, spawnChild } = children("done");
			await execute(discovery(), { agent: "stub", task: "do a thing" }, ctx, spawnChild);

			assert.deepEqual(prompts, []);
			assert.deepEqual(tasks, ["Task: do a thing"]);
		});

		test("one confirmation names every project persona the call would run", async () => {
			const { prompts, ctx } = ui(false);
			const { spawnChild } = children();
			await execute(
				discovery(projectAgent("one"), projectAgent("two"), agents[0]),
				{
					chain: [
						{ agent: "one", task: "a" },
						{ agent: "stub", task: "b" },
						{ agent: "two", task: "c" },
					],
				},
				ctx,
				spawnChild,
			);

			assert.equal(prompts.length, 1);
			assert.match(prompts[0], /Agents: one, two/);
			assert.match(prompts[0], /Source: \/repo\/\.pi\/agents/);
		});

		test("a headless run is not gated, since there is nobody to ask", async () => {
			const { tasks, spawnChild } = children("done");
			await execute(
				discovery(projectAgent("repo-agent")),
				{ agent: "repo-agent", task: "do a thing" },
				headless,
				spawnChild,
			);

			assert.deepEqual(tasks, ["Task: do a thing"]);
		});

		/** A bus that records what herdr would have been told. */
		function recordingBus() {
			const sent: { channel: string; data: unknown }[] = [];
			const events: EventBus = { emit: (channel, data) => void sent.push({ channel, data }), on: () => () => {} };
			return { sent, events };
		}

		test("the confirmation reports the pane as blocked for as long as it is open", async () => {
			const { spawnChild } = children("done");
			const { sent, events } = recordingBus();
			let whileOpen: unknown[] = [];
			const ctx = {
				cwd,
				hasUI: true,
				ui: {
					confirm: async () => {
						whileOpen = sent.map((s) => s.data);
						return true;
					},
				},
			};

			await execute(
				discovery(projectAgent("repo-agent")),
				{ agent: "repo-agent", task: "do a thing" },
				ctx,
				spawnChild,
				events,
			);

			assert.deepEqual(whileOpen, [{ active: true, label: TRUST_PROMPT_TITLE }]);
			assert.deepEqual(sent, [
				{ channel: HERDR_BLOCKED_EVENT, data: { active: true, label: TRUST_PROMPT_TITLE } },
				{ channel: HERDR_BLOCKED_EVENT, data: { active: false } },
			]);
		});

		test("a run with nothing to confirm reports no block at all", async () => {
			const { spawnChild } = children("done");
			const { sent, events } = recordingBus();
			const { ctx } = ui(true);

			await execute(discovery(), { agent: "stub", task: "do a thing" }, ctx, spawnChild, events);

			assert.deepEqual(sent, []);
		});
	});
});
