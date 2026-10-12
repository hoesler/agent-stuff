/**
 * Renderers for the built-in `bash` tool.
 *
 * - `renderBashCall`: a braille spinner + `$ <command>` header with optional
 *   `(timeout Ns)` and live `· <elapsed>` while the command is running. The
 *   spinner timer lives on `context.state` and is driven by `context.invalidate`.
 *   Once the command finished, the elapsed time gives way to the recorded
 *   `context.durationMs` (pi 1.1.0+), so it survives a session reload.
 * - `renderBashResult`: a status icon (✓/✗ from `context.isError`), the command
 *   output preview read from `result.content` (NOT details, per C2), and an
 *   optional warning-colored `[Full output: …. Truncated: …]` hint built from
 *   `details.fullOutputPath`/`details.truncation` (mirrors Pi's bash renderer).
 */
import type {
  AgentToolResult,
  BashToolDetails,
  BashToolInput,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { getConfig } from "./amp-tool-config.ts";
import {
  BASH_SPINNER_FRAMES,
  BASH_SPINNER_INTERVAL_MS,
  bashTruncationHint,
  collapseForPreview,
  extractTextOutput,
  formatElapsed,
  getOrCreateSpinnerState,
  moreHint,
  splitLines,
  statusColor,
  statusIcon,
  stopSpinner,
  type AmpToolRenderContext,
  type RenderTheme,
} from "./amp-tool-render.ts";

/** Lines of output shown in the collapsed bash result preview. */
const BASH_PREVIEW_LINES = 10;

/** Commands that finish faster than this show no duration. */
const MIN_SHOWN_DURATION_MS = 1000;

/**
 * Build the `$ <command>` header line, optionally prefixed by a spinner frame.
 * `elapsedMs` is the live time while the spinner runs, then the recorded
 * duration once the command finished.
 */
export function buildBashCallText(
  args: BashToolInput,
  theme: RenderTheme,
  spinnerFrame: string | undefined,
  elapsedMs: number | undefined,
): string {
  const command =
    typeof args.command === "string" && args.command.trim().length > 0
      ? args.command
      : "...";
  const spinnerPrefix = spinnerFrame ? theme.fg("warning", `${spinnerFrame} `) : "";
  const timeoutSuffix =
    typeof args.timeout === "number" ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
  const elapsedSuffix =
    elapsedMs !== undefined ? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`) : "";
  const prompt = theme.fg("toolTitle", theme.bold("$"));
  return `${spinnerPrefix}${prompt} ${theme.fg("accent", command)}${timeoutSuffix}${elapsedSuffix}`;
}

/** The recorded duration of a finished command, or undefined when too short to show. */
function shownDuration(durationMs: number | undefined): number | undefined {
  return durationMs !== undefined && durationMs >= MIN_SHOWN_DURATION_MS ? durationMs : undefined;
}

export function renderBashCall(
  args: BashToolInput,
  theme: Theme,
  context: AmpToolRenderContext,
): Component {
  const text =
    context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const spinnerState = getOrCreateSpinnerState(context.state);
  const shouldSpin = context.executionStarted && context.isPartial;

  if (shouldSpin && spinnerState) {
    spinnerState.startedAt ??= Date.now();
    if (!spinnerState.timer) {
      spinnerState.timer = setInterval(() => {
        spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
        text.setText(
          buildBashCallText(
            args,
            theme,
            BASH_SPINNER_FRAMES[spinnerState.frameIndex],
            Date.now() - (spinnerState.startedAt ?? Date.now()),
          ),
        );
        context.invalidate();
      }, BASH_SPINNER_INTERVAL_MS);
    }
  } else {
    // Not (or no longer) running: always stop the timer to avoid leaks.
    stopSpinner(spinnerState);
  }

  const spinnerFrame =
    shouldSpin && spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
  const elapsedMs = shouldSpin
    ? spinnerState?.startedAt !== undefined
      ? Date.now() - spinnerState.startedAt
      : undefined
    : shownDuration(context.durationMs);
  text.setText(buildBashCallText(args, theme, spinnerFrame, elapsedMs));
  return text;
}

export function renderBashResult(
  result: AgentToolResult<BashToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AmpToolRenderContext,
): Component {
  // The execution has finished by the time the result renders; ensure the
  // spinner timer is stopped even if renderBashCall's final pass was skipped.
  if (!context.isPartial) {
    const spinnerState = getOrCreateSpinnerState(context.state);
    stopSpinner(spinnerState);
  }

  const config = getConfig();
  const output = extractTextOutput(result);
  const lines = splitLines(output);
  // Bash uses its own collapsed budget (BASH_PREVIEW_LINES); the expanded limit
  // still honours config.expandedPreviewMaxLines.
  const { shown, remaining } = collapseForPreview(lines, options.expanded, {
    ...config,
    previewLines: BASH_PREVIEW_LINES,
  });

  const icon = theme.fg(statusColor(context.isError), statusIcon(context.isError));
  const parts: string[] = [];
  if (shown.length > 0) {
    parts.push(`${icon} ${theme.fg("toolOutput", shown.join("\n"))}`);
  } else {
    parts.push(`${icon} ${theme.fg("muted", context.isError ? "command failed" : "no output")}`);
  }
  const hint = moreHint(remaining, theme, {
    expandHint: keyHint("app.tools.expand", "to expand"),
  });
  if (hint) {
    parts.push(hint);
  }
  const truncation = bashTruncationHint(result.details ?? undefined, theme);
  if (truncation) {
    parts.push(truncation);
  }
  return new Text(parts.join("\n"));
}
