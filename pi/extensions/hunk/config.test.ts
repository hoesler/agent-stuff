import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig, parseConfig, resolveConfigPaths } from "./config.ts";

test("an untrusted project contributes no config path", () => {
  const paths = resolveConfigPaths({
    envPath: undefined,
    startupCwd: "/work/repo",
    agentDir: "/home/u/.pi/agent",
    projectTrusted: false,
  });
  assert.deepEqual(paths, ["/home/u/.pi/agent/hunk.json"]);
});

test("a trusted project appends its own path, lower first", () => {
  const paths = resolveConfigPaths({
    envPath: undefined,
    startupCwd: "/work/repo",
    agentDir: "/home/u/.pi/agent",
    projectTrusted: true,
  });
  assert.deepEqual(paths, ["/home/u/.pi/agent/hunk.json", "/work/repo/.pi/hunk.json"]);
});

test("an env path replaces both files and resolves against the startup cwd", () => {
  const paths = resolveConfigPaths({
    envPath: "custom/hunk.json",
    startupCwd: "/work/repo",
    agentDir: "/home/u/.pi/agent",
    projectTrusted: true,
  });
  assert.deepEqual(paths, ["/work/repo/custom/hunk.json"]);
});

test("defaults are the documented ones", () => {
  assert.deepEqual(defaultConfig(), {
    version: 1,
    hunkBin: "hunk",
    spawn: "ghostty",
    noteAuthor: "pi",
  });
});

test("a partial file overrides only what it names", () => {
  const config = parseConfig({ spawn: "never" }, "/c.json");
  assert.equal(config.spawn, "never");
  assert.equal(config.hunkBin, "hunk");
  assert.equal(config.noteAuthor, "pi");
});

test("an unknown property is an error, not a silent ignore", () => {
  assert.throws(() => parseConfig({ nope: 1 }, "/c.json"), /\/c\.json\.nope: unknown property/);
});

test("an unknown spawn mode names the allowed ones", () => {
  assert.throws(() => parseConfig({ spawn: "iterm" }, "/c.json"), /expected one of ghostty, never/);
});

test("an empty hunkBin is rejected rather than producing an unrunnable command", () => {
  assert.throws(() => parseConfig({ hunkBin: "  " }, "/c.json"), /expected a non-empty string/);
});

test("a missing file loads defaults with no errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunk-config-"));
  const snapshot = await loadConfig({
    envPath: undefined,
    startupCwd: dir,
    agentDir: dir,
    projectTrusted: false,
  });
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.config.hunkBin, "hunk");
});

test("a malformed file reports the error and still yields a usable config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunk-config-"));
  writeFileSync(join(dir, "hunk.json"), "{ not json");
  const snapshot = await loadConfig({
    envPath: undefined,
    startupCwd: dir,
    agentDir: dir,
    projectTrusted: false,
  });
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.config.spawn, "ghostty");
});

test("later config files override only the keys they name, preserving earlier keys", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "hunk-config-"));
  const projectDir = mkdtempSync(join(tmpdir(), "hunk-config-"));
  writeFileSync(join(agentDir, "hunk.json"), JSON.stringify({ spawn: "never" }));
  const piDir = join(projectDir, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "hunk.json"), JSON.stringify({ noteAuthor: "reviewer" }));
  const snapshot = await loadConfig({
    envPath: undefined,
    startupCwd: projectDir,
    agentDir: agentDir,
    projectTrusted: true,
  });
  assert.deepEqual(snapshot.config, {
    version: 1,
    hunkBin: "hunk",
    spawn: "never",
    noteAuthor: "reviewer",
  });
});
