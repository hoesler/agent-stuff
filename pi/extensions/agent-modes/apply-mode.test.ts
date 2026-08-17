import assert from "node:assert/strict";
import test from "node:test";
import { applyMode, preflightMode, type ApplyRuntime } from "./apply-mode.ts";
import type { ModeDefinition, ModeModel, ThinkingLevel } from "./types.ts";

const oldModel: ModeModel = { provider: "openai", id: "old", reasoning: true };
const targetModel: ModeModel = { provider: "openai", id: "sol", reasoning: true };
const mode: ModeDefinition = {
  id: "high",
  label: "High",
  provider: "openai",
  model: "sol",
  thinkingLevel: "high",
};

function fake(overrides: Partial<ApplyRuntime> = {}): ApplyRuntime {
  let currentModel = oldModel;
  let thinking: ThinkingLevel = "medium";
  return {
    findModel: (provider, id) => provider === "openai" && id === "sol" ? targetModel : undefined,
    getCurrentModel: () => currentModel,
    getThinkingLevel: () => thinking,
    setModel: async (model) => { currentModel = model; return true; },
    setThinkingLevel: (level) => { thinking = level; },
    ...overrides,
  };
}

test("applies model before thinking and verifies the effective level", async () => {
  const calls: string[] = [];
  let thinking: ThinkingLevel = "medium";
  const result = await applyMode(fake({
    setModel: async () => { calls.push("model"); return true; },
    setThinkingLevel: (level) => { calls.push(`thinking:${level}`); thinking = level; },
    getThinkingLevel: () => thinking,
  }), mode);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["model", "thinking:high"]);
});

test("model auth failure never changes thinking", async () => {
  let thinkingSet = false;
  const result = await applyMode(fake({
    setModel: async () => false,
    setThinkingLevel: () => { thinkingSet = true; },
  }), mode);
  assert.equal(result.ok, false);
  assert.equal(thinkingSet, false);
});

test("rejects missing, non-reasoning, and explicitly unsupported models", async () => {
  const missing = await applyMode(fake({ findModel: () => undefined }), mode);
  const nonReasoning = await applyMode(fake({ findModel: () => ({ ...targetModel, reasoning: false }) }), mode);
  const unsupported = await applyMode(fake({ findModel: () => ({ ...targetModel, thinkingLevelMap: { high: null } }) }), mode);

  assert.equal(missing.ok, false);
  assert.equal(nonReasoning.ok, false);
  assert.equal(unsupported.ok, false);
  if (missing.ok || nonReasoning.ok || unsupported.ok) return assert.fail("expected preflight failures");
  assert.match(missing.message, /not found/);
  assert.match(nonReasoning.message, /does not support reasoning/);
  assert.match(unsupported.message, /does not support thinking level high/);
});

test("returns the thrown model error without changing thinking", async () => {
  let thinkingSet = false;
  const result = await applyMode(fake({
    setModel: async () => { throw new Error("model connection lost"); },
    setThinkingLevel: () => { thinkingSet = true; },
  }), mode);
  assert.deepEqual(result, {
    ok: false,
    mode,
    stage: "model",
    message: "model connection lost",
    stateChanged: false,
    rollbackSucceeded: true,
  });
  assert.equal(thinkingSet, false);
});

test("rolls back when the effective thinking level is clamped", async () => {
  let currentModel = oldModel;
  let thinking: ThinkingLevel = "medium";
  const result = await applyMode(fake({
    getCurrentModel: () => currentModel,
    getThinkingLevel: () => thinking,
    setModel: async (model) => { currentModel = model; return true; },
    setThinkingLevel: (level) => { thinking = level === "high" ? "medium" : level; },
  }), mode);
  assert.deepEqual(result, {
    ok: false,
    mode,
    stage: "thinking",
    message: "thinking level high was clamped to medium",
    stateChanged: false,
    rollbackSucceeded: true,
  });
  assert.equal(currentModel, oldModel);
  assert.equal(thinking, "medium");
});

test("reports failed rollback after a clamped thinking level", async () => {
  let calls = 0;
  const result = await applyMode(fake({
    setModel: async () => ++calls === 1,
    setThinkingLevel: () => {},
    getThinkingLevel: () => "medium",
  }), mode);
  assert.deepEqual(result, {
    ok: false,
    mode,
    stage: "rollback",
    message: "thinking level high was clamped to medium",
    stateChanged: true,
    rollbackSucceeded: false,
  });
});

test("accepts off for a non-reasoning model", async () => {
  const offMode = { ...mode, thinkingLevel: "off" as const };
  const runtime = fake({ findModel: () => ({ ...targetModel, reasoning: false }) });
  assert.equal(preflightMode(runtime, offMode), undefined);
  assert.equal((await applyMode(runtime, offMode)).ok, true);
});
