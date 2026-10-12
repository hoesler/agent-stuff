/**
 * Renderers for the built-in `edit` and `write` tools.
 *
 * - `edit` (createEditToolDefinition): renderCall `edit <path>`. renderResult
 *   prefers the tool's display diff (`details.diff`, colored via `renderDiff`)
 *   and falls back to the raw text output. `renderDiff` ignores its options arg
 *   (brief R2), so the caller collapses the colored string line-wise here.
 *   The inherited `renderShell: "self"` is preserved by the override helper —
 *   we never touch it (brief R3).
 * - `write` (createWriteToolDefinition): no diff source exists (details is
 *   `undefined`, brief R1 — no LCS, no jsdiff). renderCall `write <path>`.
 *   renderResult shows a `wrote <path> (<N> lines)` header plus a content
 *   preview taken from `args.content` (falling back to the text output).
 *
 * The string-building is factored into pure `build*ResultText` helpers so the
 * collapse math and line-count semantics are unit-testable without rendering a
 * `Text` component or depending on `renderDiff`'s ANSI output.
 */
import type {
  AgentToolResult,
  EditToolDetails,
  EditToolInput,
  Theme,
  ToolRenderResultOptions,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { keyHint, renderDiff } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getConfig } from "./amp-tool-config.ts";
import {
  buildHeaderLine,
  collapseForPreview,
  countLines,
  extractTextOutput,
  moreHint,
  type RenderTheme,
  shortenPath,
  splitLines,
  verbFor,
  type AmpToolRenderContext,
} from "./amp-tool-render.ts";

/**
 * Pre-rendered "ctrl+o to expand" hint, resolved from the live keybinding.
 * Only call inside a render hook (it reads host globals available while the TUI
 * runs), never at module load.
 */
function expandHint(): string {
  return keyHint("app.tools.expand", "to expand");
}

/** Append a `… (N more line(s)[, …])` hint to `parts` when lines were hidden. */
function pushMoreHint(
  parts: string[],
  remaining: number,
  theme: RenderTheme,
  opts: { total?: number; expandHint?: string } = {},
): void {
  const hint = moreHint(remaining, theme, opts);
  if (hint) {
    parts.push(hint);
  }
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export function renderEditCall(
  args: EditToolInput,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const path = shortenPath(args.path);
  const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
  const suffix = editCount > 1 ? ` (${editCount} edits)` : "";
  return new Text(buildHeaderLine(verbFor("edit"), path, suffix, theme));
}

/**
 * Build the edit result body from an already-colored string (a `renderDiff`
 * diff when `hasDiff`, else plain text output). Collapses line-wise to the
 * preview limit (or the expanded limit) and appends a `… (N more)` hint.
 */
export function buildEditResultText(
  colored: string,
  hasDiff: boolean,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  hint = "",
): string {
  const config = getConfig();
  const lines = colored.split("\n");
  const { shown, remaining } = collapseForPreview(lines, options.expanded, config);

  const parts: string[] = [];
  if (shown.length > 0 && shown.some((line) => line.length > 0)) {
    // A diff already carries its own ANSI colors; don't re-wrap it. Plain text
    // output (the fallback) is shown via the tool-output color.
    parts.push(hasDiff ? shown.join("\n") : theme.fg("toolOutput", shown.join("\n")));
  } else {
    parts.push(theme.fg("muted", "edit: no changes"));
  }
  pushMoreHint(parts, remaining, theme, { expandHint: hint });
  return parts.join("\n");
}

export function renderEditResult(
  result: AgentToolResult<EditToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const hasDiff = typeof result.details?.diff === "string" && result.details.diff.length > 0;
  // Prefer the tool's display diff; `renderDiff` returns a colored ANSI string
  // and IGNORES its options arg, so we collapse it caller-side (brief R2).
  const colored = hasDiff ? renderDiff(result.details!.diff) : extractTextOutput(result);
  return new Text(buildEditResultText(colored, hasDiff, options, theme, expandHint()));
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export function renderWriteCall(
  args: WriteToolInput,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  return new Text(buildHeaderLine(verbFor("write"), shortenPath(args.path), "", theme));
}

/** Narrow the structurally-typed render context args to write tool inputs. */
function writeArgs(args: unknown): Partial<WriteToolInput> {
  if (args && typeof args === "object") {
    return args as Partial<WriteToolInput>;
  }
  return {};
}

/**
 * Build the write result body: a `wrote <path> (<N> lines)` header plus a
 * collapsed content preview. `content` is the text that was written (no diff —
 * brief R1).
 */
export function buildWriteResultText(
  path: string,
  content: string,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  hint = "",
): string {
  const config = getConfig();
  const lineCount = countLines(content);
  const header = buildHeaderLine(
    "wrote",
    shortenPath(path),
    ` (${lineCount} line${lineCount === 1 ? "" : "s"})`,
    theme,
  );

  const lines = splitLines(content);
  const { shown, remaining } = collapseForPreview(lines, options.expanded, config);

  const parts: string[] = [header];
  if (shown.length > 0) {
    parts.push(theme.fg("toolOutput", shown.join("\n")));
  }
  // Mirror Pi's write hint, which also reports the file's total line count.
  pushMoreHint(parts, remaining, theme, { total: lines.length, expandHint: hint });
  return parts.join("\n");
}

export function renderWriteResult(
  result: AgentToolResult<undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AmpToolRenderContext,
): Component {
  const args = writeArgs(context.args);
  // No diff for write (brief R1); preview the content we were asked to write,
  // falling back to the tool's textual output if the args aren't available.
  const content =
    typeof args.content === "string" && args.content.length > 0
      ? args.content
      : extractTextOutput(result);
  return new Text(buildWriteResultText(args.path ?? "", content, options, theme, expandHint()));
}
