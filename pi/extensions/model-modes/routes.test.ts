import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoutes, routeModelString } from "./routes.ts";
import type { ActiveMode, ModeConfig, ThinkingLevel } from "./types.ts";

const fable = { provider: "anthropic", model: "claude-fable-5", thinkingLevel: "high" } as const;

const config: ModeConfig = {
  version: 1,
  defaultMode: "medium",
  defaultRoutes: { oracle: { ...fable } },
  modes: [
    { id: "low", label: "Low", provider: "zai", model: "glm-5.2", thinkingLevel: "low", routes: { oracle: false } },
    { id: "medium", label: "Medium", provider: "openai", model: "gpt-5.6-sol", thinkingLevel: "medium" },
    {
      id: "high",
      label: "High",
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      routes: { oracle: { provider: "google", model: "gemini-4", thinkingLevel: "max", description: "a different vantage point" } },
    },
  ],
};

const named = (id: string): ActiveMode => ({ kind: "named", mode: config.modes.find((m) => m.id === id)! });
const live = (provider: string, model: string, thinkingLevel: ThinkingLevel) => ({ provider, model, thinkingLevel });

test("renders a target as provider/model:thinkingLevel", () => {
  assert.equal(routeModelString({ ...fable }), "anthropic/claude-fable-5:high");
});

test("omits the suffix for thinkingLevel off", () => {
  assert.equal(routeModelString({ provider: "p", model: "m", thinkingLevel: "off" }), "p/m");
});

test("a mode's own target wins over defaultRoutes", () => {
  const routes = resolveRoutes(config, named("high"), live("openai", "gpt-5.6-sol", "high"));
  assert.deepEqual(routes, [{ key: "oracle", model: "google/gemini-4:max", description: "a different vantage point" }]);
});

test("falls back to defaultRoutes when the mode declares none", () => {
  const routes = resolveRoutes(config, named("medium"), live("openai", "gpt-5.6-sol", "medium"));
  assert.deepEqual(routes, [{ key: "oracle", model: "anthropic/claude-fable-5:high" }]);
});

test("false in the active mode overrides a default", () => {
  assert.deepEqual(resolveRoutes(config, named("low"), live("zai", "glm-5.2", "low")), []);
});

test("mode:custom falls back to defaultRoutes", () => {
  assert.deepEqual(resolveRoutes(config, { kind: "custom" }, live("openai", "o9", "low")), [
    { key: "oracle", model: "anthropic/claude-fable-5:high" },
  ]);
});

test("mode:error falls back to defaultRoutes", () => {
  assert.deepEqual(resolveRoutes(config, { kind: "error" }, live("openai", "o9", "low")), [
    { key: "oracle", model: "anthropic/claude-fable-5:high" },
  ]);
});

test("suppresses a route whose target equals the live triple", () => {
  assert.deepEqual(resolveRoutes(config, { kind: "custom" }, live("anthropic", "claude-fable-5", "high")), []);
});

test("does not suppress when only the thinking level differs", () => {
  const routes = resolveRoutes(config, { kind: "custom" }, live("anthropic", "claude-fable-5", "low"));
  assert.equal(routes.length, 1);
});

test("returns nothing when no routes are configured", () => {
  const bare: ModeConfig = { version: 1, defaultMode: "medium", modes: [config.modes[1]!] };
  assert.deepEqual(resolveRoutes(bare, named("medium"), live("openai", "gpt-5.6-sol", "medium")), []);
});

test("sorts keys so the catalog is stable across turns", () => {
  const many: ModeConfig = {
    version: 1,
    defaultMode: "medium",
    defaultRoutes: {
      zebra: { provider: "p", model: "z", thinkingLevel: "off" },
      alpha: { provider: "p", model: "a", thinkingLevel: "off" },
    },
    modes: [config.modes[1]!],
  };
  assert.deepEqual(
    resolveRoutes(many, named("medium"), live("openai", "gpt-5.6-sol", "medium")).map((r) => r.key),
    ["alpha", "zebra"],
  );
});
