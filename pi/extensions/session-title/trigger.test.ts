import assert from "node:assert/strict";
import test from "node:test";
import { resolveTitlingModel, shouldTitleOnSettle } from "./trigger.ts";

const base = { hasUI: true, configured: true, enabled: true, titled: false };

test("titles a fresh UI session with a configured, enabled model", () => {
  assert.equal(shouldTitleOnSettle(base), true);
});

test("does not title without a UI", () => {
  assert.equal(shouldTitleOnSettle({ ...base, hasUI: false }), false);
});

test("does not title without a configured model", () => {
  assert.equal(shouldTitleOnSettle({ ...base, configured: false }), false);
});

test("does not title when disabled", () => {
  assert.equal(shouldTitleOnSettle({ ...base, enabled: false }), false);
});

test("does not title an already-titled session", () => {
  assert.equal(shouldTitleOnSettle({ ...base, titled: true }), false);
});

test("resolveTitlingModel splits provider and model id", () => {
  const found = { provider: "copilot", id: "gpt-5-mini" };
  const registry = {
    find: (provider: string, id: string) =>
      provider === "copilot" && id === "gpt-5-mini" ? found : undefined,
  };
  assert.equal(resolveTitlingModel(registry, "copilot/gpt-5-mini"), found);
});

test("resolveTitlingModel keeps slashes in the model id", () => {
  let seen: string[] = [];
  const registry = {
    find: (provider: string, id: string) => {
      seen = [provider, id];
      return undefined;
    },
  };
  resolveTitlingModel(registry, "openrouter/vendor/model-1");
  assert.deepEqual(seen, ["openrouter", "vendor/model-1"]);
});

test("resolveTitlingModel returns undefined for a malformed string", () => {
  const registry = { find: () => ({ provider: "x", id: "y" }) };
  assert.equal(resolveTitlingModel(registry, "nope"), undefined);
  assert.equal(resolveTitlingModel(registry, "/y"), undefined);
  assert.equal(resolveTitlingModel(registry, "x/"), undefined);
});
