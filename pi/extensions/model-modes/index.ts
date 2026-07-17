import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { applyMode, type ApplyRuntime } from "./apply-mode.ts";
import { formatModeCatalog } from "./catalog.ts";
import { ModeConfigLoader, resolveConfigPath } from "./config.ts";
import { formatDoctorReport, formatModeList, inspectConfig } from "./doctor.ts";
import { cycleOrder, inferActiveMode, isFreshSession } from "./mode-state.ts";
import { registerAmpEditorStatusHook } from "./status-hook.ts";
import type { ActiveMode, ApplyResult, ConfigSnapshot, ModeConfig, ModeDefinition, ModeModel, ThinkingLevel } from "./types.ts";

export default async function modelModesExtension(pi: ExtensionAPI): Promise<void> {
  const instanceId = Math.random().toString(36).slice(2, 8);
  const debugLog = (line: string): void => {
    if (!process.env.PI_MODEL_MODES_DEBUG) return;
    try {
      appendFileSync(join(homedir(), ".pi", "agent", "model-modes-debug.log"), `${new Date().toISOString()} [pid=${process.pid} instance=${instanceId}] ${line}\n`);
    } catch {
      // ignore debug logging failures
    }
  };

  debugLog("extension activated");

  const startupCwd = process.cwd();
  const envPath = process.env.PI_MODEL_MODES_CONFIG;
  const path = resolveConfigPath({ envPath, startupCwd, agentDir: getAgentDir() });
  const loader = new ModeConfigLoader(path, Boolean(envPath?.trim()));
  const initial = await loader.refresh(true);
  const registeredShortcut = initial.ok ? initial.config.cycleShortcut : undefined;
  let active: ActiveMode = { kind: "error" };
  let applying = false;
  let lastEventCtx: ExtensionContext | undefined;
  // Serialize cycle/activate calls so overlapping invocations (e.g. rapid
  // shortcut presses, which the TUI dispatches fire-and-forget without
  // awaiting the previous handler) can never interleave their model/thinking
  // mutations. Without this, two concurrent activations can leave the real
  // (model, thinkingLevel) pair not matching any configured mode, which
  // correctly-but-confusingly renders as "mode:custom".
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Registering again on every activation (reload, resume, fork, new window,
  // etc.) would otherwise accumulate duplicate hooks in the shared global set,
  // making the status line repeat "mode:<id>" once per accumulated instance.
  // Unregister any hook left behind by a previous activation before adding ours.
  const statusHookRegistry = globalThis as typeof globalThis & { __modelModesStatusHookUnregister?: () => void };
  debugLog(`registering status hook, previous slot owner unregistering=${Boolean(statusHookRegistry.__modelModesStatusHookUnregister)}`);
  statusHookRegistry.__modelModesStatusHookUnregister?.();
  let lastHookLabel: string | undefined;
  statusHookRegistry.__modelModesStatusHookUnregister = registerAmpEditorStatusHook(() => {
    const label = active.kind === "named" ? `mode:${active.mode.id}` : active.kind === "custom" ? "mode:custom" : undefined;
    if (label !== lastHookLabel) {
      debugLog(`status hook label changed: ${lastHookLabel} -> ${label}`);
      lastHookLabel = label;
    }
    return label;
  });

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
      debugLog(`runtime.setModel called: requested=${model.provider}/${model.id} found=${target ? `${target.provider}/${target.id}` : "undefined"}`);
      if (!target) return false;
      const result = await pi.setModel(target);
      debugLog(
        `runtime.setModel result: ${result} liveModelAfter(outerCtx)=${ctx.model?.provider}/${ctx.model?.id} ` +
          `liveModelAfter(lastEventCtx)=${lastEventCtx?.model?.provider}/${lastEventCtx?.model?.id} ` +
          `sameCtxObject=${ctx === lastEventCtx}`,
      );
      return result;
    },
    setThinkingLevel: (level) => {
      debugLog(`runtime.setThinkingLevel called: requested=${level} liveModelAtCallTime=${ctx.model?.provider}/${ctx.model?.id}`);
      pi.setThinkingLevel(level);
      debugLog(`runtime.setThinkingLevel done: liveLevelAfter=${pi.getThinkingLevel()}`);
    },
  });

  const updateStatus = (ctx: ExtensionContext, snapshot: ConfigSnapshot = loader.current, source = "unknown"): void => {
    if (!snapshot.ok) active = { kind: "error" };
    else {
      const selection = {
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
      };
      active = inferActiveMode(snapshot.config, selection);
      debugLog(
        `updateStatus[source=${source}, applying=${applying}] selection=${JSON.stringify(selection)} modes=${JSON.stringify(snapshot.config.modes.map((m) => ({ id: m.id, provider: m.provider, model: m.model, thinkingLevel: m.thinkingLevel })))} -> ${active.kind}`,
      );
    }
    const label = active.kind === "named" ? active.mode.id : active.kind;
    const modelId = ctx.model?.id;
    const level = pi.getThinkingLevel();
    const detail = active.kind !== "error" && modelId ? ` (${modelId} · thinking:${level})` : "";
    ctx.ui.setStatus("model-modes", ctx.ui.theme.fg(active.kind === "error" ? "error" : "accent", `mode:${label}${detail}`));
  };

  const activate = async (ctx: ExtensionContext, mode: ModeDefinition, quiet = false) => {
    applying = true;
    let result: ApplyResult;
    try {
      result = await applyMode(runtime(ctx), mode);
    } catch (cause) {
      result = {
        ok: false,
        mode,
        stage: "thinking",
        message: cause instanceof Error ? cause.message : String(cause),
        stateChanged: true,
        rollbackSucceeded: false,
      };
    } finally {
      applying = false;
    }
    updateStatus(ctx, undefined, "activate");
    if (process.env.PI_MODEL_MODES_DEBUG && result.ok) {
      // Double-set probe: call setModel again with the SAME target we just applied.
      // session.setModel() computes `previousModel = this.model` (a session-internal
      // read, independent of our ctx) at the very start of the call. If that still
      // reports the OLD model here, the write path itself never landed (or got
      // reverted) -- if it reports the model we just applied, the write succeeded
      // and only OUR read of ctx.model is stale/wrong.
      const probeTarget = ctx.modelRegistry.find(mode.provider, mode.model);
      if (probeTarget) {
        debugLog(`probe: re-issuing setModel(${mode.provider}/${mode.model}) to inspect session-internal previousModel via the resulting event`);
        await pi.setModel(probeTarget);
      }
    }
    if (!quiet) {
      if (result.ok) ctx.ui.notify(`Mode: ${mode.label}`, "info");
      else ctx.ui.notify(`Mode ${mode.id} failed: ${result.message}`, "warning");
    }
    return result;
  };

  const refresh = async (ctx: ExtensionContext): Promise<ConfigSnapshot> => {
    const snapshot = await loader.refresh();
    updateStatus(ctx, snapshot, "refresh");
    return snapshot;
  };

  const activateByIdImpl = async (ctx: ExtensionContext, id: string): Promise<void> => {
    const snapshot = loader.current;
    if (!snapshot.ok) return;
    const mode = snapshot.config.modes.find((item) => item.id === id);
    if (!mode) {
      ctx.ui.notify(`Unknown mode "${id}"`, "warning");
      return;
    }
    await activate(ctx, mode);
  };

  // Entry point: serialized so it can never interleave with a concurrent cycle/activation.
  const activateById = (ctx: ExtensionContext, id: string): Promise<void> => serialize(() => activateByIdImpl(ctx, id));

  const unavailableMessage = (snapshot: Extract<ConfigSnapshot, { ok: false }>): string =>
    snapshot.reason === "missing"
      ? `No mode configuration found at ${snapshot.path}. Run /mode init to generate a starter config, or /mode doctor for details.`
      : "Model modes configuration is invalid; run /mode doctor for details.";

  const cycleImpl = async (ctx: ExtensionContext, direction: 1 | -1): Promise<void> => {
    const snapshot = await refresh(ctx);
    if (!snapshot.ok) {
      ctx.ui.notify(unavailableMessage(snapshot), "warning");
      return;
    }
    const failures: string[] = [];
    for (const mode of cycleOrder(snapshot.config, active, direction)) {
      const result = await activate(ctx, mode, true);
      if (result.ok) {
        ctx.ui.notify(`Mode: ${mode.label}`, "info");
        return;
      }
      failures.push(`${mode.id}: ${result.message}`);
      if (!result.rollbackSucceeded) break;
    }
    ctx.ui.notify(`No usable mode: ${failures.join("; ")}`, "warning");
  };

  // Entry point: serialized. The TUI dispatches extension shortcuts
  // fire-and-forget (it does not await the previous keypress's handler before
  // processing the next one), so rapid presses of the cycle shortcut would
  // otherwise start overlapping cycles that interleave their model/thinking
  // mutations and can leave the real state matching no configured mode
  // (rendered as "mode:custom"). Serializing guarantees each cycle fully
  // settles before the next one starts.
  const cycle = (ctx: ExtensionContext, direction: 1 | -1): Promise<void> => serialize(() => cycleImpl(ctx, direction));

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
      "/mode init — ask the model to draft a starter configuration",
      "/mode help — show this help",
      `Config: ${loader.path}`,
    ].join("\n");
    if (ctx.mode === "tui") await ctx.ui.editor("model-modes help", help);
    else console.log(help);
  };

  const showInit = (ctx: ExtensionContext): void => {
    const available = ctx.modelRegistry.getAvailable();
    if (available.length === 0) {
      ctx.ui.notify("No available models found; configure a provider before running /mode init", "warning");
      return;
    }
    const catalog = available
      .map((model) => `- ${model.provider}/${model.id} (reasoning: ${model.reasoning ? "yes" : "no"}, context: ${model.contextWindow}, maxOutput: ${model.maxTokens})`)
      .join("\n");
    const prompt = [
      "Design a starter configuration for the model-modes Pi extension.",
      `The file will be saved at: ${loader.path}`,
      "",
      "Available models (only use models from this exact list):",
      catalog,
      "",
      "Requirements:",
      '- Produce a JSON document matching this schema: { "version": 1, "defaultMode": string, "cycleShortcut"?: string, "modes": [{ "id": string, "label": string, "provider": string, "model": string, "thinkingLevel": "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max", "description"?: string }] }',
      "- Pick 3-4 modes (e.g. low/medium/high/ultra) spanning a sensible range of cost and depth using only the models listed above.",
      '- Only use a non-"off" thinkingLevel for a mode whose model has reasoning: yes.',
      "- Suggest a cycleShortcut (e.g. an unused function key) if reasonable.",
      "- Respond with exactly one fenced ```json code block containing the document, plus one short sentence telling me to save it to the path above.",
      "- Do not create, write, or modify any files yourself; only print the JSON for me to save.",
    ].join("\n");
    pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
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
      if (command === "init") return showInit(ctx);
      if (!snapshot.ok) {
        ctx.ui.notify(unavailableMessage(snapshot), "warning");
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
    updateStatus(ctx, snapshot, "session_start");
    if (snapshot.ok && isFreshSession(event, ctx.sessionManager.getEntries())) {
      const mode = snapshot.config.modes.find((item) => item.id === snapshot.config.defaultMode)!;
      await serialize(() => activate(ctx, mode));
    }
  });

  pi.on("model_select", async (event, ctx) => {
    lastEventCtx = ctx;
    const modelSelectEvent = event as { model?: { provider?: string; id?: string }; previousModel?: { provider?: string; id?: string } };
    debugLog(
      `event model_select applying=${applying} payload=${JSON.stringify(event)} ` +
        `ctxModelDuringHandler=${ctx.model?.provider}/${ctx.model?.id} ` +
        `ctxModelIsPayloadModel=${ctx.model === modelSelectEvent.model} ` +
        `ctxModelIsPayloadPrevious=${ctx.model === modelSelectEvent.previousModel}`,
    );
    if (!applying) updateStatus(ctx, undefined, "event:model_select");
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    debugLog(`event thinking_level_select applying=${applying} payload=${JSON.stringify(event)}`);
    if (!applying) updateStatus(ctx, undefined, "event:thinking_level_select");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const snapshot = await refresh(ctx);
    if (!snapshot.ok || !snapshot.config.exposeCatalogInSystemPrompt) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${formatModeCatalog(snapshot.config)}` };
  });
}
