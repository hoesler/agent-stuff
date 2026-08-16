/**
 * The composition `createOracleTool` wires together: a fixed read-only tool
 * list, a replacing posture prompt, no skills, and the caller's question passed
 * through verbatim. These are the load-bearing invariants of the tool — the
 * pieces either side (`routes.test.ts`, `availability.test.ts`, `run.test.ts`)
 * are covered elsewhere, but nothing else asserts that `execute` actually
 * dispatches them this way.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createOracleTool, ORACLE_SYSTEM_PROMPT } from "./oracle-tool.ts";
import { ORACLE_ROUTE_KEY } from "./routes.ts";
import { type AgentRunOptions, type AgentRunResult, emptyUsage } from "./run.ts";

type Resolver = (key: string) => string | undefined;
const g = globalThis as { __piModelRouteResolvers?: Set<Resolver> };

function publishRoute(model: string): void {
	g.__piModelRouteResolvers = new Set([(key) => (key === ORACLE_ROUTE_KEY ? model : undefined)]);
}

afterEach(() => {
	delete g.__piModelRouteResolvers;
});

const ctx = { cwd: "/tmp" } as never;

function stubRun(): AgentRunResult {
	return { exitCode: 0, messages: [], stderr: "", usage: emptyUsage() };
}

/** Runs the tool against a published route and hands back what it dispatched. */
async function dispatch(params: { question: string; timeoutSeconds?: number }): Promise<AgentRunOptions> {
	publishRoute("anthropic/claude-fable-5:high");
	let captured: AgentRunOptions | undefined;
	const tool = createOracleTool({
		runAgent: async (options) => {
			captured = options;
			return stubRun();
		},
	});

	await tool.execute("id", params, new AbortController().signal, undefined, ctx);

	if (!captured) throw new Error("expected a run to be dispatched");
	return captured;
}

describe("dispatch", () => {
	test("passes exactly the fixed read-only tool list", async () => {
		const captured = await dispatch({ question: "why is this slow?" });

		assert.deepEqual(captured.tools, ["read", "grep", "find", "ls"]);
	});

	test("sends the posture prompt as a replacing prompt, never an appending one", async () => {
		const captured = await dispatch({ question: "why is this slow?" });

		assert.equal(captured.replaceSystemPrompt, ORACLE_SYSTEM_PROMPT);
		assert.equal(captured.systemPrompt, undefined);
	});

	test("suppresses the skills catalog", async () => {
		const captured = await dispatch({ question: "why is this slow?" });

		assert.equal(captured.noSkills, true);
	});

	test("passes the question verbatim, with no Task: prefix or other wrapping", async () => {
		const question = "Is this retry loop safe under concurrent writes?";
		const captured = await dispatch({ question });

		assert.equal(captured.task, question);
	});

	test("runs in the session's cwd, which the caller cannot choose", async () => {
		// `cwd` is not in the schema; a caller that sends one anyway must not steer
		// the run. Bound to a variable first so it reaches `execute` at all — a bare
		// object literal would be rejected for the excess property at compile time.
		const rogue = { question: "why is this slow?", cwd: "/elsewhere" };
		const captured = await dispatch(rogue);

		assert.equal(captured.cwd, "/tmp");
	});

	test("resolves the model from the route rather than from a parameter", async () => {
		const captured = await dispatch({ question: "why is this slow?" });

		assert.equal(captured.model, "anthropic/claude-fable-5:high");
	});
});

describe("schema", () => {
	test("accepts no cwd parameter", () => {
		const schema = createOracleTool().parameters as unknown as { properties: Record<string, unknown> };

		assert.deepEqual(Object.keys(schema.properties).sort(), ["question", "timeoutSeconds"]);
	});
});

describe("no route", () => {
	test("returns an error with no run attempted", async () => {
		let ran = false;
		const tool = createOracleTool({
			runAgent: async () => {
				ran = true;
				return stubRun();
			},
		});

		const result = await tool.execute("id", { question: "anything" }, new AbortController().signal, undefined, ctx);

		assert.equal(ran, false);
		assert.equal((result as { isError?: boolean }).isError, true);
	});
});
