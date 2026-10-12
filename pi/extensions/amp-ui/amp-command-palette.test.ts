import assert from "node:assert/strict";
import { test, mock } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import ampEditorExtension from "./amp-editor.ts";
import { CommandPaletteOverlay, stripAnsi, type CommandPaletteItem, type CommandPaletteResult } from "./amp-command-palette.ts";

type ThemeStub = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type AmpEditorLike = {
  handleInput(data: string): void;
  getText(): string;
  onSubmit?: (text: string) => void;
};

function createThemeStub(): ThemeStub {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

function createOverlay(items: CommandPaletteItem[], initialQuery = ""): CommandPaletteOverlay {
  return new CommandPaletteOverlay(
    items,
    initialQuery,
    { requestRender() {} } as never,
    createThemeStub() as never,
    { matches: () => false } as never,
    () => {},
  );
}

function createPaletteKeybindings() {
  return {
    matches(data: string, action: string) {
      return (data === "tab" && action === "tui.input.tab") || (data === "enter" && action === "tui.select.confirm");
    },
  };
}

function pickPaletteItem(item: CommandPaletteItem, key: "tab" | "enter"): CommandPaletteResult | null | undefined {
  let result: CommandPaletteResult | null | undefined;
  new CommandPaletteOverlay([item], "", { requestRender() {} } as never, createThemeStub() as never, createPaletteKeybindings() as never, (value) => {
    result = value;
  }).handleInput(key);
  return result;
}

function createAmpEditor(paletteResult: CommandPaletteResult): AmpEditorLike {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      handlers.set(event, handler);
    },
    getThinkingLevel: () => "medium",
    getCommands: () => [],
  };

  ampEditorExtension(pi as never);

  let editorFactory:
    | ((tui: unknown, theme: ThemeStub, keybindings: { matches(): boolean }) => AmpEditorLike)
    | undefined;

  const sessionStart = handlers.get("session_start");
  assert.notEqual(sessionStart, undefined);

  sessionStart?.(
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
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => undefined,
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ percent: 12, contextWindow: 200000 }),
      ui: {
        custom: () => Promise.resolve(paletteResult),
        theme: createThemeStub(),
        setEditorComponent(factory: typeof editorFactory) {
          editorFactory = factory;
        },
        setWorkingIndicator() {},
        setWorkingMessage() {},
        setWorkingVisible() {},
        setFooter() {},
      },
    } as unknown as ExtensionContext,
  );

  assert.notEqual(editorFactory, undefined);
  return editorFactory!(
    { requestRender() {}, terminal: { rows: 24 } },
    createThemeStub(),
    { matches: () => false },
  );
}

test("command palette renders multiline descriptions as one terminal row", () => {
  const overlay = createOverlay([
    {
      name: "skill:pi-subagents",
      source: "skill",
      description: "Delegate work.\nContinue safely.",
    },
  ]);

  const rendered = overlay.render(96).map(stripAnsi);

  assert.equal(rendered.every((line) => !/[\r\n]/.test(line)), true);
  assert.ok(rendered.join("\n").includes("Delegate work. Continue safely."));
});

for (const [item, expectedAction] of [
  [{ name: "settings", source: "builtin" }, "submit"],
  [{ name: "btw:new", source: "extension" }, "submit"],
  [{ name: "skill:pi-subagents", source: "skill" }, "insert"],
  [{ name: "component", source: "prompt" }, "insert"],
] satisfies Array<[CommandPaletteItem, CommandPaletteResult["action"]]>) {
  test(`command palette enter action follows command source for ${item.name}`, () => {
    assert.deepEqual(pickPaletteItem(item, "enter"), { command: item.name, action: expectedAction });
  });
}

for (const item of [
  { name: "settings", source: "builtin" },
  { name: "btw:new", source: "extension" },
  { name: "skill:pi-subagents", source: "skill" },
  { name: "component", source: "prompt" },
] satisfies CommandPaletteItem[]) {
  test(`command palette tab always inserts ${item.name}`, () => {
    assert.deepEqual(pickPaletteItem(item, "tab"), { command: item.name, action: "insert" });
  });
}

test("submitting a command from the palette matches native slash completion", async () => {
  const editor = createAmpEditor({ command: "compact", action: "submit" });
  const onSubmit = mock.fn();
  editor.onSubmit = onSubmit;

  editor.handleInput("/");
  await Promise.resolve();

  assert.deepEqual(onSubmit.mock.calls.at(-1)?.arguments, ["/compact"]);
  assert.equal(editor.getText(), "");
});

test("inserting a command from the palette leaves it editable without submitting", async () => {
  const editor = createAmpEditor({ command: "compact", action: "insert" });
  const onSubmit = mock.fn();
  editor.onSubmit = onSubmit;

  editor.handleInput("/");
  await Promise.resolve();

  assert.equal(onSubmit.mock.callCount(), 0);
  assert.equal(editor.getText(), "/compact ");
});
