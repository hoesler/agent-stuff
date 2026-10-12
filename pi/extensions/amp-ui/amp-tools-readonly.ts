/**
 * Renderers for the read-only built-in tools: read, grep, find, ls.
 *
 * Each tool exposes a `render<Tool>Call(args, theme, context)` and a
 * `render<Tool>Result(result, options, theme, context)`. Headers are built from
 * `args.path` (and tool-specific extras); results read output via
 * `extractTextOutput` and honour `options.expanded`, appending a muted
 * truncation hint when the tool's details report a limit/truncation.
 */
import type {
  AgentToolResult,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getConfig } from "./amp-tool-config.ts";
import {
  buildHeaderLine,
  collapseForPreview,
  extractTextOutput,
  formatReadRange,
  moreHint,
  shortenPath,
  splitLines,
  truncationHint,
  verbFor,
  type AmpToolRenderContext,
} from "./amp-tool-render.ts";

/**
 * Pre-rendered "ctrl+o to expand" hint, resolved from the live keybinding so it
 * follows any user rebinding. Only call inside a render hook (it reads host
 * globals that exist while the TUI is running), never at module load.
 */
function expandHint(): string {
  return keyHint("app.tools.expand", "to expand");
}

/**
 * Shared result body: header verb, the output preview honouring expansion, a
 * `… (N more lines, ctrl+o to expand)` hint when collapsed, and an optional
 * truncation hint.
 */
function buildResultText(
  verb: string,
  output: string,
  options: ToolRenderResultOptions,
  theme: Theme,
  truncation: string,
): string {
  const config = getConfig();
  const lines = splitLines(output);
  const { shown, remaining } = collapseForPreview(lines, options.expanded, config);

  const parts: string[] = [];
  if (shown.length > 0) {
    parts.push(theme.fg("toolOutput", shown.join("\n")));
  }
  const hint = moreHint(remaining, theme, { expandHint: expandHint() });
  if (hint) {
    parts.push(hint);
  }
  if (truncation) {
    parts.push(truncation);
  }
  if (parts.length === 0) {
    parts.push(theme.fg("muted", `${verb}: no output`));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function renderReadCall(
  args: ReadToolInput,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const path = shortenPath(args.path);
  const range = formatReadRange(args.offset, args.limit);
  const verbPart = buildHeaderLine(verbFor("read"), path, "", theme);
  const text = range ? `${verbPart}${theme.fg("warning", range)}` : verbPart;
  return new Text(text);
}

export function renderReadResult(
  result: AgentToolResult<ReadToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const truncation = truncationHint("read", result.details ?? undefined, theme);
  return new Text(buildResultText("read", extractTextOutput(result), options, theme, truncation));
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export function renderGrepCall(
  args: GrepToolInput,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const scope = shortenPath(args.path) || ".";
  let suffix = ` in ${scope}`;
  if (args.glob) {
    suffix += ` (${args.glob})`;
  }
  if (typeof args.limit === "number") {
    suffix += ` limit ${args.limit}`;
  }
  const text = buildHeaderLine(verbFor("grep"), `/${args.pattern}/`, suffix, theme);
  return new Text(text);
}

export function renderGrepResult(
  result: AgentToolResult<GrepToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const truncation = truncationHint("grep", result.details ?? undefined, theme);
  return new Text(buildResultText("grep", extractTextOutput(result), options, theme, truncation));
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

export function renderFindCall(
  args: FindToolInput,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const scope = shortenPath(args.path) || ".";
  let suffix = ` in ${scope}`;
  if (typeof args.limit === "number") {
    suffix += ` (limit ${args.limit})`;
  }
  const text = buildHeaderLine(verbFor("find"), args.pattern, suffix, theme);
  return new Text(text);
}

export function renderFindResult(
  result: AgentToolResult<FindToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const truncation = truncationHint("find", result.details ?? undefined, theme);
  return new Text(buildResultText("find", extractTextOutput(result), options, theme, truncation));
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export function renderLsCall(
  args: LsToolInput,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const scope = shortenPath(args.path) || ".";
  let suffix = "";
  if (typeof args.limit === "number") {
    suffix = ` (limit ${args.limit})`;
  }
  const text = buildHeaderLine(verbFor("ls"), scope, suffix, theme);
  return new Text(text);
}

export function renderLsResult(
  result: AgentToolResult<LsToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: AmpToolRenderContext,
): Component {
  const truncation = truncationHint("ls", result.details ?? undefined, theme);
  return new Text(buildResultText("ls", extractTextOutput(result), options, theme, truncation));
}
