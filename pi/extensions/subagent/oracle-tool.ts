/**
 * Oracle — a second opinion from a deliberately different model.
 *
 * The oracle is defined by *who answers*, not by what it is asked: no
 * specialty, no output shape, no subject. All it is, is the `oracle` route
 * (published by `agent-modes`), a fixed read-only tool list, a posture prompt
 * that states only facts about the run, and the caller's question verbatim.
 *
 * It is a tool rather than a `subagent` persona so that the calling agent never
 * has to choose between a model tier and a workflow inside one enum, and so
 * that the name it reaches for matches its intent.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatToolCall, formatUsageStats, getDisplayItems } from "./display.ts";
import { formatModelDisplay } from "./model-display.ts";
import { ORACLE_ROUTE_KEY, resolveRoute } from "./routes.ts";
import {
	type AgentRunResult,
	describeRunFailure,
	emptyUsage,
	getFinalOutput,
	isFailedRun,
	spawnAgentRun,
} from "./run.ts";

/** The name the tool registers under, and the name the active list carries. */
export const ORACLE_TOOL_NAME = "oracle";

/**
 * Fixed, not configurable: read-only is part of what the oracle *is*, and a
 * caller able to grant `bash` would have built something else.
 */
const ORACLE_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Replaces pi's base prompt rather than stacking on it. Sending none is not
 * neutral — it leaves the child primed as pi's default coding agent, told it
 * edits code and runs commands while holding four read-only tools.
 *
 * Every sentence states a fact about the run. Nothing names a subject, a task
 * type, or an output shape. The test for anything added here later: could it be
 * false for some question the oracle is asked? If so, it does not belong.
 */
export const ORACLE_SYSTEM_PROMPT = [
	"You are being consulted for a second opinion by another coding agent.",
	"You have no history of its conversation; everything you need is in the question.",
	"You can read files but cannot edit, write, or run commands.",
	"Answer the question directly.",
].join(" ");

/**
 * States the invocation policy rather than implying a specialty. "Not required"
 * is load-bearing: a promoted imperative naming a routine task is exactly what
 * pushed the previous persona onto the expensive path.
 */
const DESCRIPTION = [
	"Ask a second-opinion model a hard question.",
	"It runs on a deliberately different model from yours — slower and more expensive, better at reasoning — in its own context with read-only tools.",
	"Use it for hard debugging, reviewing a tricky change, or weighing an approach.",
	"Not for file reads, search, or edits; do those yourself.",
	"You are not required to use it: prefer it when the user asks, or when the question is genuinely hard.",
].join(" ");

const QUESTION_DESCRIPTION =
	"The oracle runs on a different model in a fresh context and sees nothing of this conversation. State the problem in full and name the files it should read.";

const NO_ROUTE_ERROR =
	"No oracle route for the active mode. Set `defaultRoutes.oracle` or `modes[].routes.oracle` in agent-modes.json.";

interface OracleParams {
	question: string;
	timeoutSeconds?: number;
}

interface OracleDetails {
	question: string;
	/** The model string dispatched to the child, after route resolution. */
	requestedModel?: string;
	run: AgentRunResult | null;
}

/**
 * No `cwd`: it was the only model-supplied input that changed the child's
 * *prompt*, by selecting which `AGENTS.md` got appended. Dropping it costs no
 * reach — `read` resolves relative paths against `cwd` but applies no
 * containment check, so a question naming an absolute path still works.
 *
 * No `context` and no `files` either: the oracle has read tools and the
 * question can name paths, and a `context` parameter in particular invites
 * dumping conversation history — the cost the separate context window exists to
 * avoid.
 */
const PARAMS = Type.Object({
	question: Type.String({ description: QUESTION_DESCRIPTION }),
	timeoutSeconds: Type.Optional(
		Type.Number({
			minimum: 1,
			description:
				"Optional hard ceiling on this question's wall clock, in seconds. Usually leave it off: an oracle that stops producing output is already terminated on its own. On expiry it is terminated and whatever it produced so far is returned.",
		}),
	),
});

export function createOracleTool(
	deps: { runAgent?: typeof spawnAgentRun } = {},
): ToolDefinition<typeof PARAMS, OracleDetails> {
	const runAgent = deps.runAgent ?? spawnAgentRun;
	return {
		name: ORACLE_TOOL_NAME,
		label: "Oracle",
		description: DESCRIPTION,
		// A one-line entry in the default prompt's "Available tools" section.
		// Deliberately not `promptGuidelines`: a Guidelines bullet is imperative,
		// which is the property that made the previous persona's promotion push
		// the oracle onto routine work. Descriptive in the tool contract,
		// imperative nowhere.
		promptSnippet: "oracle: ask a second-opinion model (different model, fresh context, read-only) a hard question",
		parameters: PARAMS,

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as OracleParams;

			// Read at call time, not at registration: a `/mode` switch between the
			// last availability sync and this call must be seen here.
			const model = resolveRoute(ORACLE_ROUTE_KEY);
			if (!model) {
				return {
					content: [{ type: "text", text: NO_ROUTE_ERROR }],
					details: { question: params.question, run: null },
					isError: true,
				};
			}

			const details: OracleDetails = {
				question: params.question,
				requestedModel: model,
				run: { exitCode: 0, messages: [], stderr: "", usage: emptyUsage() },
			};

			const run = await runAgent({
				model,
				tools: ORACLE_TOOLS,
				replaceSystemPrompt: ORACLE_SYSTEM_PROMPT,
				noSkills: true,
				promptName: ORACLE_TOOL_NAME,
				task: params.question,
				cwd: ctx.cwd,
				timeoutSeconds: params.timeoutSeconds,
				signal,
				onUpdate: (partial) => {
					details.run = partial;
					onUpdate?.({
						content: [{ type: "text", text: getFinalOutput(partial.messages) || "(thinking...)" }],
						details,
					} satisfies AgentToolResult<OracleDetails>);
				},
			});
			details.run = run;

			if (isFailedRun(run)) {
				return {
					content: [{ type: "text", text: `Oracle ${run.stopReason ?? "failed"}: ${describeRunFailure(run)}` }],
					details,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(run.messages) || "(no output)" }],
				details,
			};
		},

		renderCall(rawArgs, theme, _context) {
			const args = rawArgs as Partial<OracleParams>;
			const question = args.question ?? "...";
			const preview = question.length > 60 ? `${question.slice(0, 60)}...` : question;
			return new Text(`${theme.fg("toolTitle", theme.bold("oracle"))}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as OracleDetails | undefined;
			const run = details?.run;
			if (!run) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const failed = isFailedRun(run);
			const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(run.messages);
			const finalOutput = getFinalOutput(run.messages);
			// "route" and not "agent": nobody in this session named this model.
			const usageStr = formatUsageStats(run.usage, formatModelDisplay(details?.requestedModel, "route", run.resolvedModel));

			if (expanded) {
				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold("oracle"))}`;
				if (failed && run.stopReason) header += ` ${theme.fg("error", `[${run.stopReason}]`)}`;
				container.addChild(new Text(header, 0, 0));
				if (failed && run.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${run.errorMessage}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Question ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", details?.question ?? ""), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
				} else {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				}
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("oracle"))}`;
			if (failed && run.stopReason) text += ` ${theme.fg("error", `[${run.stopReason}]`)}`;
			if (failed && run.errorMessage) text += `\n${theme.fg("error", `Error: ${run.errorMessage}`)}`;
			else if (!finalOutput) text += `\n${theme.fg("muted", run.exitCode === 0 ? "(thinking...)" : "(no output)")}`;
			else {
				const preview = finalOutput.split("\n").slice(0, 3).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
		},
	};
}
