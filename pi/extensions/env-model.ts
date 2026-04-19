/**
 * env-model extension
 *
 * Sets the provider, model, thinking level, and initial scoped model from
 * environment variables, as an alternative to passing CLI flags.
 *
 * Supported env vars:
 *   PI_PROVIDER   Provider name, e.g. "anthropic"
 *   PI_MODEL      Model ID, optionally prefixed with provider ("anthropic/claude-sonnet-4-5")
 *                 and optionally suffixed with a thinking level ("sonnet:high")
 *   PI_THINKING   Thinking level: off | minimal | low | medium | high | xhigh
 *   PI_MODELS     Comma-separated model patterns for --models (e.g. "claude-*,gpt-4o").
 *                 Sets the initial active model to the first match when PI_MODEL is not set.
 *                 NOTE: Ctrl+P cycling scope cannot be configured from an extension
 *                 (setScopedModels is not exposed in the ExtensionAPI), so only the
 *                 first matching model is applied as the active model.
 *
 * Examples:
 *   PI_MODEL=anthropic/claude-sonnet-4-5 pi
 *   PI_PROVIDER=anthropic PI_MODEL=claude-sonnet-4-5 pi
 *   PI_MODEL=claude-sonnet-4-5:high pi
 *   PI_THINKING=high pi
 *   PI_MODELS="claude-*,gpt-4o" pi
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Model, Api } from "@mariozechner/pi-ai";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Simple wildcard matcher supporting * and ? against a string. */
function matchesGlob(pattern: string, value: string): boolean {
	const regex = new RegExp(
		"^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
		"i",
	);
	return regex.test(value);
}

/** Find the first model matching a pattern (glob or exact, with optional provider/ prefix). */
function findFirstMatch(pattern: string, models: Model<Api>[]): Model<Api> | undefined {
	for (const m of models) {
		const fullId = `${m.provider}/${m.id}`;
		if (matchesGlob(pattern, fullId) || matchesGlob(pattern, m.id)) return m;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		let providerEnv = process.env.PI_PROVIDER?.trim();
		let modelEnv = process.env.PI_MODEL?.trim();
		const thinkingEnv = process.env.PI_THINKING?.trim();

		if (!modelEnv && !providerEnv && !thinkingEnv && !process.env.PI_MODELS?.trim()) return;

		// Parse thinking level suffix from model, e.g. "sonnet:high"
		let thinkingLevel: ThinkingLevel | undefined;
		if (modelEnv?.includes(":")) {
			const colonIdx = modelEnv.lastIndexOf(":");
			const maybeLevl = modelEnv.slice(colonIdx + 1);
			if (THINKING_LEVELS.has(maybeLevl)) {
				thinkingLevel = maybeLevl as ThinkingLevel;
				modelEnv = modelEnv.slice(0, colonIdx);
			}
		}

		// PI_THINKING overrides the :suffix if both are set
		if (thinkingEnv && THINKING_LEVELS.has(thinkingEnv)) {
			thinkingLevel = thinkingEnv as ThinkingLevel;
		}

		// Parse provider prefix from model, e.g. "anthropic/claude-sonnet-4-5"
		if (modelEnv?.includes("/")) {
			const slashIdx = modelEnv.indexOf("/");
			if (!providerEnv) providerEnv = modelEnv.slice(0, slashIdx);
			modelEnv = modelEnv.slice(slashIdx + 1);
		}

		// Resolve PI_MODELS — find first matching model to use as the active model
		// when PI_MODEL is not explicitly set (mirrors --models behavior).
		const modelsEnv = process.env.PI_MODELS?.trim();
		if (modelsEnv && !modelEnv) {
			const patterns = modelsEnv.split(",").map((p) => p.trim()).filter(Boolean);
			const available = ctx.modelRegistry.getAvailable();
			let matched: Model<Api> | undefined;
			for (const pattern of patterns) {
				matched = findFirstMatch(pattern, available);
				if (matched) break;
			}
			if (matched) {
				const ok = await pi.setModel(matched);
				if (!ok) {
					ctx.ui.notify(`env-model: No API key for PI_MODELS first match (${matched.provider}/${matched.id})`, "warning");
				}
			} else {
				ctx.ui.notify(`env-model: No models matched PI_MODELS patterns: ${modelsEnv}`, "warning");
			}
		}

		// Apply model
		if (modelEnv && providerEnv) {
			const model = ctx.modelRegistry.find(providerEnv, modelEnv);
			if (model) {
				const ok = await pi.setModel(model);
				if (!ok) {
					ctx.ui.notify(`env-model: No API key for ${providerEnv}/${modelEnv}`, "warning");
				}
			} else {
				ctx.ui.notify(`env-model: Model not found — ${providerEnv}/${modelEnv}`, "warning");
			}
		} else if (modelEnv || providerEnv) {
			ctx.ui.notify(
				`env-model: Set both PI_PROVIDER and PI_MODEL (or use PI_MODEL=provider/model format)`,
				"warning",
			);
		}

		// Apply thinking level
		if (thinkingLevel) {
			pi.setThinkingLevel(thinkingLevel);
		}
	});
}
