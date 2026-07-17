import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, formatModeList, inspectConfig } from "./doctor.ts";
import type { ConfigSnapshot, ModeConfig, ModeModel } from "./types.ts";

const snapshot: ConfigSnapshot = {
  ok: true,
  path: "/tmp/modes.json",
  fromEnvironment: true,
  fingerprint: "1:1",
  config: {
    version: 1,
    defaultMode: "high",
    cycleShortcut: "f9",
    modes: [
      { id: "high", label: "High", provider: "openai", model: "sol", thinkingLevel: "high" },
      { id: "bad", label: "Bad", provider: "zai", model: "missing", thinkingLevel: "low" },
    ],
  },
};

test("doctor reports source, order, shortcut reload, and missing models", () => {
  const model: ModeModel = { provider: "openai", id: "sol", reasoning: true };
  const report = formatDoctorReport(inspectConfig(snapshot, {
    find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    available: () => [model],
  }, "f8"));
  assert.match(report, /Source: \/tmp\/modes\.json \(PI_MODEL_MODES_CONFIG\)/);
  assert.match(report, /Default: high/);
  assert.match(report, /Cycle: high -> bad/);
  assert.match(report, /Shortcut: f9 \(reload required; registered: f8\)/);
  assert.match(report, /missing model zai\/missing/);
});

test("doctor prints load errors without pretending config is usable", () => {
  const report = formatDoctorReport(inspectConfig({
    ok: false,
    path: "/tmp/modes.json",
    fromEnvironment: false,
    fingerprint: "missing",
    reason: "invalid",
    errors: [{ path: "root", message: "invalid JSON" }],
  }, { find: () => undefined, available: () => [] }, undefined));
  assert.match(report, /Status: INVALID/);
  assert.match(report, /invalid JSON/);
  assert.doesNotMatch(report, /Default:/);
});

test("doctor distinguishes a missing configuration file from an invalid one", () => {
  const report = formatDoctorReport(inspectConfig({
    ok: false,
    path: "/tmp/modes.json",
    fromEnvironment: false,
    fingerprint: "missing",
    reason: "missing",
    errors: [{ path: "root", message: 'no configuration file found at "/tmp/modes.json"' }],
  }, { find: () => undefined, available: () => [] }, undefined));
  assert.match(report, /Status: NOT_CONFIGURED/);
  assert.match(report, /Run \/mode init to generate a starter configuration/);
});

test("doctor reports non-reasoning and unsupported thinking levels via preflight", () => {
  const config: ModeConfig = {
    version: 1,
    defaultMode: "non-reasoning",
    modes: [
      { id: "non-reasoning", label: "Non-reasoning", provider: "openai", model: "plain", thinkingLevel: "low" },
      { id: "unsupported", label: "Unsupported", provider: "openai", model: "mapped", thinkingLevel: "high" },
    ],
  };
  const plain: ModeModel = { provider: "openai", id: "plain", reasoning: false };
  const mapped: ModeModel = {
    provider: "openai",
    id: "mapped",
    reasoning: true,
    thinkingLevelMap: { high: null },
  };
  const report = inspectConfig({ ...snapshot, config }, {
    find: (provider, id) => [plain, mapped].find((model) => model.provider === provider && model.id === id),
    available: () => [plain, mapped],
  }, undefined);

  assert.deepEqual(report.issues, [
    "non-reasoning: openai/plain does not support reasoning",
    "unsupported: openai/mapped does not support thinking level high",
  ]);
});

test("doctor reports models registered but currently unavailable", () => {
  const model: ModeModel = { provider: "openai", id: "sol", reasoning: true };
  const report = inspectConfig({
    ...snapshot,
    config: { ...snapshot.config, modes: [snapshot.config.modes[0]] },
  }, {
    find: () => model,
    available: () => [],
  }, undefined);

  assert.deepEqual(report.issues, ["high: model is registered but currently unavailable openai/sol"]);
});

test("mode list formats every mode deterministically", () => {
  assert.equal(formatModeList(snapshot.config), [
    "high: openai/sol · thinking:high",
    "bad: zai/missing · thinking:low",
  ].join("\n"));
});

test("mode list appends the description when present", () => {
  const withDescription: ModeConfig = {
    version: 1,
    defaultMode: "high",
    modes: [
      { id: "high", label: "High", provider: "openai", model: "sol", thinkingLevel: "high", description: "Deep reasoning" },
      { id: "bad", label: "Bad", provider: "zai", model: "missing", thinkingLevel: "low" },
    ],
  };
  assert.equal(formatModeList(withDescription), [
    "high: openai/sol · thinking:high · Deep reasoning",
    "bad: zai/missing · thinking:low",
  ].join("\n"));
});
