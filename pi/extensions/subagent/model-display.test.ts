import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModelDisplay,
  resolveModelFromMessage,
  resolveModelSelection,
  splitThinkingLevel,
} from "./model-display.ts";

test("per-task override takes precedence and reports [agent]", () => {
  const selection = resolveModelSelection("ultra", "medium", "frontmatter-model");
  assert.deepEqual(selection, { model: "ultra", source: "agent" });
});

test("whole-call override applies when no per-task model and reports [agent]", () => {
  const selection = resolveModelSelection(undefined, "medium", "frontmatter-model");
  assert.deepEqual(selection, { model: "medium", source: "agent" });
});

test("persona frontmatter applies when no task/call model and reports [frontmatter]", () => {
  const selection = resolveModelSelection(undefined, undefined, "frontmatter-model");
  assert.deepEqual(selection, { model: "frontmatter-model", source: "frontmatter" });
});

test("no explicit model anywhere reports [pi-default]", () => {
  const selection = resolveModelSelection(undefined, undefined, undefined);
  assert.deepEqual(selection, { model: undefined, source: "pi-default" });
});

test("a requested alias is replaced by the child message's canonical provider/model", () => {
  const resolved = resolveModelFromMessage({ provider: "github-copilot", model: "claude-sonnet-5" });
  const display = formatModelDisplay("ultra", "agent", resolved);
  assert.equal(display, "github-copilot/claude-sonnet-5 [agent]");
});

test("responseModel takes precedence over msg.model when present", () => {
  const resolved = resolveModelFromMessage({
    provider: "github-copilot",
    model: "gpt-5.6-sol",
    responseModel: "gpt-5.6-sol-2026-01-01",
  });
  assert.equal(resolved, "github-copilot/gpt-5.6-sol-2026-01-01");
});

test("no provider yields no resolved model", () => {
  assert.equal(resolveModelFromMessage({ model: "claude-sonnet-5" }), undefined);
});

test("fallback to requested model when child produces no assistant message", () => {
  const display = formatModelDisplay("ultra", "agent", undefined);
  assert.equal(display, "ultra [agent]");
});

test("fallback marker when no explicit model was supplied and no assistant message arrived", () => {
  const display = formatModelDisplay(undefined, "pi-default", undefined);
  assert.equal(display, "(unresolved) [pi-default]");
});

test("resolved model always wins over the requested alias once available", () => {
  const display = formatModelDisplay("ultra", "agent", "github-copilot/claude-sonnet-5");
  assert.equal(display, "github-copilot/claude-sonnet-5 [agent]");
});

test("a trailing thinking level is split off the requested model", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(splitThinkingLevel(`github-copilot/claude-sonnet-5:${level}`), {
      model: "github-copilot/claude-sonnet-5",
      thinkingLevel: level,
    });
  }
});

test("colons that are not a thinking level stay part of the model id", () => {
  // Real ids carry colons: OpenRouter variants and Ollama-style tags.
  for (const id of ["openrouter/openai/gpt-4o:extended", "ollama/llama3.1:8b"]) {
    assert.deepEqual(splitThinkingLevel(id), { model: id, thinkingLevel: undefined });
  }
  assert.deepEqual(splitThinkingLevel("ultra"), { model: "ultra", thinkingLevel: undefined });
  assert.deepEqual(splitThinkingLevel(undefined), { model: undefined, thinkingLevel: undefined });
});

test("only the last colon is treated as the thinking level separator", () => {
  assert.deepEqual(splitThinkingLevel("ollama/llama3.1:8b:high"), {
    model: "ollama/llama3.1:8b",
    thinkingLevel: "high",
  });
});

test("the requested effort survives onto the resolved model, which cannot report it", () => {
  const resolved = resolveModelFromMessage({ provider: "github-copilot", model: "claude-sonnet-5" });
  const display = formatModelDisplay("github-copilot/claude-sonnet-5:high", "agent", resolved);
  assert.equal(display, "github-copilot/claude-sonnet-5:high [agent]");
});

test("effort requested against an alias is kept when the alias resolves", () => {
  const display = formatModelDisplay("ultra:max", "agent", "anthropic/claude-opus-4-8");
  assert.equal(display, "anthropic/claude-opus-4-8:max [agent]");
});

test("the requested model is shown verbatim when no assistant message arrived", () => {
  assert.equal(formatModelDisplay("ultra:max", "agent", undefined), "ultra:max [agent]");
});

test("no effort is invented when none was requested", () => {
  assert.equal(
    formatModelDisplay("github-copilot/claude-sonnet-5", "agent", "github-copilot/claude-sonnet-5"),
    "github-copilot/claude-sonnet-5 [agent]",
  );
  assert.equal(formatModelDisplay(undefined, "pi-default", "openai/gpt-5.5"), "openai/gpt-5.5 [pi-default]");
});
