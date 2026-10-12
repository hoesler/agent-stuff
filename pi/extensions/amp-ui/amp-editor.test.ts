import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatusTopLeft, formatStatusTopRight } from "./amp-editor.ts";

test("groups model and thinking together", () => {
  assert.equal(formatStatusTopRight({ model: "sonnet-4", thinking: "high", fg: (_c, t) => t }), "sonnet-4 · high");
});

test("omits the model when none is set", () => {
  assert.equal(formatStatusTopRight({ model: "", thinking: "off", fg: (_c, t) => t }), "off");
});

test("keeps context usage out of the top-right", () => {
  assert.ok(!formatStatusTopRight({ model: "sonnet-4", thinking: "high", fg: (_c, t) => t }).includes("%"));
});

test("prepends a third-party status label before the model", () => {
  assert.equal(formatStatusTopRight({ model: "sonnet-4", thinking: "high", statusLabel: "mode:high", fg: (_c, t) => t }), "mode:high · sonnet-4 · high");
});

test("ignores an empty status label", () => {
  assert.equal(formatStatusTopRight({ model: "sonnet-4", thinking: "high", statusLabel: "", fg: (_c, t) => t }), "sonnet-4 · high");
});

test("shows context usage explicitly against the window, then the cost", () => {
  assert.equal(formatStatusTopLeft({ contextPercent: 45.6, contextWindow: 200_000, cost: 0.123 }), "45% of 200k · $0.123");
});

test("floors the percent rather than rounding it up", () => {
  assert.equal(formatStatusTopLeft({ contextPercent: 45.9, contextWindow: 200_000, cost: 0 }), "45% of 200k · $0.000");
});

test("renders ? for the percent when usage is unknown", () => {
  assert.equal(formatStatusTopLeft({ contextPercent: null, contextWindow: 200_000, cost: 0.5 }), "? of 200k · $0.500");
  assert.equal(formatStatusTopLeft({ contextWindow: 200_000, cost: 0.5 }), "? of 200k · $0.500");
});

test("renders ? for the window when its size is unknown", () => {
  assert.equal(formatStatusTopLeft({ contextPercent: 10, contextWindow: null, cost: 0 }), "10% of ? · $0.000");
});

test("formats context windows in m, k, or raw tokens", () => {
  assert.equal(formatStatusTopLeft({ contextPercent: 1, contextWindow: 1_000_000, cost: 0 }), "1% of 1.0m · $0.000");
  assert.equal(formatStatusTopLeft({ contextPercent: 1, contextWindow: 128_000, cost: 0 }), "1% of 128k · $0.000");
  assert.equal(formatStatusTopLeft({ contextPercent: 1, contextWindow: 512, cost: 0 }), "1% of 512 · $0.000");
});

test("clamps a negative percent to zero", () => {
  assert.equal(formatStatusTopLeft({ contextPercent: -3, contextWindow: 200_000, cost: 0 }), "0% of 200k · $0.000");
});
