/**
 * The `subagent` tool — delegate a task to a persona running in its own `pi`
 * process and context window.
 *
 * Three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentToolResult, getMarkdownTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type TSchema, Type } from "typebox";
import { type AgentConfig, type AgentDiscoveryResult, type AgentSource, suggestAgentName } from "./agents.ts";
import { buildAgentNameSchema, buildToolDescription, formatAgentNames } from "./catalog.ts";
import { type DisplayItem, formatToolCall, formatUsageStats, getDisplayItems } from "./display.ts";
import {
	formatModelDisplay,
	isBareThinkingLevel,
	type ModelSource,
	resolveModelSelection,
	splitThinkingLevel,
} from "./model-display.ts";
import { resolveModelReference } from "./routes.ts";
import {
	type AgentRunResult,
	describeRunFailure,
	displayedFailureReason,
	emptyUsage,
	getFinalOutput,
	isFailedRun,
	type SpawnChild,
	spawnAgentRun,
} from "./run.ts";

/** The name the tool registers under, and the name the active list carries. */
export const SUBAGENT_TOOL_NAME = "subagent";

/**
 * Persona files this package ships as starting points. They are examples to
 * copy into `~/.pi/agent/agents`, never a live source of personas: keeping them
 * inert means there is nothing to disable and nothing to shadow, and deleting
 * or editing a copied file is the whole of deactivating or overriding it.
 */
const EXAMPLE_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "examples", "agents");

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

const isFailedResult = isFailedRun;
const describeFailure = describeRunFailure;

/**
 * What to say when a caller passed a thinking level where a model belongs.
 *
 * The fix is spelled out as a value that can be pasted straight back. When the
 * persona names a real model reference, that is the value — the caller wanted
 * "this agent, thinking harder", and this is the exact string that says so.
 * Anything else (a route key, another bare level) would stop resolving once a
 * suffix were appended to it, so those fall back to naming the shape.
 */
function describeBareThinkingLevel(level: string, agentName: string, agentModel: string | undefined): string {
	const base = agentModel?.includes("/") ? splitThinkingLevel(agentModel).model : undefined;
	const example = base ? `"${base}:${level}"` : `"provider/model:${level}" (e.g. "anthropic/claude-sonnet-5:${level}")`;
	// A level reaching here from frontmatter is a broken persona file, not a bad
	// call, so "omit it" would send the caller to fix the wrong thing.
	const remedy =
		agentModel === level
			? `The "${agentName}" persona's own \`model:\` frontmatter holds it and needs fixing.`
			: "Or omit `model` to use the agent's own model.";
	return `Invalid model "${level}": that is a thinking level, not a model. Append it to a model reference instead — e.g. ${example}. ${remedy}`;
}

export type { SpawnChild } from "./run.ts";

interface SingleResult extends AgentRunResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	/** The model string dispatched to the child, after route resolution. */
	requestedModel?: string;
	/** How the requested model was selected. */
	modelSource: ModelSource;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	projectAgentsDir: string | null;
	results: SingleResult[];
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface RunAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	/** 1-based position within a chain; absent for single and parallel runs. */
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	taskModel?: string;
	globalModel?: string;
	/** Wall-clock budget for this run. Absent means the run is unbounded. */
	timeoutSeconds?: number;
	/** Overridden in tests; defaults to spawning the real child pi. */
	spawnChild?: SpawnChild;
}

export async function runSingleAgent(options: RunAgentOptions): Promise<SingleResult> {
	const { defaultCwd, agents, agentName, task, step, signal, onUpdate, makeDetails, taskModel, globalModel } = options;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const suggestion = suggestAgentName(agentName, agents);
		const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
		const selection = resolveModelSelection(taskModel, globalModel, undefined);
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}".${didYouMean} Available agents: ${formatAgentNames(agents)}.`,
			usage: emptyUsage(),
			requestedModel: selection.model,
			modelSource: selection.source,
			step,
		};
	}

	const selection = resolveModelSelection(taskModel, globalModel, agent.model);
	// Route resolution is not a level in the precedence chain: it is applied once
	// to whichever value won it, so a bare route key works wherever a
	// provider/model string does. An unresolved key passes through unchanged and
	// the child errors on it, exactly as it did before routes existed.
	const dispatchModel = resolveModelReference(selection.model);

	// After route resolution, not before: a route may legitimately be keyed
	// "high", and it resolves to a full reference that is no longer bare.
	if (isBareThinkingLevel(dispatchModel)) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: describeBareThinkingLevel(dispatchModel!, agentName, agent.model),
			usage: emptyUsage(),
			requestedModel: dispatchModel,
			modelSource: selection.source,
			step,
		};
	}

	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		// The dispatched string, not the raw request: the usage line re-attaches a
		// `:thinkingLevel` suffix from this field, and a bare route key carries none.
		// `modelSource` still names who picked the value, so [agent] and
		// [frontmatter] stay truthful.
		requestedModel: dispatchModel,
		modelSource: selection.source,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
				details: makeDetails([result]),
			});
		}
	};

	const run = await spawnAgentRun({
		model: dispatchModel,
		tools: agent.tools,
		systemPrompt: agent.systemPrompt,
		promptName: agent.name,
		// The `Task: ` framing belongs to persona delegation, not to every child.
		task: `Task: ${task}`,
		cwd: options.cwd ?? defaultCwd,
		timeoutSeconds: options.timeoutSeconds,
		signal,
		onUpdate: (partial) => {
			Object.assign(result, partial);
			emitUpdate();
		},
		spawnChild: options.spawnChild,
	});
	Object.assign(result, run);
	return result;
}

/**
 * The `agent` field's schema is rebuilt whenever the catalog changes, so the
 * shapes below are built per registration rather than defined once at module
 * scope.
 */
function buildSubagentParams(agents: AgentConfig[]): TSchema {
	const agentName = buildAgentNameSchema(agents, EXAMPLE_AGENTS_DIR);

	/**
	 * The grammar, stated wherever a model can be passed. Naming the wrong shape
	 * outright is the point: without it, a caller reaching for "think harder"
	 * writes the thinking level alone, which is not a model and cannot be one.
	 */
	const modelForm = [
		'Either "provider/model" with an optional ":thinkingLevel" suffix (e.g. "anthropic/claude-sonnet-5:high"),',
		"or a bare route key.",
		'A bare thinking level ("low", "medium", "high", ...) is NOT a model — attach it to a model reference as a suffix instead.',
		"Omit to use the agent's own model.",
	].join(" ");

	const TaskItem = Type.Object({
		agent: agentName,
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		model: Type.Optional(
			Type.String({
				description: `Model override for this task (takes precedence over global model and agent frontmatter). ${modelForm}`,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				minimum: 1,
				description:
					"Wall-clock budget for this task, in seconds. Size it to the work you are delegating; omit it to let the task run unbounded. On expiry the subagent is terminated and whatever it produced so far is returned.",
			}),
		),
	});

	const ChainItem = Type.Object({
		agent: agentName,
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		model: Type.Optional(
			Type.String({
				description: `Model override for this step (takes precedence over global model and agent frontmatter). ${modelForm}`,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				minimum: 1,
				description:
					"Wall-clock budget for this step, in seconds. Size it to the work you are delegating; omit it to let the step run unbounded. On expiry the subagent is terminated, whatever it produced so far is returned, and the chain stops.",
			}),
		),
	});

	return Type.Object({
		agent: Type.Optional(agentName),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
		chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
		model: Type.Optional(
			Type.String({
				description: `Global model override for all tasks in this call. Per-task model takes precedence; both override agent frontmatter. ${modelForm}`,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				minimum: 1,
				description:
					"Wall-clock budget applied to every task in this call, in seconds. A per-task or per-step timeoutSeconds takes precedence. Omit to leave runs unbounded — there is no default, since only you know how long the delegated work should take.",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	});
}

/**
 * Runtime view of the parameters. The schema is built dynamically, so `Static`
 * cannot describe it; `execute` and the renderers cast to this instead.
 */
interface SubagentCallItem {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	timeoutSeconds?: number;
}

interface SubagentCallParams {
	agent?: string;
	task?: string;
	tasks?: SubagentCallItem[];
	chain?: SubagentCallItem[];
	model?: string;
	cwd?: string;
	timeoutSeconds?: number;
}

/** Identity of a catalog, for deciding whether a re-registration is worthwhile. */
function catalogFingerprint(result: AgentDiscoveryResult): string {
	return result.agents.map((a) => `${a.source}:${a.name}:${a.description}`).join("|");
}

/**
 * Build the tool definition for one catalog snapshot. Re-invoked whenever
 * discovery changes: `registerTool` is keyed by tool name, so re-registering
 * replaces the definition and refreshes the live tool list.
 *
 * `deps.spawnChild` is the same seam `run.ts` documents and `runSingleAgent`
 * already takes, lifted to the factory so the orchestration around them — mode
 * selection, the trust gate, `{previous}` substitution, timeout precedence —
 * can be exercised without a running pi. Production passes nothing.
 */
export function createSubagentTool(
	discovery: AgentDiscoveryResult,
	deps: { spawnChild?: SpawnChild } = {},
): ToolDefinition<TSchema, SubagentDetails> {
	const agents = discovery.agents;

	return {
		name: SUBAGENT_TOOL_NAME,
		label: "Subagent",
		description: buildToolDescription(agents, EXAMPLE_AGENTS_DIR),
		parameters: buildSubagentParams(agents),

		async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
			const params = rawParams as SubagentCallParams;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${formatAgentNames(agents)}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// Project personas are repo-controlled, so each run is confirmed separately
			// from pi's folder-level trust. Deliberately not a tool parameter: the
			// caller must not be able to waive its own gate.
			if (ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// Replacer function, not a string: a `$&` or `$1` in the prior
					// step's output would otherwise be read as a replacement pattern.
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: step.agent,
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
						taskModel: step.model,
						globalModel: params.model,
						timeoutSeconds: step.timeoutSeconds ?? params.timeoutSeconds,
						spawnChild: deps.spawnChild,
					});
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${describeFailure(result)}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					const selection = resolveModelSelection(params.tasks[i].model, params.model, undefined);
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						requestedModel: selection.model,
						modelSource: selection.source,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: t.agent,
						task: t.task,
						cwd: t.cwd,
						signal,
						// Per-task update callback
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
						taskModel: t.model,
						globalModel: params.model,
						timeoutSeconds: t.timeoutSeconds ?? params.timeoutSeconds,
						spawnChild: deps.spawnChild,
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					if (isFailedResult(r)) {
						// Surface the failure reason itself: an unknown-agent error carries
						// the available-agent list the caller needs in order to retry.
						return `[${r.agent}] ${r.stopReason ?? "failed"}: ${describeFailure(r)}`;
					}
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] completed: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount === 0,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents,
					agentName: params.agent,
					task: params.task,
					cwd: params.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					globalModel: params.model,
					timeoutSeconds: params.timeoutSeconds,
					spawnChild: deps.spawnChild,
				});
				const isError = isFailedResult(result);
				if (isError) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason ?? "failed"}: ${describeFailure(result)}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}` }],
				details: makeDetails("single")([]),
				isError: true,
			};
		},

		renderCall(rawArgs, theme, _context) {
			const args = rawArgs as SubagentCallParams;
			// Badge the persona's origin so a repo-controlled agent is visible at a glance.
			const sourceBadge = (name: string | undefined) => {
				const source = agents.find((a) => a.name === name)?.source;
				return source ? theme.fg("muted", ` [${source}]`) : "";
			};
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						sourceBadge(step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${sourceBadge(t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				sourceBadge(args.agent);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const failureText = displayedFailureReason;

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				// The same reason the calling agent is handed, so the two surfaces
				// cannot disagree about why a run failed. A pre-dispatch failure has
				// no `errorMessage` and no messages, and reading only the former
				// rendered it as "(no output)" while the model got the explanation.
				const failureReason = failureText(r);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (failureReason)
						container.addChild(new Text(theme.fg("error", `Error: ${failureReason}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, formatModelDisplay(r.requestedModel, r.modelSource, r.resolvedModel));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (failureReason) text += `\n${theme.fg("error", `Error: ${failureReason}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, formatModelDisplay(r.requestedModel, r.modelSource, r.resolvedModel));
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const stepFailure = failureText(r);
						if (stepFailure) container.addChild(new Text(theme.fg("error", `Error: ${stepFailure}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, formatModelDisplay(r.requestedModel, r.modelSource, r.resolvedModel));
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const stepFailure = failureText(r);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (stepFailure) text += `\n${theme.fg("error", `Error: ${stepFailure}`)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const taskFailure = failureText(r);
						if (taskFailure) container.addChild(new Text(theme.fg("error", `Error: ${taskFailure}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, formatModelDisplay(r.requestedModel, r.modelSource, r.resolvedModel));
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const taskFailure = failureText(r);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (taskFailure) text += `\n${theme.fg("error", `Error: ${taskFailure}`)}`;
					else if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	};
}
