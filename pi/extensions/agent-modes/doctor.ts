import { preflightMode } from "./apply-mode.ts";
import type { RouteStatus } from "./routes.ts";
import type { ConfigSnapshot, ModeConfig, ModeModel } from "./types.ts";

export interface DoctorRegistry {
  find(provider: string, id: string): ModeModel | undefined;
  available(): ModeModel[];
}

/**
 * Live state the config file cannot supply. Routes are resolved by the caller
 * rather than here, so the report shows the same answer the resolver publishes
 * to consumers instead of a second, independently derived one.
 */
export interface DoctorRuntime {
  activeMode: string;
  routes: RouteStatus[];
}

export interface DoctorReport {
  status: "OK" | "NOT_CONFIGURED" | "INVALID";
  source: string;
  fromEnvironment: boolean;
  defaultMode?: string;
  cycle?: string[];
  configuredShortcut?: string;
  registeredShortcut?: string;
  shortcutNeedsReload: boolean;
  activeMode?: string;
  routes?: RouteStatus[];
  issues: string[];
}

export function inspectConfig(
  snapshot: ConfigSnapshot,
  registry: DoctorRegistry,
  registeredShortcut: string | undefined,
  runtime?: DoctorRuntime,
): DoctorReport {
  if (!snapshot.ok) {
    return {
      status: snapshot.reason === "missing" ? "NOT_CONFIGURED" : "INVALID",
      source: snapshot.path,
      fromEnvironment: snapshot.fromEnvironment,
      registeredShortcut,
      shortcutNeedsReload: false,
      issues: snapshot.errors.map((item) => `${item.path}: ${item.message}`),
    };
  }

  const available = new Set(registry.available().map((model) => `${model.provider}/${model.id}`));
  const issues: string[] = [];
  for (const mode of snapshot.config.modes) {
    const model = registry.find(mode.provider, mode.model);
    if (!model) {
      issues.push(`${mode.id}: missing model ${mode.provider}/${mode.model}`);
      continue;
    }
    if (!available.has(`${model.provider}/${model.id}`)) {
      issues.push(`${mode.id}: model is registered but currently unavailable ${model.provider}/${model.id}`);
    }
    const compatibility = preflightMode({
      findModel: () => model,
      getCurrentModel: () => undefined,
      getThinkingLevel: () => "off",
      setModel: async () => false,
      setThinkingLevel: () => undefined,
    }, mode);
    if (compatibility) issues.push(`${mode.id}: ${compatibility}`);
  }

  return {
    status: issues.length === 0 ? "OK" : "INVALID",
    source: snapshot.path,
    fromEnvironment: snapshot.fromEnvironment,
    defaultMode: snapshot.config.defaultMode,
    cycle: snapshot.config.modes.map((mode) => mode.id),
    configuredShortcut: snapshot.config.cycleShortcut,
    registeredShortcut,
    shortcutNeedsReload: registeredShortcut !== snapshot.config.cycleShortcut,
    // Only on the ok branch: with no usable config there is no active mode to
    // resolve against, so reporting routes at all would be reporting a guess.
    ...(runtime ? { activeMode: runtime.activeMode, routes: runtime.routes } : {}),
    issues,
  };
}

/** Why a key does not resolve, in the terms of the thing the user would change to fix it. */
function routeUnavailableReason(status: RouteStatus): string {
  if (status.state === "off") return "this mode opts out";
  if (status.state === "redundant") return `${status.model} is the model already running`;
  return "no target for this mode";
}

function formatRouteLine(status: RouteStatus): string {
  if (status.state === "active") {
    return `- ${status.key} -> ${status.model}${status.description ? ` — ${status.description}` : ""}`;
  }
  return `- ${status.key} -> unavailable (${routeUnavailableReason(status)})`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "agent-modes doctor",
    `Status: ${report.status}`,
    `Source: ${report.source}${report.fromEnvironment ? " (PI_AGENT_MODES_CONFIG)" : ""}`,
  ];
  if (report.defaultMode) lines.push(`Default: ${report.defaultMode}`);
  if (report.cycle) lines.push(`Cycle: ${report.cycle.join(" -> ")}`);
  if (report.configuredShortcut) {
    const suffix = report.shortcutNeedsReload
      ? ` (reload required; registered: ${report.registeredShortcut ?? "none"})`
      : "";
    lines.push(`Shortcut: ${report.configuredShortcut}${suffix}`);
  } else {
    lines.push("Shortcut: disabled");
  }
  if (report.routes) {
    lines.push("");
    if (report.routes.length === 0) lines.push("Routes: none configured");
    else lines.push(`Routes (active mode: ${report.activeMode}):`, ...report.routes.map(formatRouteLine));
  }
  lines.push("", report.issues.length === 0 ? "Issues: none" : `Issues:\n- ${report.issues.join("\n- ")}`);
  if (report.status === "NOT_CONFIGURED") {
    lines.push("", "Run /mode init to generate a starter configuration from your available models.");
  }
  return `${lines.join("\n")}\n`;
}

export function formatModeList(config: ModeConfig): string {
  return config.modes
    .map((mode) => `${mode.id}: ${mode.provider}/${mode.model} · thinking:${mode.thinkingLevel}${mode.description ? ` · ${mode.description}` : ""}`)
    .join("\n");
}
