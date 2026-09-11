import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "./cli.ts";
import { createSpawn } from "./spawn.ts";
import { defaultConfig } from "./config.ts";
import type { HunkConfig, SpawnMode } from "./types.ts";

function recorder() {
  const calls: string[] = [];
  const exec: Exec = async (command) => {
    calls.push(command);
    // Enough of a `pane split` reply that the herdr backend gets as far as `pane run`.
    return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "", code: 0 };
  };
  return { exec, calls };
}

function spawnWith(overrides: {
  spawn: SpawnMode;
  env?: Record<string, string | undefined>;
  platform?: string;
  config?: Partial<HunkConfig>;
}) {
  const { exec, calls } = recorder();
  const config: HunkConfig = { ...defaultConfig(), spawn: overrides.spawn, ...overrides.config };
  const spawn = createSpawn(
    { exec, env: overrides.env ?? {}, platform: overrides.platform ?? "darwin" },
    { config, cwd: "/work" },
  );
  return { spawn, calls };
}

test("spawn: never opens nothing and says why", async () => {
  const { spawn, calls } = spawnWith({ spawn: "never" });
  const result = await spawn(["diff"]);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /spawn: never/);
  assert.deepEqual(calls, []);
});

test("spawn: ghostty drives Ghostty even inside a herdr pane", async () => {
  const { spawn, calls } = spawnWith({ spawn: "ghostty", env: { HERDR_ENV: "1" } });
  await spawn(["diff"]);
  assert.deepEqual(calls, ["osascript"]);
});

test("spawn: herdr drives herdr", async () => {
  const { spawn, calls } = spawnWith({ spawn: "herdr", env: { HERDR_ENV: "1" } });
  const result = await spawn(["diff"]);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["herdr", "herdr"]);
});

test("spawn: herdr outside a herdr pane fails rather than falling back to Ghostty", async () => {
  const { spawn, calls } = spawnWith({ spawn: "herdr", env: {} });
  const result = await spawn(["diff"]);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /not running inside a herdr pane/i);
  assert.deepEqual(calls, []);
});

test("spawn: auto picks herdr when pi is running inside one of its panes", async () => {
  const { spawn, calls } = spawnWith({ spawn: "auto", env: { HERDR_ENV: "1" } });
  await spawn(["diff"]);
  assert.deepEqual(calls, ["herdr", "herdr"]);
});

test("spawn: auto falls back to Ghostty outside herdr", async () => {
  const { spawn, calls } = spawnWith({ spawn: "auto", env: {} });
  await spawn(["diff"]);
  assert.deepEqual(calls, ["osascript"]);
});

test("the configured binaries are the ones invoked", async () => {
  const { spawn, calls } = spawnWith({
    spawn: "herdr",
    env: { HERDR_ENV: "1" },
    config: { herdrBin: "/opt/bin/herdr" },
  });
  await spawn(["diff"]);
  assert.deepEqual(calls, ["/opt/bin/herdr", "/opt/bin/herdr"]);
});

test("the target reaches the backend untouched", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_command, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "", code: 0 };
  };
  const spawn = createSpawn(
    { exec, env: { HERDR_ENV: "1" }, platform: "darwin" },
    { config: { ...defaultConfig(), spawn: "herdr" }, cwd: "/work" },
  );
  await spawn(["show", "abc123"]);
  assert.deepEqual(calls[1], ["pane", "run", "w1:p2", "'hunk' 'show' 'abc123'"]);
});
