import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import modelModesExtension from "./index.ts";
import type { ThinkingLevel } from "./types.ts";

type Handler = (...args: any[]) => Promise<void> | void;
type Mode = { id: string; label?: string; provider?: string; model?: string; thinkingLevel?: ThinkingLevel; description?: string };

function ampEditorHooks(): Set<() => string | undefined> {
  return (globalThis as unknown as { __ampEditorStatusHooks?: Set<() => string | undefined> }).__ampEditorStatusHooks ?? new Set();
}

function latestAmpEditorHook(before: Set<() => string | undefined>): () => string | undefined {
  for (const hook of ampEditorHooks()) if (!before.has(hook)) return hook;
  throw new Error("expected a new amp-editor status hook to be registered");
}

const baseModes: Mode[] = [
  { id: "low", label: "Low", provider: "test", model: "low", thinkingLevel: "low" },
  { id: "high", label: "High", provider: "test", model: "high", thinkingLevel: "high", description: "Careful" },
];

function model(id: string, reasoning = true): Model<Api> {
  return { id, name: id, api: "test", provider: "test", baseUrl: "https://example.test", reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 };
}

async function harness(options: { modes?: Mode[]; defaultMode?: string; shortcut?: string; available?: string[]; mode?: "tui" | "print"; configText?: string; missingFile?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "model-modes-"));
  const path = join(directory, "modes.json");
  if (!options.missingFile) {
    await writeFile(path, options.configText ?? JSON.stringify({ version: 1, defaultMode: options.defaultMode ?? "low", cycleShortcut: options.shortcut ?? "f8", modes: options.modes ?? baseModes }));
  }
  const previousPath = process.env.PI_MODEL_MODES_CONFIG;
  process.env.PI_MODEL_MODES_CONFIG = path;
  const commands = new Map<string, { handler: Handler }>();
  const shortcuts = new Map<string, { handler: Handler }>();
  const events = new Map<string, Handler>();
  const models = new Map((options.available ?? ["low", "high"]).map((id) => [`test/${id}`, model(id)]));
  let current = models.get("test/low");
  let thinking: ThinkingLevel = "low";
  let setModelBehavior = async (_target: Model<Api>) => true;
  let setThinking = (level: ThinkingLevel) => { thinking = level; };
  const notifications: Array<[string, string | undefined]> = [];
  const statuses: string[] = [];
  const editors: Array<[string, string | undefined]> = [];
  let customCalls = 0;
  const userMessages: Array<[string, { deliverAs?: "steer" | "followUp" } | undefined]> = [];
  const context = {
    mode: options.mode ?? "tui",
    modelRegistry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`), getAvailable: () => [...models.values()] },
    get model() { return current; },
    sessionManager: { getEntries: () => [] },
    isIdle: () => true,
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (message: string, type?: string) => notifications.push([message, type]),
      editor: async (title: string, text?: string) => { editors.push([title, text]); return undefined; },
      custom: async (factory: any) => { customCalls += 1; factory({ requestRender() {} }, context.ui.theme, {}, () => {}); return null; },
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (event: string, handler: Handler) => events.set(event, handler),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    registerShortcut: (shortcut: string, value: { handler: Handler }) => shortcuts.set(shortcut, value),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: ThinkingLevel) => setThinking(level),
    sendUserMessage: (content: string, sendOptions?: { deliverAs?: "steer" | "followUp" }) => { userMessages.push([content, sendOptions]); },
    setModel: async (target: Model<Api>) => {
      const accepted = await setModelBehavior(target);
      if (accepted) current = target;
      return accepted;
    },
  } as unknown as ExtensionAPI;
  await modelModesExtension(api);
  const restore = () => { if (previousPath === undefined) delete process.env.PI_MODEL_MODES_CONFIG; else process.env.PI_MODEL_MODES_CONFIG = previousPath; };
  return { path, commands, shortcuts, events, context, models, notifications, statuses, editors, userMessages, get thinking() { return thinking; }, get current() { return current; }, setModel: (fn: (target: Model<Api>) => Promise<boolean>) => { setModelBehavior = fn; }, setThinkingBehavior: (fn: (level: ThinkingLevel) => void) => { setThinking = fn; }, setThinking: (level: ThinkingLevel) => { thinking = level; }, customCalls: () => customCalls, restore };
}

test("registers the mode command, configured shortcut, and state events", async () => {
  const h = await harness();
  try {
    assert.deepEqual([...h.commands.keys()], ["mode"]);
    assert.equal(h.shortcuts.has("f8"), true);
    assert.equal(h.events.has("session_start"), true);
    assert.equal(h.events.has("model_select"), true);
    assert.equal(h.events.has("thinking_level_select"), true);
  } finally { h.restore(); }
});

test("direct mode selection applies the requested mode", async () => {
  const h = await harness();
  try {
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(h.current?.id, "high");
    assert.equal(h.thinking, "high");
  } finally { h.restore(); }
});

test("status combines mode id with the active model and thinking level, and no success toast is shown (status bar is the source of truth)", async () => {
  const h = await harness();
  try {
    const notificationsBefore = h.notifications.length;
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(h.statuses.at(-1), "mode:high (high · thinking:high)");
    assert.equal(h.notifications.length, notificationsBefore, "switching modes successfully should not push a toast; the status bar already reflects it");
  } finally { h.restore(); }
});

test("registers an amp-editor status hook that mirrors the active mode for named, custom, and error states", async () => {
  const before = new Set(ampEditorHooks());
  const h = await harness();
  try {
    const hook = latestAmpEditorHook(before);
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(hook(), "mode:high");
    h.setThinking("medium");
    await h.events.get("thinking_level_select")!({}, h.context);
    assert.equal(hook(), "mode:custom");
  } finally { h.restore(); }
});

test("amp-editor status hook reports nothing when configuration is invalid", async () => {
  const before = new Set(ampEditorHooks());
  const h = await harness({ configText: "{}" });
  try {
    const hook = latestAmpEditorHook(before);
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(hook(), undefined);
  } finally { h.restore(); }
});

test("BUG: repeated extension activation does not accumulate duplicate amp-editor status hooks", async () => {
  // Extension activation can happen more than once per process (reload,
  // resume/fork, additional windows sharing the process, etc). Each
  // activation used to register a brand-new hook and never clean up the
  // previous one, so the shared global set grew unbounded and the status
  // line rendered "mode:high · mode:high · mode:high · mode:high".
  const before = new Set(ampEditorHooks());
  const h1 = await harness();
  const h2 = await harness();
  const h3 = await harness();
  try {
    const added = [...ampEditorHooks()].filter((hook) => !before.has(hook));
    assert.equal(added.length, 1, "only the most recent activation's hook should remain registered");
    await h3.commands.get("mode")!.handler("high", h3.context);
    assert.equal(added[0]!(), "mode:high");
  } finally { h1.restore(); h2.restore(); h3.restore(); }
});

test("cycling skips unavailable models and supports reverse order", async () => {
  const h = await harness({ modes: [...baseModes, { id: "missing", provider: "test", model: "missing", thinkingLevel: "medium" }] });
  try {
    await h.commands.get("mode")!.handler("next", h.context);
    assert.equal(h.current?.id, "high");
    await h.commands.get("mode")!.handler("previous", h.context);
    assert.equal(h.current?.id, "low");
  } finally { h.restore(); }
});

test("cycling stops after a failed rollback", async () => {
  const h = await harness({ modes: [{ id: "first", provider: "test", model: "high", thinkingLevel: "high" }, { id: "second", provider: "test", model: "low", thinkingLevel: "low" }], defaultMode: "first" });
  try {
    h.setModel(async (target) => {
      if (target.id === "low") return false;
      return true;
    });
    h.setThinkingBehavior((level) => { if (level !== "high") h.setThinking(level); });
    h.setThinking("medium");
    await h.commands.get("mode")!.handler("next", h.context);
    assert.match(h.notifications.at(-1)![0], /No usable mode/);
  } finally { h.restore(); }
});

test("doctor uses editor in TUI and console output in print mode", async () => {
  const tui = await harness(); const print = await harness({ mode: "print" }); const log = console.log; const lines: string[] = []; console.log = (line: string) => lines.push(line);
  try {
    await tui.commands.get("mode")!.handler("doctor", tui.context);
    await print.commands.get("mode")!.handler("doctor", print.context);
    assert.equal(tui.editors[0]?.[0], "model-modes doctor");
    assert.match(lines[0]!, /model-modes doctor/);
  } finally { console.log = log; tui.restore(); print.restore(); }
});

test("help includes resolved configuration path and all subcommands", async () => {
  const h = await harness();
  try {
    await h.commands.get("mode")!.handler("help", h.context);
    const text = h.editors[0]![1]!;
    for (const command of ["next", "previous", "doctor", "init", "help", h.path]) assert.match(text, new RegExp(command));
  } finally { h.restore(); }
});

test("bare command opens picker in TUI and lists modes in print mode", async () => {
  const tui = await harness(); const print = await harness({ mode: "print" }); const log = console.log; const lines: string[] = []; console.log = (line: string) => lines.push(line);
  try {
    await tui.commands.get("mode")!.handler("", tui.context);
    await print.commands.get("mode")!.handler("", print.context);
    assert.equal(tui.customCalls(), 1);
    assert.equal(print.customCalls(), 0);
    assert.match(lines[0]!, /low: test\/low/);
  } finally { console.log = log; tui.restore(); print.restore(); }
});

test("intermediate selection events while applying do not publish transient status", async () => {
  const h = await harness();
  try {
    h.setModel(async (target) => {
      const before = h.statuses.length;
      await h.events.get("model_select")!({}, h.context);
      assert.equal(h.statuses.length, before);
      return target.id === "high";
    });
    await h.commands.get("mode")!.handler("high", h.context);
    assert.match(h.statuses.at(-1)!, /^mode:high /);
  } finally { h.restore(); }
});

test("thrown thinking-level application clears applying before later selection events", async () => {
  const h = await harness();
  try {
    h.setThinkingBehavior(() => { throw new Error("thinking level unavailable"); });
    await h.commands.get("mode")!.handler("high", h.context);
    assert.match(h.notifications.at(-1)![0], /Mode high failed: thinking level unavailable/);
    const before = h.statuses.length;
    await h.events.get("thinking_level_select")!({}, h.context);
    assert.equal(h.statuses.length, before + 1);
    assert.match(h.statuses.at(-1)!, /^mode:custom/);
  } finally { h.restore(); }
});

test("manual selections publish custom status unless exact triple matches", async () => {
  const h = await harness();
  try {
    h.setThinking("medium");
    await h.events.get("model_select")!({}, h.context);
    await h.events.get("thinking_level_select")!({}, h.context);
    assert.match(h.statuses.at(-1)!, /^mode:custom/);
    h.setThinking("low");
    await h.events.get("thinking_level_select")!({}, h.context);
    assert.match(h.statuses.at(-1)!, /^mode:low /);
  } finally { h.restore(); }
});

test("fresh starts apply the default while resume, fork, and reload preserve selection", async () => {
  const h = await harness({ defaultMode: "high" });
  try {
    await h.events.get("session_start")!({ reason: "startup" }, h.context);
    assert.equal(h.current?.id, "high");
    await h.commands.get("mode")!.handler("low", h.context);
    for (const reason of ["resume", "fork", "reload"] as const) {
      await h.events.get("session_start")!({ reason }, h.context);
      assert.equal(h.current?.id, "low");
    }
    await h.events.get("session_start")!({ reason: "new" }, h.context);
    assert.equal(h.current?.id, "high");
  } finally { h.restore(); }
});

test("an explicit CLI model selection outranks the default mode on a fresh start", async () => {
  const h = await harness({ defaultMode: "high" });
  const previousArgv = process.argv;
  try {
    // What the subagent tool spawns, and what `pi --model <x>` looks like.
    process.argv = ["/usr/bin/node", "/opt/pi/main.js", "--mode", "json", "-p", "--no-session", "--model", "test/low", "Task: hi"];
    await h.events.get("session_start")!({ reason: "startup" }, h.context);
    assert.equal(h.current?.id, "low");
    assert.equal(h.thinking, "low");
  } finally { process.argv = previousArgv; h.restore(); }
});

test("invalid configuration publishes error status and blocks switches", async () => {
  const h = await harness({ configText: "{}" });
  try {
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(h.current?.id, "low");
    assert.equal(h.statuses.at(-1), "mode:error");
    assert.match(h.notifications.at(-1)![0], /invalid/);
  } finally { h.restore(); }
});

test("missing configuration file gives a distinct not-configured message pointing at /mode init", async () => {
  const h = await harness({ missingFile: true });
  try {
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(h.current?.id, "low");
    assert.match(h.notifications.at(-1)![0], /No mode configuration found/);
    assert.match(h.notifications.at(-1)![0], /\/mode init/);
  } finally { h.restore(); }
});

test("mode init sends the model a prompt listing available models and never writes the config file", async () => {
  const h = await harness({ missingFile: true, available: ["low", "high"] });
  try {
    await h.commands.get("mode")!.handler("init", h.context);
    assert.equal(h.userMessages.length, 1);
    const [content] = h.userMessages[0]!;
    assert.match(content, /test\/low/);
    assert.match(content, /test\/high/);
    assert.match(content, /```json/);
    assert.match(content, new RegExp(h.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(content, /do not create, write, or modify any files/i);
  } finally { h.restore(); }
});

test("mode init still works when the configuration is missing or invalid", async () => {
  const h = await harness({ configText: "{}" });
  try {
    await h.commands.get("mode")!.handler("init", h.context);
    assert.equal(h.userMessages.length, 1);
  } finally { h.restore(); }
});

test("before_agent_start does not inject a catalog when exposeCatalogInSystemPrompt is unset", async () => {
  const h = await harness();
  try {
    const result = await h.events.get("before_agent_start")!({ prompt: "hi", systemPrompt: "base prompt" }, h.context);
    assert.equal(result, undefined);
  } finally { h.restore(); }
});

test("before_agent_start appends the mode catalog when exposeCatalogInSystemPrompt is enabled", async () => {
  const h = await harness({
    configText: JSON.stringify({ version: 1, defaultMode: "low", exposeCatalogInSystemPrompt: true, modes: baseModes }),
  });
  try {
    const result = await h.events.get("before_agent_start")!({ prompt: "hi", systemPrompt: "base prompt" }, h.context) as unknown as { systemPrompt: string };
    assert.match(result.systemPrompt, /^base prompt\n\n## Available model modes/);
    assert.match(result.systemPrompt, /`low` → `test\/low:low`/);
    assert.match(result.systemPrompt, /`high` → `test\/high:high` — Careful/);
  } finally { h.restore(); }
});

test("before_agent_start injects nothing when the enabled configuration is invalid", async () => {
  const h = await harness({ configText: "{}" });
  try {
    const result = await h.events.get("before_agent_start")!({ prompt: "hi", systemPrompt: "base prompt" }, h.context);
    assert.equal(result, undefined);
  } finally { h.restore(); }
});

test("BUG: TUI shortcut contexts snapshot ctx.model at keypress time; applied mode must publish named status anyway", async () => {
  // interactive-mode.js setupExtensionShortcuts() does NOT hand shortcut
  // handlers the runner's context (whose `model` is a live getter). It builds
  // its own literal with `model: this.session.model` -- a plain value frozen
  // at keypress time. After applyMode() switches the model, reading ctx.model
  // still returns the PRE-switch model, so status inference used to see e.g.
  // {old-model, new-thinking}, match no mode, and flash "mode:custom" until a
  // later event with a live context self-healed it.
  const before = new Set(ampEditorHooks());
  const h = await harness();
  try {
    const hook = latestAmpEditorHook(before);
    const live = h.context as unknown as { model: Model<Api> | undefined; modelRegistry: unknown; sessionManager: unknown; ui: unknown };
    const keypressSnapshot = {
      mode: "tui",
      modelRegistry: live.modelRegistry,
      model: live.model, // plain data property, frozen now -- exactly like interactive-mode.js
      sessionManager: live.sessionManager,
      isIdle: () => true,
      ui: live.ui,
    } as unknown as ExtensionContext;
    await h.shortcuts.get("f8")!.handler(keypressSnapshot);
    assert.equal(h.current?.id, "high", "cycle should have applied the next mode");
    assert.equal(hook(), "mode:high", "status hook must reflect the mode that was just applied");
    assert.equal(h.statuses.at(-1), "mode:high (high · thinking:high)");
  } finally { h.restore(); }
});

test("BUG: overlapping shortcut presses (not awaited by the real dispatcher) race and can leave status stuck on custom", async () => {
  // interactive-mode.js dispatches extension shortcuts as
  // `Promise.resolve(shortcut.handler(createContext())).catch(...)` -- it does NOT
  // await the handler before processing the next keystroke. Rapidly pressing the
  // cycle shortcut therefore starts a second `cycle()` while the first is still
  // mid-flight (still awaiting config reload / setModel). Reproduce that here by
  // firing two shortcut invocations back-to-back without awaiting the first.
  const threeModes: Mode[] = [
    { id: "low", label: "Low", provider: "test", model: "low", thinkingLevel: "low" },
    { id: "medium", label: "Medium", provider: "test", model: "medium", thinkingLevel: "medium" },
    { id: "high", label: "High", provider: "test", model: "high", thinkingLevel: "high" },
  ];
  const h = await harness({ modes: threeModes, defaultMode: "low", shortcut: "f8", available: ["low", "medium", "high"] });
  try {
    // Prime state: currently on "low" (matches harness defaults).
    await h.commands.get("mode")!.handler("low", h.context);
    assert.match(h.statuses.at(-1)!, /^mode:low /);

    // Give setModel a real async gap (like network/auth/disk I/O in production)
    // so overlapping cycles interleave instead of running strictly sequentially.
    h.setModel(async (target) => { await Promise.resolve(); await Promise.resolve(); return true; });

    const shortcut = h.shortcuts.get("f8")!.handler;
    // Two rapid presses, exactly as the un-awaited dispatcher would trigger them.
    const first = shortcut(h.context);
    const second = shortcut(h.context);
    await Promise.all([first, second]);

    // Two forward cycles from "low" should deterministically land on "high".
    assert.equal(h.current?.id, "high", "model should have advanced two steps");
    assert.equal(h.thinking, "high", "thinking level should match the final mode");
    assert.match(
      h.statuses.at(-1)!,
      /^mode:high /,
      `status should reflect the settled mode, got: ${h.statuses.at(-1)}`,
    );
  } finally { h.restore(); }
});
