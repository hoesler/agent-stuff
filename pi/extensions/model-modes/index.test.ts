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

test("status combines mode id with the active model and thinking level, and the switch toast omits the description", async () => {
  const h = await harness();
  try {
    await h.commands.get("mode")!.handler("high", h.context);
    assert.equal(h.statuses.at(-1), "mode:high (high · thinking:high)");
    assert.equal(h.notifications.at(-1)![0], "Mode: High");
    assert.doesNotMatch(h.notifications.at(-1)![0], /Careful/);
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
