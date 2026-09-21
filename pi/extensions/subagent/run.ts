/**
 * Spawns a child `pi` process and streams its JSON-mode output back.
 *
 * Deliberately persona-free: the caller resolves the model, picks the tools,
 * and supplies the prompt text. `subagent-tool.ts` wraps this with persona
 * lookup and the model precedence chain; `oracle-tool.ts` wraps it with a route
 * lookup and nothing else. One copy of the JSON parsing and the termination
 * ladder is the point — a divergence between two of them would be the least
 * visible kind.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveModelFromMessage } from "./model-display.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** What one child produced, independent of why it was spawned. */
export interface AgentRunResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	/** The model resolved from the child's assistant message (provider/model[.responseModel]). */
	resolvedModel?: string;
	stopReason?: string;
	errorMessage?: string;
}

/**
 * Spawns the child pi process. Injectable so the termination logic — timeout,
 * abort, and the partial result each produces — can be tested against a real
 * child process without a running pi.
 */
export type SpawnChild = (args: string[], cwd: string) => ChildProcess;

export interface AgentRunOptions {
	/** Already resolved; no route logic happens here. */
	model?: string;
	tools?: string[];
	/**
	 * Stacked onto pi's base prompt via `--append-system-prompt`. For personas,
	 * whose text adds a role to the coding-assistant framing rather than
	 * contradicting it. Omitted or blank → no flag.
	 */
	systemPrompt?: string;
	/**
	 * Replaces pi's base prompt via `--system-prompt`. "No prompt" is not
	 * neutral — it is pi's default coding agent, which tells the child it edits
	 * code and runs commands — so a read-only child needs the replacing flag.
	 * Mutually exclusive with `systemPrompt`.
	 */
	replaceSystemPrompt?: string;
	/** Suppresses the skills catalog. A one-shot consultation has no use for it. */
	noSkills?: boolean;
	/** Names the temp prompt file, for readability while a run is in flight. */
	promptName?: string;
	/** The prompt handed to the child, verbatim. */
	task: string;
	cwd: string;
	/**
	 * Hard ceiling on this run's wall clock. Absent means no ceiling — the idle
	 * deadline is what ordinarily stops a run that has stopped working.
	 */
	timeoutSeconds?: number;
	/**
	 * How long the child may emit nothing at all before it is terminated.
	 * Defaults to `IDLE_SECONDS`; overridden in tests, and deliberately not
	 * reachable from either tool's schema.
	 */
	idleSeconds?: number;
	signal?: AbortSignal;
	onUpdate?: (result: AgentRunResult) => void;
	/** Overridden in tests; defaults to spawning the real child pi. */
	spawnChild?: SpawnChild;
}

/**
 * How long a child may go completely silent before it is assumed stuck.
 *
 * Deliberately generous. The gaps it has to clear are not the typical pause
 * between events but the worst legitimate one: reasoning a provider does
 * server-side without streaming deltas, time to first token under load, and a
 * retry's backoff. Erring high costs a deadlock a slower death; erring low
 * kills work that was in progress, which is the failure this replaced.
 */
export const IDLE_SECONDS = 180;

/** Terminal states a run can end in: a non-zero exit, or a stop the child or we ourselves forced. */
const FAILED_STOP_REASONS = new Set(["error", "aborted", "timeout"]);

export function isFailedRun(run: AgentRunResult): boolean {
	return run.exitCode !== 0 || (run.stopReason !== undefined && FAILED_STOP_REASONS.has(run.stopReason));
}

/**
 * Why a run failed, in one line, or `""` when it left no account of itself.
 *
 * Two fields can carry it and both are optional in practice: a child that died
 * reports through `errorMessage`, while a run that failed *before* any child
 * existed — an unknown persona, a model that cannot be one — has only `stderr`.
 * Reading one field and not the other silently drops a whole class of failure,
 * which is exactly what the TUI used to do while the model was told the truth.
 * One function, so every surface fails the same way.
 */
export function runFailureReason(run: AgentRunResult): string {
	return run.errorMessage || run.stderr.trim() || "";
}

/** The sentinel `exitCode` a result carries while its child is still running. */
export const RUNNING_EXIT_CODE = -1;

/**
 * The reason to show for a run, or `""` when there is nothing to show — the
 * one rule every rendered surface uses, so none of them can go quiet about a
 * failure another one reports.
 *
 * The running sentinel is excluded because `isFailedRun` counts it as a
 * failure: it is not zero. A live parallel batch re-renders on every update,
 * so without that guard a task that merely wrote to stderr would be labelled
 * an error while it was still working.
 */
export function displayedFailureReason(run: AgentRunResult): string {
	if (run.exitCode === RUNNING_EXIT_CODE) return "";
	return isFailedRun(run) ? runFailureReason(run) : "";
}

/**
 * Why a run failed, plus whatever it produced first. A run killed part-way
 * usually has useful partial output, and for a timeout that partial output is
 * the only signal the caller has for choosing a larger budget next time.
 */
export function describeRunFailure(run: AgentRunResult): string {
	const reason = runFailureReason(run);
	const partial = getFinalOutput(run.messages).trim();
	if (reason && partial) return `${reason}\n\nPartial output before termination:\n${partial}`;
	return reason || partial || "(no output)";
}

/** A tool call in one line: its name, and its first non-empty string argument. */
function describeToolCall(call: { name: string; arguments?: Record<string, unknown> }): string {
	const arg = Object.values(call.arguments ?? {}).find((v) => typeof v === "string" && v.trim() !== "");
	if (typeof arg !== "string") return call.name;
	const oneLine = arg.replace(/\s+/g, " ").trim();
	return `${call.name}(${oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine})`;
}

/**
 * The tool calls the child had issued but not yet finished, described in one
 * line each.
 *
 * This is the whole account of *what* a killed run was doing. The call that
 * swallowed the budget is a `toolCall` part on the last assistant message, and
 * it never produced a `toolResult` — so `getFinalOutput`, which reads text
 * parts, reports the prose that preceded it ("now let me run the test suite")
 * and nothing about the `bash` call that hung. Without this the caller cannot
 * tell a deadlock from a task that merely needed longer, and retries the
 * deadlock with a bigger budget.
 */
export function inFlightToolCalls(messages: Message[]): string[] {
	const pending = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "toolCall") pending.set(part.id, describeToolCall(part));
			}
		} else if (msg.role === "toolResult") {
			pending.delete(msg.toolCallId);
		}
	}
	return [...pending.values()];
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

async function writePromptToTempFile(name: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

const spawnPi: SpawnChild = (args, cwd) => {
	const invocation = getPiInvocation(args);
	return spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
};

export async function spawnAgentRun(options: AgentRunOptions): Promise<AgentRunResult> {
	// A programming error, not a precedence question: the two flags contradict
	// each other, and picking one silently would hide which prompt was in flight.
	if (options.systemPrompt?.trim() && options.replaceSystemPrompt?.trim()) {
		throw new Error("spawnAgentRun: systemPrompt and replaceSystemPrompt are mutually exclusive");
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.noSkills) args.push("--no-skills");
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const result: AgentRunResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};

	const emitUpdate = () => options.onUpdate?.(result);

	try {
		const promptText = options.replaceSystemPrompt ?? options.systemPrompt;
		if (promptText?.trim()) {
			const tmp = await writePromptToTempFile(options.promptName ?? "agent", promptText);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			// `--system-prompt` and `--append-system-prompt` both accept a path or
			// literal text; a file keeps a multi-paragraph prompt out of argv.
			args.push(options.replaceSystemPrompt?.trim() ? "--system-prompt" : "--append-system-prompt", tmpPromptPath);
		}

		args.push(options.task);

		// Only positive, finite budgets bound the run; anything else means unbounded,
		// so a malformed value cannot silently kill a run on the spot.
		const timeoutMs =
			options.timeoutSeconds && Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0
				? options.timeoutSeconds * 1000
				: undefined;
		const idleSeconds = options.idleSeconds ?? IDLE_SECONDS;
		const idleMs = Number.isFinite(idleSeconds) && idleSeconds > 0 ? idleSeconds * 1000 : undefined;
		let termination: "aborted" | "timeout" | "idle" | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = (options.spawnChild ?? spawnPi)(args, options.cwd);
			let buffer = "";
			let lastActivity = Date.now();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// Liveness is every event the child emits, not the two this result
				// keeps. A high-effort turn streams nothing but `message_update`
				// thinking deltas for minutes; a clock blind to them would kill the
				// child precisely on the work it was delegated for.
				lastActivity = Date.now();

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!result.resolvedModel) result.resolvedModel = resolveModelFromMessage(msg);
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout?.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (data) => {
				result.stderr += data.toString();
			});

			let killTimer: NodeJS.Timeout | undefined;
			let budgetTimer: NodeJS.Timeout | undefined;
			let idleTimer: NodeJS.Timeout | undefined;

			const terminate = (reason: "aborted" | "timeout" | "idle") => {
				termination ??= reason;
				proc.kill("SIGTERM");
				killTimer ??= setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			const onAbort = () => terminate("aborted");

			// Every timer and listener is bound to this one child, so all of them are
			// released when it exits: a chain reusing one signal across steps would
			// otherwise leave a listener per completed step, and the SIGKILL fallback
			// would hold the event loop open for five seconds after a clean exit.
			const cleanup = () => {
				if (killTimer) clearTimeout(killTimer);
				if (budgetTimer) clearTimeout(budgetTimer);
				if (idleTimer) clearTimeout(idleTimer);
				options.signal?.removeEventListener("abort", onAbort);
			};

			proc.on("close", (code) => {
				cleanup();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				cleanup();
				resolve(1);
			});

			if (timeoutMs !== undefined) budgetTimer = setTimeout(() => terminate("timeout"), timeoutMs);

			// Re-arms for exactly the time left rather than polling: each firing
			// either finds the child still silent and kills it, or discovers it
			// spoke and waits out the remainder of its grace from that point.
			if (idleMs !== undefined) {
				const checkIdle = () => {
					const remaining = idleMs - (Date.now() - lastActivity);
					if (remaining <= 0) terminate("idle");
					else idleTimer = setTimeout(checkIdle, remaining);
				};
				idleTimer = setTimeout(checkIdle, idleMs);
			}

			if (options.signal) {
				if (options.signal.aborted) terminate("aborted");
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (termination) {
			// Return the partial run rather than throwing it away. Everything the child
			// produced before it was killed — output, tool calls, usage, cost — is
			// already on `result`, and for a chain or a parallel batch, throwing here
			// would discard its siblings' completed results too.
			// Both deadlines report as `timeout`: it is already in
			// `FAILED_STOP_REASONS` and every rendering surface reads it, and what
			// the caller needs in order to tell them apart is the message, not a
			// second reason code.
			result.stopReason = termination === "idle" ? "timeout" : termination;
			// Only a deadline writes its own reason here. An abort leaves whatever
			// the child last reported, which is the user's own doing and needs no
			// account from us.
			if (termination === "timeout" || termination === "idle") {
				result.errorMessage =
					termination === "timeout"
						? `Timed out after ${options.timeoutSeconds}s and was terminated.`
						: `Terminated after no output for ${idleSeconds}s.`;
				const inFlight = inFlightToolCalls(result.messages);
				if (inFlight.length > 0) result.errorMessage += ` In flight: ${inFlight.join(", ")}.`;
			}
			if (result.exitCode === 0) result.exitCode = 1;
		}
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
