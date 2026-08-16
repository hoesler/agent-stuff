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

const model: ModeModel = { provider: "openai", id: "sol", reasoning: true };
const registry = {
  find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
  available: () => [model],
};

test("doctor names the active mode and every route that resolves for it", () => {
  const report = formatDoctorReport(inspectConfig(snapshot, registry, "f9", {
    activeMode: "high",
    routes: [{ key: "oracle", state: "active", model: "anthropic/claude-fable-5:high", description: "a second opinion" }],
  }));
  assert.match(report, /Routes \(active mode: high\):/);
  assert.match(report, /- oracle -> anthropic\/claude-fable-5:high — a second opinion/);
});

test("doctor says why a configured route is not available", () => {
  const report = formatDoctorReport(inspectConfig(snapshot, registry, "f9", {
    activeMode: "high",
    routes: [
      { key: "judge", state: "redundant", model: "openai/sol:high" },
      { key: "scout", state: "unset" },
      { key: "oracle", state: "off" },
    ],
  }));
  assert.match(report, /- judge -> unavailable \(openai\/sol:high is the model already running\)/);
  assert.match(report, /- scout -> unavailable \(no target for this mode\)/);
  assert.match(report, /- oracle -> unavailable \(this mode opts out\)/);
});

test("doctor reports an empty route table rather than omitting the section", () => {
  const report = formatDoctorReport(inspectConfig(snapshot, registry, "f9", { activeMode: "high", routes: [] }));
  assert.match(report, /Routes: none configured/);
});

test("doctor omits routes entirely when the configuration could not be loaded", () => {
  const report = formatDoctorReport(inspectConfig({
    ok: false,
    path: "/tmp/modes.json",
    fromEnvironment: false,
    fingerprint: "missing",
    reason: "invalid",
    errors: [{ path: "root", message: "invalid JSON" }],
  }, registry, "f9", { activeMode: "error", routes: [] }));
  assert.doesNotMatch(report, /Routes/);
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
