import assert from "node:assert/strict";
import test from "node:test";
import { formatModeCatalog } from "./catalog.ts";
import type { ModeConfig } from "./types.ts";

const base: ModeConfig = {
  version: 1,
  defaultMode: "medium",
  modes: [
    { id: "low", label: "Low", provider: "zai", model: "glm-5.2", thinkingLevel: "low", description: "Fast, low-cost mode for small, well-defined tasks" },
    { id: "medium", label: "Medium", provider: "openai", model: "gpt-5.6-sol", thinkingLevel: "medium", description: "Balanced intelligence, speed, and cost" },
  ],
};

test("formats each mode as id, provider/model:thinkingLevel, and description in array order", () => {
  const catalog = formatModeCatalog(base);
  const lines = catalog.split("\n");
  assert.equal(lines.at(-2), "- `low` → `zai/glm-5.2:low` — Fast, low-cost mode for small, well-defined tasks");
  assert.equal(lines.at(-1), "- `medium` → `openai/gpt-5.6-sol:medium` — Balanced intelligence, speed, and cost");
});

test("includes guidance naming the subagent tool's model parameter", () => {
  const catalog = formatModeCatalog(base);
  assert.match(catalog, /subagent.*tool.*`model`/s);
});

test("omits the :thinkingLevel suffix for off", () => {
  const catalog = formatModeCatalog({
    ...base,
    modes: [{ id: "off-mode", provider: "test", model: "m", thinkingLevel: "off", label: "Off" }],
  });
  assert.match(catalog, /`test\/m`/);
  assert.doesNotMatch(catalog, /`test\/m:off`/);
});

test("omits the trailing dash-description segment when a mode has no description", () => {
  const catalog = formatModeCatalog({
    ...base,
    modes: [{ id: "bare", provider: "test", model: "m", thinkingLevel: "medium", label: "Bare" }],
  });
  const line = catalog.split("\n").at(-1)!;
  assert.equal(line, "- `bare` → `test/m:medium`");
  assert.doesNotMatch(line, /—\s*$/);
});
