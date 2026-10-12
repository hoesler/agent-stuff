/**
 * amp-tool-display — self-authored, Amp-style rendering for Pi's built-in tools.
 *
 * Strategy:
 * a `pi.registerToolRenderer` resolver swaps in our `renderCall`/`renderResult`
 * for the built-in tool names and passes every other tool through. The tools
 * themselves stay untouched: whatever is registered under these names (pi's
 * own, or another extension's replacement) keeps its execution, schema, prompt
 * snippets and active state. Spreading `next()` keeps the rest of the resolved
 * renderers, so edit's `renderShell: "self"` survives.
 */
import type {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ExtensionAPI,
  ToolDefinition,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  renderFindCall,
  renderFindResult,
  renderGrepCall,
  renderGrepResult,
  renderLsCall,
  renderLsResult,
  renderReadCall,
  renderReadResult,
} from "./amp-tools-readonly.ts";
import { renderBashCall, renderBashResult } from "./amp-tools-bash.ts";
import {
  renderEditCall,
  renderEditResult,
  renderWriteCall,
  renderWriteResult,
} from "./amp-tools-edit.ts";

/**
 * The render hooks of a built-in tool, typed from its definition factory, so
 * each renderer is checked against that tool's real argument, detail and state
 * types.
 */
type RenderersOf<F extends (...args: never[]) => ToolDefinition<any, any, any>> = Pick<
  ReturnType<F>,
  "renderCall" | "renderResult"
>;

/**
 * Widen checked renderers to `ToolRenderers`, whose hooks take `unknown` args.
 * The resolver only hands them to calls of the tool they were checked against.
 */
function forTool<F extends (...args: never[]) => ToolDefinition<any, any, any>>(
  renderers: RenderersOf<F>,
): ToolRenderers {
  return renderers as ToolRenderers;
}

const AMP_RENDERERS: Readonly<Record<string, ToolRenderers>> = {
  read: forTool<typeof createReadToolDefinition>({
    renderCall: renderReadCall,
    renderResult: renderReadResult,
  }),
  grep: forTool<typeof createGrepToolDefinition>({
    renderCall: renderGrepCall,
    renderResult: renderGrepResult,
  }),
  find: forTool<typeof createFindToolDefinition>({
    renderCall: renderFindCall,
    renderResult: renderFindResult,
  }),
  ls: forTool<typeof createLsToolDefinition>({
    renderCall: renderLsCall,
    renderResult: renderLsResult,
  }),
  bash: forTool<typeof createBashToolDefinition>({
    renderCall: renderBashCall,
    renderResult: renderBashResult,
  }),
  edit: forTool<typeof createEditToolDefinition>({
    renderCall: renderEditCall,
    renderResult: renderEditResult,
  }),
  write: forTool<typeof createWriteToolDefinition>({
    renderCall: renderWriteCall,
    renderResult: renderWriteResult,
  }),
};

/** Resolve the renderers for `toolName`: ours for the built-ins, `next()` otherwise. */
export function resolveAmpToolRenderers(
  toolName: string,
  next: () => ToolRenderers | undefined,
): ToolRenderers | undefined {
  const amp = Object.hasOwn(AMP_RENDERERS, toolName) ? AMP_RENDERERS[toolName] : undefined;
  if (!amp) {
    return next();
  }
  return { ...next(), ...amp };
}

export default function (pi: ExtensionAPI): void {
  pi.registerToolRenderer(resolveAmpToolRenderers);
}
