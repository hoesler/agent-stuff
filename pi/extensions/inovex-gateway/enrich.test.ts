import assert from "node:assert/strict";
import { test } from "node:test";
import { type Catalog, type CatalogModel, normalize, toProviderModels } from "./enrich.ts";
import type { GatewayModel } from "./gateway.ts";

const cost = (input: number) => ({ input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25 });

const model = (id: string, contextWindow: number, over: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  input: ["text", "image"],
  reasoning: true,
  contextWindow,
  maxTokens: 64_000,
  cost: cost(1),
  ...over,
});

const CATALOG_MODELS: Record<string, CatalogModel[]> = {
  anthropic: [model("claude-opus-5-5", 1_000_000, { promptCache: { short: 300 }, cost: cost(5) })],
  google: [model("gemini-3.8-flash", 1_048_576)],
  baseten: [model("moonshotai/Kimi-K3", 1_048_576)],
  openrouter: [
    model("moonshotai/kimi-k3", 262_144, { promptCache: { short: 300 } }),
    model("nvidia/nemotron-3-super-120b-a12b", 262_144),
  ],
};

const catalog: Catalog = {
  providers: Object.keys(CATALOG_MODELS),
  models: (provider) => CATALOG_MODELS[provider] ?? [],
};

const one = (entry: GatewayModel) => {
  const [result] = toProviderModels([entry], catalog);
  assert.ok(result);
  return result;
};

test("a Claude model takes anthropic's entry and speaks anthropic-messages at the gateway root", () => {
  const m = one({ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", ownedBy: "anthropic" });
  assert.equal(m.id, "anthropic/claude-opus-5-5");
  assert.equal(m.name, "Claude Opus 5.5");
  assert.equal(m.api, "anthropic-messages");
  assert.equal(m.baseUrl, "https://gateway.inovex.ai");
  assert.equal(m.contextWindow, 1_000_000);
  assert.equal(m.cost.input, 5);
  assert.deepEqual(m.promptCache, { short: 300 });
});

test("a Gemini model takes google's entry and stays on the provider's openai-completions", () => {
  const m = one({ id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", ownedBy: "google" });
  assert.equal(m.api, undefined);
  assert.equal(m.baseUrl, undefined);
  assert.equal(m.contextWindow, 1_048_576);
});

test("an open model matches OpenRouter by full id, case-insensitively, before other hosts", () => {
  const m = one({ id: "moonshotai/Kimi-K3", name: "Kimi K3", ownedBy: "nebul" });
  assert.equal(m.contextWindow, 262_144);
});

test("precision suffixes and repeated vendor names do not stop a match", () => {
  assert.equal(normalize("nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16"), "nemotron-3-super-120b-a12b");
  assert.equal(normalize("Qwen/Qwen3.8-27B-FP8"), "qwen3.8-27b");
  const m = one({ id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16", name: "Nemotron", ownedBy: "nebul" });
  assert.equal(m.contextWindow, 262_144);
});

test("an unknown model gets conservative defaults and no price", () => {
  const m = one({ id: "anthropic/claude-mythos-5-1", name: "Claude Mythos 5.1", ownedBy: "anthropic" });
  assert.deepEqual(m.input, ["text"]);
  assert.equal(m.contextWindow, 128_000);
  assert.equal(m.maxTokens, 8192);
  assert.equal(m.reasoning, false);
  assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(m.api, "anthropic-messages");
});

test("a non-anthropic match never carries a prompt cache lifetime", () => {
  const m = one({ id: "moonshotai/Kimi-K3", name: "Kimi K3", ownedBy: "nebul" });
  assert.equal(m.promptCache, undefined);
});

test("a Claude model keeps anthropic's request compat, minus the fallback models only Anthropic's own API serves", () => {
  const compat = { forceAdaptiveThinking: true, supportsTemperature: false, allowedFallbackModels: [] } as unknown as CatalogModel["compat"];
  const withCompat: Catalog = {
    providers: ["anthropic"],
    models: () => [model("claude-opus-5-5", 1_000_000, { compat })],
  };
  const [m] = toProviderModels([{ id: "anthropic/claude-opus-5-5", name: "Opus", ownedBy: "anthropic" }], withCompat);
  assert.deepEqual(m.compat, { forceAdaptiveThinking: true, supportsTemperature: false });
});

test("a Claude model matched at another host takes neither its compat nor its cache lifetime", () => {
  const elsewhere: Catalog = {
    providers: ["anthropic", "openrouter"],
    models: (provider) =>
      provider === "openrouter"
        ? [model("anthropic/claude-mythos-5-1", 1_000_000, { promptCache: { short: 300 }, compat: { supportsTemperature: false } as CatalogModel["compat"] })]
        : [],
  };
  const [m] = toProviderModels([{ id: "anthropic/claude-mythos-5-1", name: "Mythos", ownedBy: "anthropic" }], elsewhere);
  assert.equal(m.contextWindow, 1_000_000);
  assert.equal(m.compat, undefined);
  assert.equal(m.promptCache, undefined);
});
