/**
 * Pure helpers for tracking and displaying the model actually used by a
 * subagent, as opposed to the (possibly alias-like) requested model.
 */

/**
 * How the requested model was selected:
 *  - "agent"       the *calling* agent explicitly set it, either per-task/
 *                   per-step or as a whole-call override
 *  - "frontmatter" the subagent persona's own `model:` frontmatter field
 *  - "pi-default"  no explicit model anywhere; the child Pi process chose
 *                   its own default
 */
export type ModelSource = "agent" | "frontmatter" | "pi-default";

export interface ModelSelection {
  /** The requested model string, if any explicit selection was made. */
  model?: string;
  source: ModelSource;
}

/**
 * Resolve which requested model (and its source) applies, following the
 * documented precedence: per-task/per-step override > whole-call override >
 * agent persona frontmatter > child Pi default. Both override forms are
 * attributed to the calling agent ("agent"), since it is the caller that
 * explicitly picked the model in either case.
 */
export function resolveModelSelection(
  taskModel: string | undefined,
  globalModel: string | undefined,
  agentModel: string | undefined,
): ModelSelection {
  if (taskModel) return { model: taskModel, source: "agent" };
  if (globalModel) return { model: globalModel, source: "agent" };
  if (agentModel) return { model: agentModel, source: "frontmatter" };
  return { model: undefined, source: "pi-default" };
}

/**
 * Thinking levels Pi accepts as a `<model>:<level>` suffix, mirroring
 * `VALID_THINKING_LEVELS` in Pi's own argument parser.
 */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Split a requested model into its model part and an optional thinking level.
 *
 * Mirrors Pi's parsing: only the segment after the *last* colon is considered,
 * and only when it names a valid thinking level. Model ids legitimately contain
 * colons (`openai/gpt-4o:extended`, `llama3.1:8b`), so any other suffix stays
 * part of the model id.
 */
export function splitThinkingLevel(
  requestedModel: string | undefined,
): { model: string | undefined; thinkingLevel: string | undefined } {
  if (!requestedModel) return { model: requestedModel, thinkingLevel: undefined };
  const lastColon = requestedModel.lastIndexOf(":");
  if (lastColon === -1) return { model: requestedModel, thinkingLevel: undefined };
  const suffix = requestedModel.slice(lastColon + 1);
  if (!THINKING_LEVELS.has(suffix)) return { model: requestedModel, thinkingLevel: undefined };
  return { model: requestedModel.slice(0, lastColon), thinkingLevel: suffix };
}

export interface AssistantModelInfo {
  provider?: string;
  model?: string;
  responseModel?: string;
}

/**
 * Compute the resolved model string from a child assistant message.
 * Prefers `provider/responseModel` (the provider-reported response model)
 * over `provider/model` (the model that was requested of the provider).
 */
export function resolveModelFromMessage(msg: AssistantModelInfo): string | undefined {
  if (!msg.provider) return undefined;
  if (msg.responseModel) return `${msg.provider}/${msg.responseModel}`;
  if (msg.model) return `${msg.provider}/${msg.model}`;
  return undefined;
}

/**
 * Format the model portion of a usage line.
 *
 * If a resolved model (from a child assistant message) is available, it is
 * shown verbatim. Otherwise, the originally requested model is shown as a
 * fallback if one was explicitly supplied. If neither is available, an
 * "unresolved" marker is shown instead of presenting nothing (or an alias)
 * as though it were the actual model.
 *
 * A thinking level requested as a `:<level>` suffix is re-attached to the
 * resolved model. The child's assistant messages carry only provider and
 * model, never the thinking level, so it cannot be recovered from the message
 * and would otherwise disappear the moment the model resolves.
 */
export function formatModelDisplay(
  requestedModel: string | undefined,
  source: ModelSource,
  resolvedModel: string | undefined,
): string {
  const label = `[${source}]`;
  if (resolvedModel) {
    const { thinkingLevel } = splitThinkingLevel(requestedModel);
    const effort = thinkingLevel ? `:${thinkingLevel}` : "";
    return `${resolvedModel}${effort} ${label}`;
  }
  if (requestedModel) return `${requestedModel} ${label}`;
  return `(unresolved) ${label}`;
}

