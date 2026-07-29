import assert from "node:assert/strict";
import test from "node:test";
import { cycleOrder, hasExplicitModelSelection, inferActiveMode, isFreshSession } from "./mode-state.ts";
import type { ModeConfig } from "./types.ts";

const config: ModeConfig = {
  version: 1,
  defaultMode: "medium",
  modes: [
    { id: "low", label: "Low", provider: "zai", model: "glm", thinkingLevel: "low" },
    { id: "medium", label: "Medium", provider: "openai", model: "sol", thinkingLevel: "medium" },
    { id: "high", label: "High", provider: "openai", model: "sol", thinkingLevel: "high" },
  ],
};

test("active mode requires an exact model and effort triple", () => {
  assert.equal(
    inferActiveMode(config, { provider: "openai", model: "sol", thinkingLevel: "high" }).kind,
    "named",
  );
  assert.deepEqual(
    inferActiveMode(config, { provider: "openai", model: "sol", thinkingLevel: "low" }),
    { kind: "custom" },
  );
});

test("first duplicate triple wins", () => {
  const duplicate: ModeConfig = { ...config, modes: [...config.modes, { ...config.modes[2]!, id: "ultra" }] };
  const active = inferActiveMode(duplicate, { provider: "openai", model: "sol", thinkingLevel: "high" });
  assert.equal(active.kind === "named" ? active.mode.id : "", "high");
});

test("cycle order wraps and custom starts at the nearest edge", () => {
  const medium = { kind: "named" as const, mode: config.modes[1]! };
  assert.deepEqual(cycleOrder(config, medium, 1).map((m) => m.id), ["high", "low", "medium"]);
  assert.deepEqual(cycleOrder(config, medium, -1).map((m) => m.id), ["low", "high", "medium"]);
  assert.deepEqual(cycleOrder(config, { kind: "custom" }, 1).map((m) => m.id), ["low", "medium", "high"]);
  assert.deepEqual(cycleOrder(config, { kind: "custom" }, -1).map((m) => m.id), ["high", "medium", "low"]);
});

test("only startup without conversation and new sessions are fresh", () => {
  assert.equal(isFreshSession({ reason: "new" }, []), true);
  assert.equal(isFreshSession({ reason: "startup" }, [{ type: "model_change" }, { type: "thinking_level_change" }]), true);
  assert.equal(isFreshSession({ reason: "startup" }, [{ type: "message" }]), false);
  for (const reason of ["reload", "resume", "fork"] as const) {
    assert.equal(isFreshSession({ reason }, []), false);
  }
});

const argv = (...args: string[]): string[] => ["/usr/bin/node", "/opt/pi/main.js", ...args];

test("every flag that can select a model or effort counts as explicit", () => {
  for (const flag of ["--model", "--models", "--provider", "--thinking"]) {
    assert.equal(hasExplicitModelSelection(argv(flag, "value")), true, flag);
  }
});

test("an invocation without a selection flag is not explicit", () => {
  assert.equal(hasExplicitModelSelection(argv("--mode", "json", "-p", "--no-session", "Task: hi")), false);
  assert.equal(hasExplicitModelSelection(argv()), false);
});

test("only a standalone flag token counts, and only when pi would consume its value", () => {
  // A prompt that merely mentions a flag must not look like a selection.
  assert.equal(hasExplicitModelSelection(argv("Task: what does --model do?")), false);
  // pi's parser matches the exact token and requires a following value, so
  // neither "--model=x" nor a trailing "--model" selects anything.
  assert.equal(hasExplicitModelSelection(argv("--model=openai/gpt-5.5")), false);
  assert.equal(hasExplicitModelSelection(argv("--model")), false);
});
