import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCopilotLimits, copilotApiBaseUrl, enterpriseDomain, parseCopilotLimits } from "./limits.ts";

const token = (proxy: string) => `tid=abc;exp=1;proxy-ep=${proxy};sku=free`;

test("the account's own proxy host names the API host", () => {
  assert.equal(copilotApiBaseUrl(token("proxy.individual.githubcopilot.com")), "https://api.individual.githubcopilot.com");
  assert.equal(copilotApiBaseUrl(token("proxy.business.githubcopilot.com")), "https://api.business.githubcopilot.com");
});

test("a proxy host that is not prefixed is used as it stands", () => {
  assert.equal(copilotApiBaseUrl(token("copilot-proxy.example.com")), "https://copilot-proxy.example.com");
});

test("the token wins over the configured enterprise domain, because it names the account's real endpoint", () => {
  assert.equal(copilotApiBaseUrl(token("proxy.individual.githubcopilot.com"), "ghe.example.com"), "https://api.individual.githubcopilot.com");
});

test("an enterprise domain carries a token that has no proxy-ep", () => {
  assert.equal(copilotApiBaseUrl("opaque-token", "ghe.example.com"), "https://copilot-api.ghe.example.com");
});

test("with neither, the individual endpoint is the fallback", () => {
  assert.equal(copilotApiBaseUrl(undefined), "https://api.individual.githubcopilot.com");
  assert.equal(copilotApiBaseUrl(""), "https://api.individual.githubcopilot.com");
});

test("an enterprise is reduced to its hostname, however it was written down", () => {
  assert.equal(enterpriseDomain("ghe.example.com"), "ghe.example.com");
  assert.equal(enterpriseDomain("https://ghe.example.com"), "ghe.example.com");
  assert.equal(enterpriseDomain("https://ghe.example.com/enterprises/acme"), "ghe.example.com");
  assert.equal(enterpriseDomain("  ghe.example.com  "), "ghe.example.com");
});

test("an absent or unreadable enterprise is simply not one", () => {
  for (const value of [undefined, null, "", "   ", 42, "http://"]) {
    assert.equal(enterpriseDomain(value), undefined);
  }
});

const catalog = (...models: unknown[]) => ({ data: models });
const model = (id: string, contextWindow: number, maxOutput: number) => ({
  id,
  capabilities: { limits: { max_context_window_tokens: contextWindow, max_output_tokens: maxOutput } },
});

test("a model's reported limits are read from its capabilities", () => {
  const limits = parseCopilotLimits(catalog(model("gpt-5.4", 1_000_000, 128_000)));
  assert.deepEqual(limits.get("gpt-5.4"), { contextWindow: 1_000_000, maxTokens: 128_000 });
});

test("a model is indexed under its date-suffixed id and its base name alike", () => {
  const limits = parseCopilotLimits(catalog(model("gpt-4.1-2025-04-14", 128_000, 16_384)));
  assert.deepEqual(limits.get("gpt-4.1-2025-04-14"), { contextWindow: 128_000, maxTokens: 16_384 });
  assert.deepEqual(limits.get("gpt-4.1"), { contextWindow: 128_000, maxTokens: 16_384 });
});

test("an exact id is never overwritten by another model's base name", () => {
  const limits = parseCopilotLimits(catalog(model("gpt-4.1", 111, 11), model("gpt-4.1-2025-04-14", 222, 22)));
  assert.deepEqual(limits.get("gpt-4.1"), { contextWindow: 111, maxTokens: 11 });
});

test("a model that reports only one of the two limits is left to pi's own value", () => {
  const limits = parseCopilotLimits(
    catalog(
      { id: "half", capabilities: { limits: { max_context_window_tokens: 200_000 } } },
      { id: "none", capabilities: {} },
      { id: "bare" },
    ),
  );
  assert.equal(limits.size, 0);
});

test("limits that are not positive whole numbers are not believed", () => {
  const limits = parseCopilotLimits(
    catalog(model("zero", 0, 100), model("negative", -1, 100), model("fractional", 1.5, 100), model("stringly", "200000" as never, 100)),
  );
  assert.equal(limits.size, 0);
});

test("a payload that is not a catalog yields nothing rather than throwing", () => {
  for (const payload of [undefined, null, 42, "data", {}, { data: null }, { data: {} }, { data: [null, 7, { }] }]) {
    assert.equal(parseCopilotLimits(payload).size, 0);
  }
});

const builtIn = [
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 400_000, maxTokens: 64_000 },
  { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000, maxTokens: 32_000 },
];

test("a model the API reported takes the API's limits", () => {
  const patched = applyCopilotLimits(builtIn, new Map([["gpt-5.4", { contextWindow: 1_000_000, maxTokens: 128_000 }]]));
  assert.deepEqual(patched[0], { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1_000_000, maxTokens: 128_000 });
});

test("a model the API did not report keeps pi's own limits", () => {
  const patched = applyCopilotLimits(builtIn, new Map([["gpt-5.4", { contextWindow: 1_000_000, maxTokens: 128_000 }]]));
  assert.deepEqual(patched[1], { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000, maxTokens: 32_000 });
});

// The regression that made this extension worth rewriting: the old version dropped
// every model the API did not list, which silently emptied pi's picker.
test("no model is ever dropped, whatever the API reported", () => {
  assert.deepEqual(applyCopilotLimits(builtIn, new Map()).map((m) => m.id), ["gpt-5.4", "claude-opus-5"]);
  assert.deepEqual(
    applyCopilotLimits(builtIn, new Map([["a-model-pi-does-not-ship", { contextWindow: 1, maxTokens: 1 }]])).map((m) => m.id),
    ["gpt-5.4", "claude-opus-5"],
  );
});

test("pi's own catalog objects are left untouched", () => {
  const original = structuredClone(builtIn);
  const patched = applyCopilotLimits(builtIn, new Map([["gpt-5.4", { contextWindow: 1_000_000, maxTokens: 128_000 }]]));
  assert.deepEqual(builtIn, original);
  assert.notEqual(patched[0], builtIn[0]);
});
