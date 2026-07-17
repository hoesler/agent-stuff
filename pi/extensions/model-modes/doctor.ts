import { preflightMode } from "./apply-mode.ts";
import type { ConfigSnapshot, ModeConfig, ModeModel } from "./types.ts";

export interface DoctorRegistry {
  find(provider: string, id: string): ModeModel | undefined;
  available(): ModeModel[];
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
  issues: string[];
}

export function inspectConfig(
  snapshot: ConfigSnapshot,
  registry: DoctorRegistry,
  registeredShortcut: string | undefined,
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
    issues,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "model-modes doctor",
    `Status: ${report.status}`,
    `Source: ${report.source}${report.fromEnvironment ? " (PI_MODEL_MODES_CONFIG)" : ""}`,
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
  lines.push("", report.issues.length === 0 ? "Issues: none" : `Issues:\n- ${report.issues.join("\n- ")}`);
  if (report.status === "NOT_CONFIGURED") {
    lines.push("", "Run /mode init to generate a starter configuration from your available models.");
  }
  return `${lines.join("\n")}\n`;
}

export function formatModeList(config: ModeConfig): string {
  return config.modes
    .map((mode) => `${mode.id}: ${mode.provider}/${mode.model} · thinking:${mode.thinkingLevel}`)
    .join("\n");
}
