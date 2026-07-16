import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModeConfigLoader,
  parseModeConfig,
  resolveConfigPath,
} from "./config.ts";

const valid = {
  version: 1,
  defaultMode: "medium",
  cycleShortcut: "f8",
  modes: [
    {
      id: "medium",
      label: "Medium",
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "medium",
      description: "Balanced",
    },
  ],
};

test("environment config path overrides the global path", () => {
  assert.equal(
    resolveConfigPath({ envPath: "/tmp/team.json", startupCwd: "/repo", agentDir: "/agent" }),
    "/tmp/team.json",
  );
  assert.equal(
    resolveConfigPath({ envPath: "profiles/team.json", startupCwd: "/repo", agentDir: "/agent" }),
    "/repo/profiles/team.json",
  );
  assert.equal(
    resolveConfigPath({ envPath: "  ", startupCwd: "/repo", agentDir: "/agent" }),
    "/agent/model-modes.json",
  );
});

test("parser normalizes optional presentation fields", () => {
  const parsed = parseModeConfig({
    ...valid,
    modes: [{ id: "medium", provider: "openai", model: "gpt", thinkingLevel: "max" }],
  });
  assert.equal(parsed.modes[0]?.label, "medium");
  assert.equal(parsed.modes[0]?.thinkingLevel, "max");
});

test("parser rejects all invalid input instead of loading a subset", () => {
  assert.throws(() => parseModeConfig({ ...valid, extra: true }), /root\.extra: unknown property/);
  assert.throws(() => parseModeConfig({ ...valid, defaultMode: "missing" }), /root\.defaultMode/);
  assert.throws(() => parseModeConfig({ ...valid, modes: [] }), /root\.modes/);
  assert.throws(
    () => parseModeConfig({ ...valid, modes: [valid.modes[0], valid.modes[0]] }),
    /duplicate mode id "medium"/,
  );
  for (const id of ["next", "previous", "doctor", "help", "two words"]) {
    assert.throws(
      () => parseModeConfig({ ...valid, defaultMode: id, modes: [{ ...valid.modes[0], id }] }),
      /reserved|whitespace/,
    );
  }
});

test("parser reports exact paths for additional invalid documents", () => {
  const rejected: Array<[unknown, RegExp]> = [
    [{ ...valid, version: 2 }, /root\.version/],
    [{ ...valid, modes: [{ ...valid.modes[0], extra: true }] }, /root\.modes\[0\]\.extra/],
    [{ ...valid, defaultMode: "" }, /root\.defaultMode/],
    [{ ...valid, modes: [{ ...valid.modes[0], provider: "  " }] }, /root\.modes\[0\]\.provider/],
    [{ ...valid, modes: [{ ...valid.modes[0], thinkingLevel: "extreme" }] }, /root\.modes\[0\]\.thinkingLevel/],
    [{ ...valid, cycleShortcut: "cmd+k" }, /root\.cycleShortcut/],
  ];
  for (const [document, path] of rejected) {
    assert.throws(() => parseModeConfig(document), path);
  }
});

test("loader disables stale config and recovers after the file is fixed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-modes-"));
  const path = join(dir, "modes.json");
  try {
    await writeFile(path, JSON.stringify(valid));
    const loader = new ModeConfigLoader(path, false);
    const initial = await loader.refresh(true);
    assert.equal(initial.ok, true);
    if (initial.ok) assert.equal(initial.config.cycleShortcut, "f8");

    await writeFile(path, "{");
    const broken = await loader.refresh(true);
    assert.equal(broken.ok, false);

    await writeFile(path, JSON.stringify({ ...valid, cycleShortcut: "f9" }));
    const fixed = await loader.refresh(true);
    assert.equal(fixed.ok, true);
    if (fixed.ok) assert.equal(fixed.config.cycleShortcut, "f9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loader reports missing files and invalid JSON at root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-modes-"));
  const path = join(dir, "modes.json");
  try {
    const loader = new ModeConfigLoader(path, false);
    const missing = await loader.refresh(true);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.errors[0]?.path, "root");

    await writeFile(path, "{");
    const invalidJson = await loader.refresh(true);
    assert.equal(invalidJson.ok, false);
    if (!invalidJson.ok) assert.equal(invalidJson.errors[0]?.path, "root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
