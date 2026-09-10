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

test("leads each mode line with the model string, naming the mode only as orientation", () => {
  const catalog = formatModeCatalog(base);
  const lines = catalog.split("\n");
  assert.equal(lines.at(-2), "- `zai/glm-5.2:low` (mode: low) — Fast, low-cost mode for small, well-defined tasks");
  assert.equal(lines.at(-1), "- `openai/gpt-5.6-sol:medium` (mode: medium) — Balanced intelligence, speed, and cost");
});

/**
 * The confusion this guards against: an agent reads the routes list, correctly
 * generalises "the backticked token starting a line is what I pass", and
 * applies it to the modes list. That rule only stays true if a mode id never
 * holds that position — and, so the signal is unambiguous, is never backticked
 * anywhere in the block.
 */
test("a mode id is never presented as a passable value", () => {
  const catalog = formatModeCatalog(base, [{ key: "oracle", model: "anthropic/claude-fable-5:high" }]);
  for (const id of ["low", "medium"]) {
    assert.doesNotMatch(catalog, new RegExp("^- `" + id + "`", "m"), `mode "${id}" leads a line`);
    assert.doesNotMatch(catalog, new RegExp("`" + id + "`"), `mode "${id}" appears backticked`);
  }
  // The one list where a leading backticked key *is* the value to pass.
  assert.match(catalog, /^- `oracle`/m);
});

test("the intro rules mode names out as values in so many words", () => {
  assert.match(formatModeCatalog(base), /not a value this parameter accepts/);
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
  assert.equal(line, "- `test/m:medium` (mode: bare)");
  assert.doesNotMatch(line, /—\s*$/);
});

test("omits the routes section when no routes resolve", () => {
  assert.doesNotMatch(formatModeCatalog(base), /Routes/);
  assert.doesNotMatch(formatModeCatalog(base, []), /Routes/);
});

test("lists a resolved route by key, with its description and no model string", () => {
  const catalog = formatModeCatalog(base, [
    { key: "oracle", model: "anthropic/claude-fable-5:high", description: "a second-opinion model" },
  ]);
  assert.match(catalog, /Routes \(resolved for the active mode; pass the key, not a model string\):/);
  assert.equal(catalog.split("\n").at(-1), "- `oracle` — a second-opinion model");
  assert.doesNotMatch(catalog, /claude-fable-5/);
});

test("omits the trailing dash-description segment for a route with no description", () => {
  const catalog = formatModeCatalog(base, [{ key: "oracle", model: "anthropic/claude-fable-5:high" }]);
  const line = catalog.split("\n").at(-1)!;
  assert.equal(line, "- `oracle`");
  assert.doesNotMatch(line, /—\s*$/);
});
