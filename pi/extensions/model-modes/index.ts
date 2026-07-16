import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { applyMode, type ApplyRuntime } from "./apply-mode.ts";
import { ModeConfigLoader, resolveConfigPath } from "./config.ts";
import { formatDoctorReport, formatModeList, inspectConfig } from "./doctor.ts";
import { cycleOrder, inferActiveMode, isFreshSession } from "./mode-state.ts";
import type { ActiveMode, ConfigSnapshot, ModeConfig, ModeDefinition, ModeModel, ThinkingLevel } from "./types.ts";

export default async function modelModesExtension(pi: ExtensionAPI): Promise<void> {
  const startupCwd = process.cwd();
  const envPath = process.env.PI_MODEL_MODES_CONFIG;
  const path = resolveConfigPath({ envPath, startupCwd, agentDir: getAgentDir() });
  const loader = new ModeConfigLoader(path, Boolean(envPath?.trim()));
  const initial = await loader.refresh(true);
  const registeredShortcut = initial.ok ? initial.config.cycleShortcut : undefined;
  let active: ActiveMode = { kind: "error" };
  let applying = false;

  const asModeModel = (model: Model<Api>): ModeModel => ({
    provider: model.provider,
    id: model.id,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  });

  const runtime = (ctx: ExtensionContext): ApplyRuntime => ({
    findModel: (provider, id) => {
      const model = ctx.modelRegistry.find(provider, id);
      return model ? asModeModel(model) : undefined;
    },
    getCurrentModel: () => ctx.model ? asModeModel(ctx.model) : undefined,
    getThinkingLevel: () => pi.getThinkingLevel() as ThinkingLevel,
    setModel: async (model) => {
      const target = ctx.modelRegistry.find(model.provider, model.id);
      return target ? pi.setModel(target) : false;
    },
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
  });

  const updateStatus = (ctx: ExtensionContext, snapshot: ConfigSnapshot = loader.current): void => {
    if (!snapshot.ok) active = { kind: "error" };
    else active = inferActiveMode(snapshot.config, {
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
    });
    const label = active.kind === "named" ? active.mode.id : active.kind;
    ctx.ui.setStatus("model-modes", ctx.ui.theme.fg(active.kind === "error" ? "error" : "accent", `mode:${label}`));
  };

  const activate = async (ctx: ExtensionContext, mode: ModeDefinition, quiet = false) => {
    applying = true;
    const result = await applyMode(runtime(ctx), mode);
    applying = false;
    updateStatus(ctx);
    if (!quiet) {
      if (result.ok) ctx.ui.notify(`Mode: ${mode.label}${mode.description ? ` — ${mode.description}` : ""}`, "info");
      else ctx.ui.notify(`Mode ${mode.id} failed: ${result.message}`, "warning");
    }
    return result;
  };

  const refresh = async (ctx: ExtensionContext): Promise<ConfigSnapshot> => {
    const snapshot = await loader.refresh();
    updateStatus(ctx, snapshot);
    return snapshot;
  };

  const activateById = async (ctx: ExtensionContext, id: string): Promise<void> => {
    const snapshot = loader.current;
    if (!snapshot.ok) return;
    const mode = snapshot.config.modes.find((item) => item.id === id);
    if (!mode) {
      ctx.ui.notify(`Unknown mode "${id}"`, "warning");
      return;
    }
    await activate(ctx, mode);
  };

  const cycle = async (ctx: ExtensionContext, direction: 1 | -1): Promise<void> => {
    const snapshot = await refresh(ctx);
    if (!snapshot.ok) {
      ctx.ui.notify("Model modes unavailable; run /mode doctor", "warning");
      return;
    }
    const failures: string[] = [];
    for (const mode of cycleOrder(snapshot.config, active, direction)) {
      const result = await activate(ctx, mode, true);
      if (result.ok) {
        ctx.ui.notify(`Mode: ${mode.label}${mode.description ? ` — ${mode.description}` : ""}`, "info");
        return;
      }
      failures.push(`${mode.id}: ${result.message}`);
      if (!result.rollbackSucceeded) break;
    }
    ctx.ui.notify(`No usable mode: ${failures.join("; ")}`, "warning");
  };

  const showPicker = async (ctx: ExtensionContext, config: ModeConfig): Promise<void> => {
    const items: SelectItem[] = config.modes.map((mode) => ({
      value: mode.id,
      label: active.kind === "named" && active.mode.id === mode.id ? `${mode.label} (active)` : mode.label,
      description: `${mode.provider}/${mode.model} · thinking:${mode.thinkingLevel}${mode.description ? ` · ${mode.description}` : ""}`,
    }));
    const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Select Mode")), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
      };
    });
    if (selected) await activateById(ctx, selected);
  };

  const doctorRegistry = (ctx: ExtensionContext) => ({
    find: (provider: string, id: string) => {
      const model = ctx.modelRegistry.find(provider, id);
      return model ? asModeModel(model) : undefined;
    },
    available: () => ctx.modelRegistry.getAvailable().map(asModeModel),
  });

  const showDoctor = async (ctx: ExtensionContext): Promise<void> => {
    const report = formatDoctorReport(inspectConfig(loader.current, doctorRegistry(ctx), registeredShortcut));
    if (ctx.mode === "tui") await ctx.ui.editor("model-modes doctor", report);
    else console.log(report);
  };

  const showHelp = async (ctx: ExtensionContext): Promise<void> => {
    const help = [
      "/mode — pick a mode",
      "/mode <id> — activate a mode",
      "/mode next — cycle forward",
      "/mode previous — cycle backward",
      "/mode doctor — inspect configuration",
      "/mode help — show this help",
      `Config: ${loader.path}`,
    ].join("\n");
    if (ctx.mode === "tui") await ctx.ui.editor("model-modes help", help);
    else console.log(help);
  };

  if (registeredShortcut) {
    pi.registerShortcut(registeredShortcut as KeyId, {
      description: "Cycle model and thinking mode",
      handler: async (ctx) => { await cycle(ctx, 1); },
    });
  }

  pi.registerCommand("mode", {
    description: "Select a model and thinking mode",
    handler: async (args, ctx) => {
      const snapshot = await refresh(ctx);
      const command = args.trim();
      if (command === "doctor") return showDoctor(ctx);
      if (command === "help") return showHelp(ctx);
      if (!snapshot.ok) {
        ctx.ui.notify("Model modes unavailable; run /mode doctor", "warning");
        return;
      }
      if (command === "next") return cycle(ctx, 1);
      if (command === "previous") return cycle(ctx, -1);
      if (command.length > 0) return activateById(ctx, command);
      if (ctx.mode !== "tui") {
        console.log(formatModeList(snapshot.config));
        return;
      }
      return showPicker(ctx, snapshot.config);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const snapshot = await loader.refresh();
    updateStatus(ctx, snapshot);
    if (snapshot.ok && isFreshSession(event, ctx.sessionManager.getEntries())) {
      const mode = snapshot.config.modes.find((item) => item.id === snapshot.config.defaultMode)!;
      await activate(ctx, mode);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (!applying) updateStatus(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (!applying) updateStatus(ctx);
  });
}
