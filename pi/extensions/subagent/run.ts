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
	/** Omitted or blank → no `--append-system-prompt`. */
	systemPrompt?: string;
	/** Names the temp prompt file, for readability while a run is in flight. */
	promptName?: string;
	/** The prompt handed to the child, verbatim. */
	task: string;
	cwd: string;
	/** Wall-clock budget for this run. Absent means the run is unbounded. */
	timeoutSeconds?: number;
	signal?: AbortSignal;
	onUpdate?: (result: AgentRunResult) => void;
	/** Overridden in tests; defaults to spawning the real child pi. */
	spawnChild?: SpawnChild;
}

/** Terminal states a run can end in: a non-zero exit, or a stop the child or we ourselves forced. */
const FAILED_STOP_REASONS = new Set(["error", "aborted", "timeout"]);

export function isFailedRun(run: AgentRunResult): boolean {
	return run.exitCode !== 0 || (run.stopReason !== undefined && FAILED_STOP_REASONS.has(run.stopReason));
}

/**
 * Why a run failed, plus whatever it produced first. A run killed part-way
 * usually has useful partial output, and for a timeout that partial output is
 * the only signal the caller has for choosing a larger budget next time.
 */
export function describeRunFailure(run: AgentRunResult): string {
	const reason = run.errorMessage || run.stderr.trim() || "";
	const partial = getFinalOutput(run.messages).trim();
	if (reason && partial) return `${reason}\n\nPartial output before termination:\n${partial}`;
	return reason || partial || "(no output)";
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
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
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
		if (options.systemPrompt?.trim()) {
			const tmp = await writePromptToTempFile(options.promptName ?? "agent", options.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(options.task);

		// Only positive, finite budgets bound the run; anything else means unbounded,
		// so a malformed value cannot silently kill a run on the spot.
		const timeoutMs =
			options.timeoutSeconds && Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0
				? options.timeoutSeconds * 1000
				: undefined;
		let termination: "aborted" | "timeout" | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = (options.spawnChild ?? spawnPi)(args, options.cwd);
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

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

			const terminate = (reason: "aborted" | "timeout") => {
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
			result.stopReason = termination;
			if (termination === "timeout") {
				result.errorMessage = `Timed out after ${options.timeoutSeconds}s and was terminated.`;
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
