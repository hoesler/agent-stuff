import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { UserMessageComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import ampEditorExtension from "./amp-editor.ts";
import ampUserMessageExtension from "./amp-user-message.ts";

// Starting the agent starts the editor's spinner interval, and no test here
// waits on a frame; faked, it cannot keep the test process alive.
mock.timers.enable({ apis: ["setInterval"] });

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type ThemeStub = {
  borderColor(text: string): string;
  fg(color: string, text: string): string;
  italic?(text: string): string;
};

function expectDefined<T>(value: T | undefined, message: string): T {
  assert.notEqual(value, undefined, message);
  return value as T;
}

function createPiStub(getThinkingLevel: () => string) {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    getThinkingLevel,
  } as unknown as ExtensionAPI;

  return { pi, handlers };
}

function createThemeStub(): ThemeStub {
  return {
    borderColor(text: string) {
      return text;
    },
    fg(_color: string, text: string) {
      return text;
    },
    italic(text: string) {
      return text;
    },
  };
}

function createTaggedThemeStub(): ThemeStub {
  return {
    borderColor(text: string) {
      return text;
    },
    fg(color: string, text: string) {
      return `[${color}]${text}`;
    },
    italic(text: string) {
      return text;
    },
  };
}

function createSessionManager(thinkingLevel = "medium") {
  const entries = [
    {
      type: "thinking_level_change",
      id: "thinking-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    },
  ];

  return {
    getEntries() {
      return entries;
    },
    getLeafId() {
      return "thinking-1";
    },
    getSessionName() {
      return undefined;
    },
  };
}

function createSessionManagerWithoutThinking() {
  return {
    getEntries() {
      return [];
    },
    getLeafId() {
      return undefined;
    },
    getSessionName() {
      return undefined;
    },
  };
}

function createSessionManagerWithCost(cost: number) {
  const entries = [
    {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        usage: { cost: { total: cost } },
      },
    },
  ];

  return {
    getEntries() {
      return entries;
    },
    getLeafId() {
      return "assistant-1";
    },
    getSessionName() {
      return undefined;
    },
  };
}

function resetUserMessagePatch(): void {
  const prototype = UserMessageComponent.prototype as unknown as {
    render: UserMessageComponent["render"];
    __ampUserMessageOriginalRender?: UserMessageComponent["render"];
    __ampUserMessagePatched?: boolean;
    __ampUserMessageGetTheme?: () => unknown;
    __ampUserMessageGetThinkingLevel?: () => string;
  };

  if (prototype.__ampUserMessageOriginalRender) {
    prototype.render = prototype.__ampUserMessageOriginalRender;
  }

  delete prototype.__ampUserMessageOriginalRender;
  delete prototype.__ampUserMessagePatched;
  delete prototype.__ampUserMessageGetTheme;
  delete prototype.__ampUserMessageGetThinkingLevel;
}

test("amp user message render stays safe after session manager becomes stale", () => {
  resetUserMessagePatch();

  let stale = false;
  const sessionManager = createSessionManager();
  const staleAwareSessionManager = {
    ...sessionManager,
    getEntries() {
      if (stale) throw new Error("stale session manager");
      return sessionManager.getEntries();
    },
    getLeafId() {
      if (stale) throw new Error("stale session manager");
      return sessionManager.getLeafId();
    },
  };

  const { pi, handlers } = createPiStub(() => "medium");

  ampUserMessageExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      sessionManager: staleAwareSessionManager,
      ui: { theme: createThemeStub() },
    } as unknown as ExtensionContext,
  );

  const message = new UserMessageComponent("hello from amp");
  assert.doesNotThrow(() => message.render(48));

  stale = true;
  assert.doesNotThrow(() => message.render(48));

  resetUserMessagePatch();
});

test("amp editor working message waits until assistant update before streaming", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const workingMessages: Array<string | undefined> = [];

  ampEditorExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: createSessionManager(),
    getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
    ui: {
      theme: createThemeStub(),
      setEditorComponent() {},
      setWorkingIndicator() {},
      setWorkingVisible() {},
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
      setFooter() {},
    },
  } as unknown as ExtensionContext;

  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.deepEqual(workingMessages, []);

  const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
  beforeAgentStart({ type: "before_agent_start" }, ctx);
  assert.equal(workingMessages.at(-1), "Waiting");

  const messageStart = handlers.get("message_start");
  messageStart?.({ type: "message_start", message: { role: "assistant", content: [] } }, ctx);
  assert.equal(workingMessages.at(-1), "Waiting");

  const messageUpdate = expectDefined(handlers.get("message_update"), "message_update handler should be registered");
  messageUpdate(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta" },
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
    },
    ctx,
  );
  assert.equal(workingMessages.at(-1), "Thinking");

  messageUpdate(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta" },
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    },
    ctx,
  );
  assert.equal(workingMessages.at(-1), "Streaming");
});

test("amp editor shows running tools while tool execution is active", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const workingMessages: Array<string | undefined> = [];

  ampEditorExtension(pi);

  const toolExecutionStart = expectDefined(handlers.get("tool_execution_start"), "tool_execution_start handler should be registered");

  toolExecutionStart(
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} },
    {
      hasUI: true,
      ui: {
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
      },
    } as unknown as ExtensionContext,
  );

  assert.equal(workingMessages.at(-1), "Using tools");
});

test("amp editor hides Pi's built-in working row during agent start", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const visibleCalls: boolean[] = [];
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: createSessionManager(),
    getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
    ui: {
      theme: createThemeStub(),
      setEditorComponent() {},
      setWorkingVisible(visible: boolean) {
        visibleCalls.push(visible);
      },
      setWorkingIndicator() {},
      setWorkingMessage() {},
      setFooter() {},
    },
  } as unknown as ExtensionContext;

  ampEditorExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
  const agentStart = expectDefined(handlers.get("agent_start"), "agent_start handler should be registered");

  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  beforeAgentStart({ type: "before_agent_start" }, ctx);
  agentStart({ type: "agent_start" }, ctx);

  // hideBuiltInWorking is invoked on session_start, before_agent_start, and agent_start.
  assert.deepEqual(visibleCalls, [false, false, false]);
});

test("amp editor keeps working message ordered while tools are active", () => {
  const { pi, handlers } = createPiStub(() => "medium");
  const workingMessages: Array<string | undefined> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWorkingMessage(message?: string) {
        workingMessages.push(message);
      },
    },
  } as unknown as ExtensionContext;

  ampEditorExtension(pi);

  const messageUpdate = expectDefined(handlers.get("message_update"), "message_update handler should be registered");
  const toolExecutionStart = expectDefined(handlers.get("tool_execution_start"), "tool_execution_start handler should be registered");
  const toolExecutionEnd = expectDefined(handlers.get("tool_execution_end"), "tool_execution_end handler should be registered");

  // thinking_* stream deltas read as the reasoning phase.
  messageUpdate({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" }, message: { role: "assistant", content: [] } }, ctx);
  assert.deepEqual(workingMessages, ["Thinking"]);

  toolExecutionStart({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} }, ctx);
  assert.deepEqual(workingMessages, ["Thinking", "Using tools"]);

  messageUpdate({ type: "message_update", message: { role: "assistant", content: [] } }, ctx);
  assert.deepEqual(workingMessages, ["Thinking", "Using tools"]);

  toolExecutionEnd({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false }, ctx);
  assert.deepEqual(workingMessages, ["Thinking", "Using tools", "Waiting"]);

  const agentEnd = expectDefined(handlers.get("agent_end"), "agent_end handler should be registered");
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.deepEqual(workingMessages, ["Thinking", "Using tools", "Waiting"]);
});

test("amp editor renders working status without a cancel hint", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  ampEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  const ctx = {
    hasUI: true,
    cwd: "/tmp",
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: createSessionManager(),
    getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
    ui: {
      theme: createTaggedThemeStub(),
      setEditorComponent(factory: typeof editorFactory) {
        editorFactory = factory;
      },
      setWorkingIndicator() {},
      setWorkingMessage() {},
      setWorkingVisible() {},
      setFooter() {},
    },
  } as unknown as ExtensionContext;

  sessionStart({ type: "session_start", reason: "startup" }, ctx);
  const beforeAgentStart = expectDefined(handlers.get("before_agent_start"), "before_agent_start handler should be registered");
  beforeAgentStart({ type: "before_agent_start" }, ctx);

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createTaggedThemeStub(),
    { matches: () => false },
  );

  const rendered = editor.render(200).join("\n");
  assert.ok(rendered.includes("Waiting"));
  assert.ok(!rendered.includes("to cancel"));
});

test("amp editor applies the theme text color to typed input", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  ampEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[]; setText(text: string): void })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");
  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createTaggedThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingVisible() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createTaggedThemeStub(),
    { matches: () => false },
  );
  editor.setText("为啥老是报错？");

  assert.ok(editor.render(100).join("\n").includes("[text] 为啥老是报错？"));
});

test("amp editor uses latest context and cost after reload", () => {
  const { pi, handlers } = createPiStub(() => "high");

  ampEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  const createCtx = (percent: number, cost: number) => ({
    hasUI: true,
    cwd: process.cwd(),
    model: {
      id: "claude-sonnet-4-20250514",
      contextWindow: 272000,
      reasoning: true,
    },
    modelRegistry: { isUsingOAuth: () => true },
    sessionManager: createSessionManagerWithCost(cost),
    getContextUsage: () => ({ percent, contextWindow: 272000 }),
    ui: {
      theme: createThemeStub(),
      setEditorComponent(factory: typeof editorFactory) {
        editorFactory = factory;
      },
      setWorkingIndicator() {},
      setWorkingVisible() {},
      setWorkingMessage() {},
      setFooter() {},
    },
  }) as unknown as ExtensionContext;

  sessionStart({ type: "session_start", reason: "startup" }, createCtx(12, 1.23));
  const createEditor = expectDefined(editorFactory, "editor factory should be registered");

  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );

  assert.ok(editor.render(100).join("\n").includes("$1.23"));

  sessionStart({ type: "session_start", reason: "reload" }, createCtx(72, 16.37));

  assert.ok(editor.render(100).join("\n").includes("$16.37"));
});

test("amp editor border follows the runtime border color function", () => {
  const { pi, handlers } = createPiStub(() => "medium");

  ampEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[]; borderColor?: (text: string) => string })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingVisible() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");
  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );

  editor.borderColor = (text: string) => `[border]${text}`;

  assert.ok(editor.render(80).join("\n").includes("[border]╭"));
});

test("amp editor uses runtime thinking level after resume when session has no thinking entry", () => {
  const { pi, handlers } = createPiStub(() => "high");

  ampEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "resume" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManagerWithoutThinking(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingVisible() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");

  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );

  assert.match(editor.render(80).join("\n"), /· high/);
});

test("amp user message follows thinking_level_select changes after session start", () => {
  resetUserMessagePatch();

  let thinkingLevel = "off";
  const { pi, handlers } = createPiStub(() => thinkingLevel);

  ampUserMessageExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  thinkingLevel = "medium";
  const thinkingLevelSelect = expectDefined(handlers.get("thinking_level_select"), "thinking_level_select handler should be registered");
  thinkingLevelSelect({ level: "medium", previousLevel: "off" }, {} as ExtensionContext);

  const message = new UserMessageComponent("hello from amp");
  assert.match(message.render(48).join("\n"), /\[thinkingMedium\]▌/);

  resetUserMessagePatch();
});

test("amp user message uses runtime thinking level after resume when session has no thinking entry", () => {
  resetUserMessagePatch();

  const { pi, handlers } = createPiStub(() => "high");

  ampUserMessageExtension(pi);

  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "resume" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  const message = new UserMessageComponent("hello from amp");
  assert.match(message.render(48).join("\n"), /\[thinkingHigh\]▌/);

  resetUserMessagePatch();
});

test("amp user message refreshes prototype state after extension reload", () => {
  resetUserMessagePatch();

  let firstThinkingLevel = "low";
  const first = createPiStub(() => firstThinkingLevel);
  ampUserMessageExtension(first.pi);

  const firstSessionStart = expectDefined(first.handlers.get("session_start"), "first session_start handler should be registered");
  firstSessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[first:${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  const beforeReload = new UserMessageComponent("hello from amp");
  assert.match(beforeReload.render(48).join("\n"), /\[first:thinkingLow\]▌/);

  const second = createPiStub(() => "high");
  ampUserMessageExtension(second.pi);

  const secondSessionStart = expectDefined(second.handlers.get("session_start"), "second session_start handler should be registered");
  secondSessionStart(
    { type: "session_start", reason: "reload" },
    {
      hasUI: true,
      sessionManager: createSessionManagerWithoutThinking(),
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `[second:${color}]${text}`;
          },
          italic(text: string) {
            return text;
          },
        },
      },
    } as unknown as ExtensionContext,
  );

  firstThinkingLevel = "minimal";

  const afterReload = new UserMessageComponent("hello from amp");
  const rendered = afterReload.render(48).join("\n");
  assert.match(rendered, /\[second:thinkingHigh\]▌/);
  assert.doesNotMatch(rendered, /\[first:thinkingMinimal\]▌/);

  resetUserMessagePatch();
});

test("amp editor render stays safe after pi runtime becomes stale", () => {
  let stale = false;
  const { pi, handlers } = createPiStub(() => {
    if (stale) throw new Error("stale runtime");
    return "medium";
  });

  ampEditorExtension(pi);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => { render(width: number): string[] })
    | undefined;

  const theme = createThemeStub();
  const sessionStart = expectDefined(handlers.get("session_start"), "session_start handler should be registered");

  sessionStart(
    { type: "session_start", reason: "startup" },
    {
      hasUI: true,
      cwd: process.cwd(),
      model: {
        id: "claude-sonnet-4-20250514",
        contextWindow: 200000,
        reasoning: true,
      },
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: createSessionManager(),
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        theme,
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingVisible() {},
        setWorkingMessage() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  const createEditor = expectDefined(editorFactory, "editor factory should be registered");

  const editor = createEditor(
    { requestRender() {}, terminal: { rows: 24 } },
    theme,
    { matches: () => false },
  );

  assert.doesNotThrow(() => editor.render(80));

  stale = true;
  assert.doesNotThrow(() => editor.render(80));
});
