import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionTitleConfigLoader,
  mergeConfig,
  parseConfig,
  resolveConfigPaths,
} from "./config.ts";

test("resolveConfigPaths returns global then project, lowest precedence first", () => {
  assert.deepEqual(
    resolveConfigPaths({
      envPath: undefined,
      startupCwd: "/repo",
      agentDir: "/agent",
      projectTrusted: true,
    }),
    ["/agent/session-title.json", "/repo/.pi/session-title.json"],
  );
});

test("resolveConfigPaths drops the project file when the project is untrusted", () => {
  assert.deepEqual(
    resolveConfigPaths({
      envPath: undefined,
      startupCwd: "/repo",
      agentDir: "/agent",
      projectTrusted: false,
    }),
    ["/agent/session-title.json"],
  );
});

test("resolveConfigPaths lets an env path replace both files", () => {
  assert.deepEqual(
    resolveConfigPaths({
      envPath: "team.json",
      startupCwd: "/repo",
      agentDir: "/agent",
      projectTrusted: true,
    }),
    ["/repo/team.json"],
  );
  assert.deepEqual(
    resolveConfigPaths({
      envPath: "/abs/team.json",
      startupCwd: "/repo",
      agentDir: "/agent",
      projectTrusted: true,
    }),
    ["/abs/team.json"],
  );
  assert.deepEqual(
    resolveConfigPaths({
      envPath: "   ",
      startupCwd: "/repo",
      agentDir: "/agent",
      projectTrusted: true,
    }),
    ["/agent/session-title.json", "/repo/.pi/session-title.json"],
  );
});

test("parseConfig fills defaults for omitted optional fields", () => {
  assert.deepEqual(parseConfig({ version: 1, model: "copilot/gpt-5-mini" }), {
    version: 1,
    model: "copilot/gpt-5-mini",
    thinkingLevel: "off",
    enabled: true,
    maxLength: 50,
    debug: false,
  });
});

test("parseConfig requires version 1 and a provider/model string", () => {
  assert.throws(() => parseConfig({ model: "a/b" }), /root.version/);
  assert.throws(() => parseConfig({ version: 2, model: "a/b" }), /root.version/);
  assert.throws(() => parseConfig({ version: 1 }), /root.model/);
  assert.throws(() => parseConfig({ version: 1, model: "nope" }), /root.model/);
  assert.throws(() => parseConfig({ version: 1, model: "/b" }), /root.model/);
  assert.throws(() => parseConfig({ version: 1, model: "a/" }), /root.model/);
});

test("parseConfig rejects unknown properties and wrong types", () => {
  assert.throws(() => parseConfig({ version: 1, model: "a/b", nope: 1 }), /root.nope/);
  assert.throws(
    () => parseConfig({ version: 1, model: "a/b", thinkingLevel: "turbo" }),
    /root.thinkingLevel/,
  );
  assert.throws(() => parseConfig({ version: 1, model: "a/b", enabled: "yes" }), /root.enabled/);
  assert.throws(() => parseConfig({ version: 1, model: "a/b", maxLength: -1 }), /root.maxLength/);
  assert.throws(() => parseConfig({ version: 1, model: "a/b", maxLength: 1.5 }), /root.maxLength/);
  assert.throws(() => parseConfig({ version: 1, model: "a/b", debug: 1 }), /root.debug/);
  assert.throws(() => parseConfig([]), /root: expected object/);
});

test("mergeConfig lets project fields win per field", () => {
  const merged = mergeConfig(
    { version: 1, model: "a/b", thinkingLevel: "off", enabled: true, maxLength: 50, debug: false },
    { maxLength: 30 },
  );
  assert.equal(merged.model, "a/b");
  assert.equal(merged.maxLength, 30);
});

test("mergeConfig accepts a project file with no version and no model", () => {
  const merged = mergeConfig(
    { version: 1, model: "a/b", thinkingLevel: "off", enabled: true, maxLength: 50, debug: false },
    { model: "c/d", enabled: false },
  );
  assert.equal(merged.model, "c/d");
  assert.equal(merged.enabled, false);
});

test("loader reports missing when no file exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-title-"));
  try {
    const loader = new SessionTitleConfigLoader([join(dir, "absent.json")]);
    const snapshot = await loader.refresh();
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.ok === false && snapshot.reason, "missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loader reports invalid with errors for malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-title-"));
  const file = join(dir, "session-title.json");
  try {
    await writeFile(file, "{ not json", "utf8");
    const loader = new SessionTitleConfigLoader([file]);
    const snapshot = await loader.refresh();
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.ok === false && snapshot.reason, "invalid");
    assert.ok(snapshot.ok === false && snapshot.errors.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loader merges a project file over a global file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-title-"));
  const globalFile = join(dir, "global.json");
  const projectFile = join(dir, "project.json");
  try {
    await writeFile(
      globalFile,
      JSON.stringify({ version: 1, model: "a/b", maxLength: 50 }),
      "utf8",
    );
    await writeFile(projectFile, JSON.stringify({ maxLength: 20 }), "utf8");
    const snapshot = await new SessionTitleConfigLoader([globalFile, projectFile]).refresh();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.ok && snapshot.config.model, "a/b");
    assert.equal(snapshot.ok && snapshot.config.maxLength, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loader re-reads after the file changes and reuses the snapshot otherwise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-title-"));
  const file = join(dir, "session-title.json");
  try {
    await writeFile(file, JSON.stringify({ version: 1, model: "a/b" }), "utf8");
    const loader = new SessionTitleConfigLoader([file]);
    const first = await loader.refresh();
    const second = await loader.refresh();
    assert.equal(first, second, "unchanged files must return the identical snapshot object");

    await writeFile(file, JSON.stringify({ version: 1, model: "c/d" }), "utf8");
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);
    const third = await loader.refresh();
    assert.equal(third.ok && third.config.model, "c/d");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
