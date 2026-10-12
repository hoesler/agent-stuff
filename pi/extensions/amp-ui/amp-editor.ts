import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BUILTIN_COMMAND_PALETTE_ITEMS, CommandPaletteOverlay, type CommandPaletteItem, type CommandPaletteResult, stripAnsi } from "./amp-command-palette.ts";
import { captureConsole, type ConsoleLike } from "./amp-console.ts";
import { collectAmpEditorStatusLabel } from "./amp-editor-status-hooks.ts";
import { thinkingColorFor } from "./amp-thinking.ts";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";

const MIN_BODY_LINES = 2;
const GIT_CACHE_MS = 2000;
const WORKING_FRAMES = ["~", "≈", "≋"];
const WORKING_WAITING = "Waiting";
const WORKING_THINKING = "Thinking";
const WORKING_STREAMING = "Streaming";
const WORKING_TOOLS = "Using tools";

type WorkingState = {
  active: boolean;
  message: string;
  frame: string;
};

type GitInfo = {
  branch: string | null;
};

let gitCache: { cwd: string; at: number; info: GitInfo } | undefined;

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
  } catch {
    return "";
  }
}

function getGitInfo(cwd: string): GitInfo {
  const now = Date.now();
  if (gitCache && gitCache.cwd === cwd && now - gitCache.at < GIT_CACHE_MS) return gitCache.info;

  const branch = runGit(cwd, ["branch", "--show-current"]) || null;
  const info = { branch };
  gitCache = { cwd, at: now, info };
  return info;
}

function formatCost(value: number): string {
  if (value === 0) return "$0.000";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.001) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function formatCount(value: number | null | undefined): string {
  if (value == null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * Top-left border label: context-window usage followed by the session cost,
 * e.g. `45% of 200k · $0.123`. Plain text — the caller tints the whole label.
 */
export function formatStatusTopLeft(input: {
  /** Usage as a percentage (Pi's `getContextUsage().percent`); null renders `?`. */
  contextPercent?: number | null;
  /** Context-window size in tokens; null renders `?`. */
  contextWindow?: number | null;
  cost: number;
}): string {
  const percent = input.contextPercent == null || !Number.isFinite(input.contextPercent)
    ? "?"
    : `${Math.max(0, Math.floor(input.contextPercent))}%`;
  return `${percent} of ${formatCount(input.contextWindow)} · ${formatCost(input.cost)}`;
}

export function compactModelId(modelId: string, maxWidth: number): string {
  if (visibleWidth(modelId) <= maxWidth) return modelId;
  const simplified = modelId
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (visibleWidth(simplified) <= maxWidth) return simplified;
  return truncateToWidth(simplified, maxWidth, "…");
}

export function formatStatusTopRight(input: {
  model: string;
  thinking: string;
  /** Label contributed by third-party extensions via the status-hook contract; empty hides it. */
  statusLabel?: string;
  fg: (color: ThemeColor, text: string) => string;
}): string {
  const dot = input.fg("dim", "·");
  const parts: string[] = [];
  if (input.statusLabel) {
    parts.push(input.fg("accent", input.statusLabel));
  }
  if (input.model) {
    parts.push(input.fg("muted", input.model));
  }
  parts.push(input.fg(thinkingColorFor(input.thinking), input.thinking));
  return parts.join(` ${dot} `);
}

function compactPath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

function isEditorRule(line: string): boolean {
  const plain = stripAnsi(line).trim();
  return plain.includes("─") && [...plain].every((char) => "─↑↓ 0123456789more".includes(char));
}

function splitEditorRender(lines: string[]): { editorLines: string[]; popupLines: string[] } {
  const withoutTop = lines.slice(1);
  const bottomRuleIndex = withoutTop.findIndex(isEditorRule);

  if (bottomRuleIndex === -1) {
    return { editorLines: withoutTop, popupLines: [] };
  }

  return {
    editorLines: withoutTop.slice(0, bottomRuleIndex),
    popupLines: withoutTop.slice(bottomRuleIndex + 1),
  };
}

function getSessionCost(ctx: ExtensionContext): number {
  let total = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const cost = entry.message.usage?.cost?.total;
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;

    total += cost;
  }

  return total;
}

function hideBuiltInWorking(ctx: ExtensionContext): void {
  // Hide Pi's built-in working loader row entirely (official typed API in 0.78);
  // we render our own status on the editor border. Note: setWorkingIndicator({frames:[]})
  // only suppresses the spinner animation, not the message row — setWorkingVisible(false)
  // is what removes the row.
  ctx.ui.setWorkingVisible(false);
}

type OpenCommandPalette = (initialQuery: string | undefined, onSelect: (result: CommandPaletteResult) => void) => void;

class AmpEditor extends CustomEditor {
  private readonly getCtx: () => ExtensionContext;
  private readonly getThinkingLevel: () => string;
  private readonly getWorkingState: () => WorkingState;
  private readonly openCommandPalette: OpenCommandPalette;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    getCtx: () => ExtensionContext,
    getThinkingLevel: () => string,
    getWorkingState: () => WorkingState,
    openCommandPalette: OpenCommandPalette,
  ) {
    super(tui, theme, keybindings, { paddingX: 1 });
    this.getCtx = getCtx;
    this.getThinkingLevel = getThinkingLevel;
    this.getWorkingState = getWorkingState;
    this.openCommandPalette = openCommandPalette;
  }

  private get ctx(): ExtensionContext {
    return this.getCtx();
  }

  handleInput(data: string): void {
    if (data === "/" && this.getText().trim() === "") {
      this.openCommandPalette(undefined, (result) => {
        if (result.action === "insert") {
          this.insertCommand(result.command);
        } else {
          this.submitCommand(result.command);
        }
      });
      return;
    }

    super.handleInput(data);
  }

  private insertCommand(command: string): void {
    this.setText(`/${command} `);
    this.tui.requestRender();
  }

  private submitCommand(command: string): void {
    this.setText(`/${command}`);
    const submitValue = (this as unknown as { submitValue?: () => void }).submitValue;
    if (submitValue) {
      submitValue.call(this);
      return;
    }

    this.onSubmit?.(`/${command}`);
  }

  render(width: number): string[] {
    if (width < 12) return super.render(width);

    const innerWidth = Math.max(1, width - 2);
    const base = super.render(innerWidth);
    const { editorLines, popupLines } = splitEditorRender(base);
    const body = [...editorLines];

    while (body.length < MIN_BODY_LINES) {
      body.push(" ".repeat(innerWidth));
    }

    const modelId = this.ctx.model?.id ?? "";
    const usage = this.ctx.getContextUsage();
    const leftTop = formatStatusTopLeft({
      contextPercent: usage?.percent ?? null,
      contextWindow: usage?.contextWindow ?? this.ctx.model?.contextWindow ?? null,
      cost: getSessionCost(this.ctx),
    });
    const statusLabel = collectAmpEditorStatusLabel();
    const modelBudget = Math.max(8, Math.floor(innerWidth * 0.3) - (statusLabel ? visibleWidth(statusLabel) + 3 : 0));
    const rightTop = formatStatusTopRight({
      model: modelId ? compactModelId(modelId, modelBudget) : "",
      statusLabel,
      thinking: this.getThinkingLevel(),
      fg: (c, t) => this.fg(c, t),
    });

    return [
      this.borderWithLabels(width, leftTop, rightTop),
      ...body.map((line) => this.wrapBody(line, innerWidth)),
      this.bottomBorderWithStatus(width, this.getWorkingLabel(), this.getCwdLabel()),
      ...this.wrapPopupBlock(popupLines, width),
    ];
  }

  private getCwdLabel(): string {
    const git = getGitInfo(this.ctx.cwd);
    return `${compactPath(this.ctx.cwd)}${git.branch ? ` (${git.branch})` : ""}`;
  }

  private getWorkingLabel(): string {
    const working = this.getWorkingState();
    if (!working.active) return "";

    return `${this.fg("accent", working.frame)} ${this.fg("text", working.message)}`;
  }

  private borderRow(width: number, open: string, close: string, left: string, right: string): string {
    const innerWidth = Math.max(0, width - 2);
    const fill = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(right));
    return this.borderColor(open) + left + this.borderColor("─".repeat(fill)) + right + this.borderColor(close);
  }

  private bottomBorderWithStatus(width: number, leftLabel: string, rightLabel: string): string {
    const innerWidth = Math.max(0, width - 2);
    const left = leftLabel ? ` ${truncateToWidth(leftLabel, Math.max(0, Math.floor(innerWidth * 0.5)), "…")} ` : "";
    const leftWidth = visibleWidth(left);
    const right = rightLabel ? ` ${this.fg("muted", truncateToWidth(rightLabel, Math.max(0, innerWidth - leftWidth - 2), "…"))} ` : "";
    return this.borderRow(width, "╰", "╯", left, right);
  }

  private fg(color: ThemeColor, text: string): string {
    return this.ctx.ui.theme.fg(color, text);
  }

  private wrapBody(line: string, innerWidth: number): string {
    const clipped = truncateToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    const content = clipped ? this.fg("text", clipped) : clipped;
    return this.sideBorder() + content + padding + this.sideBorder();
  }

  private wrapPopupBlock(lines: string[], width: number): string[] {
    if (lines.length === 0) return [];

    return lines.map((line) => {
      const clipped = truncateToWidth(line, width, "");
      const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
      return clipped + padding;
    });
  }

  private borderWithLabels(width: number, leftLabel: string, rightLabel: string): string {
    const innerWidth = Math.max(0, width - 2);
    const maxLeft = leftLabel ? Math.max(0, Math.floor(innerWidth * 0.44)) : 0;
    const maxRight = Math.max(0, innerWidth - maxLeft - 2);
    const left = leftLabel ? ` ${this.fg("muted", truncateToWidth(leftLabel, Math.max(0, maxLeft - 2), "…"))} ` : "";
    const right = rightLabel ? ` ${truncateToWidth(rightLabel, Math.max(0, maxRight - 2), "…")} ` : "";
    return this.borderRow(width, "╭", "╮", left, right);
  }

  private sideBorder(): string {
    return this.borderColor("│");
  }
}

function getCommandPaletteItems(pi: ExtensionAPI): CommandPaletteItem[] {
  const items = [
    ...BUILTIN_COMMAND_PALETTE_ITEMS,
    ...pi.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
      source: command.source,
    })),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export default function (pi: ExtensionAPI) {
  const activeToolExecutions = new Set<string>();
  let activeThinkingLevel = "off";
  let activeCtx: ExtensionContext | undefined;
  let activeTui: { requestRender(): void } | undefined;
  let commandPaletteOpen = false;
  let isWorking = false;
  let workingMessage = WORKING_WAITING;
  let workingFrameIndex = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let restoreConsole: (() => void) | undefined;

  // Pi stops the TUI before printing a crash report, which must reach the
  // terminal. `stopped` is protected on TUI, hence the cast.
  const tuiRunning = () => activeTui !== undefined && !(activeTui as { stopped?: boolean }).stopped;

  const requestRender = () => activeTui?.requestRender();

  const stopWorkingTimer = () => {
    if (!workingTimer) return;
    clearInterval(workingTimer);
    workingTimer = undefined;
  };

  const startWorkingTimer = () => {
    stopWorkingTimer();
    workingTimer = setInterval(() => {
      workingFrameIndex = (workingFrameIndex + 1) % WORKING_FRAMES.length;
      requestRender();
    }, 160);
  };

  const setWorkingMessage = (message: string, ctx?: ExtensionContext) => {
    workingMessage = message;
    ctx?.ui.setWorkingMessage(message);
    requestRender();
  };

  const openCommandPalette = (initialQuery = "", onSelect: (result: CommandPaletteResult) => void) => {
    const ctx = activeCtx;
    if (!ctx?.hasUI || commandPaletteOpen) return;

    commandPaletteOpen = true;
    void ctx.ui.custom<CommandPaletteResult | null>(
      (tui, theme, keybindings, done) => new CommandPaletteOverlay(
        getCommandPaletteItems(pi),
        initialQuery,
        tui,
        theme,
        keybindings,
        done,
      ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          minWidth: 42,
          maxHeight: "80%",
          margin: 1,
        },
      },
    ).then((result) => {
      commandPaletteOpen = false;
      if (!result) return;
      onSelect(result);
    }).catch(() => {
      commandPaletteOpen = false;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    activeCtx = ctx;
    activeThinkingLevel = pi.getThinkingLevel();

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeTui = tui;
      return new AmpEditor(tui, theme, keybindings, () => activeCtx ?? ctx, () => activeThinkingLevel, () => ({
        active: isWorking,
        message: workingMessage,
        frame: WORKING_FRAMES[workingFrameIndex] ?? WORKING_FRAMES[0],
      }), openCommandPalette);
    });

    hideBuiltInWorking(ctx);

    restoreConsole?.();
    restoreConsole = captureConsole(console as unknown as ConsoleLike, tuiRunning, (message, type) => ctx.ui.notify(message, type));

    ctx.ui.setFooter(() => ({
      invalidate() {},
      render() {
        return [];
      },
    }));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    activeThinkingLevel = event.level;
    if (ctx.hasUI) requestRender();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    activeThinkingLevel = pi.getThinkingLevel();
    activeToolExecutions.clear();
    isWorking = true;
    workingFrameIndex = 0;
    startWorkingTimer();
    if (!ctx.hasUI) return;
    hideBuiltInWorking(ctx);
    setWorkingMessage(WORKING_WAITING, ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    hideBuiltInWorking(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI || event.message.role !== "assistant") return;
    if (activeToolExecutions.size > 0) return;
    // Pi streams distinct phases: thinking_* (reasoning) then text_*/toolcall_* (output).
    const phase = event.assistantMessageEvent?.type ?? "";
    if (phase.startsWith("thinking")) {
      setWorkingMessage(WORKING_THINKING, ctx);
    } else if (phase.startsWith("text") || phase.startsWith("toolcall")) {
      setWorkingMessage(WORKING_STREAMING, ctx);
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeToolExecutions.add(event.toolCallId);
    if (!ctx.hasUI) return;
    setWorkingMessage(WORKING_TOOLS, ctx);
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    if (!ctx.hasUI) return;
    setWorkingMessage(WORKING_TOOLS, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeToolExecutions.delete(event.toolCallId);
    if (!ctx.hasUI) return;
    if (activeToolExecutions.size === 0) {
      setWorkingMessage(WORKING_WAITING, ctx);
    }
  });

  pi.on("agent_end", (_event, _ctx) => {
    isWorking = false;
    activeToolExecutions.clear();
    stopWorkingTimer();
    requestRender();
  });

  pi.on("session_shutdown", () => {
    stopWorkingTimer();
    restoreConsole?.();
    restoreConsole = undefined;
    activeTui = undefined;
  });
}
