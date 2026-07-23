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
 */
export function formatModelDisplay(
  requestedModel: string | undefined,
  source: ModelSource,
  resolvedModel: string | undefined,
): string {
  const label = `[${source}]`;
  if (resolvedModel) return `${resolvedModel} ${label}`;
  if (requestedModel) return `${requestedModel} ${label}`;
  return `(unresolved) ${label}`;
}

