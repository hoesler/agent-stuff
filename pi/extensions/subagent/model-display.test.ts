import assert from "node:assert/strict";
import test from "node:test";
import { formatModelDisplay, resolveModelFromMessage, resolveModelSelection } from "./model-display.ts";

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
