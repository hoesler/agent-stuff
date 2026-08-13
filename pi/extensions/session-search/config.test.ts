import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SessionSearchConfigLoader,
  defaultConfig,
  parseOverride,
  resolveConfigPaths,
} from "./config.ts";

test("defaults derive both paths from the agent dir", () => {
  const config = defaultConfig("/agent");
  assert.equal(config.dbPath, join("/agent", "session-search", "index.sqlite"));
  assert.equal(config.sessionsDir, join("/agent", "sessions"));
  assert.equal(config.includeThinking, false);
  assert.equal(config.refreshBudgetBytes, 33554432);
  assert.deepEqual(config.excludeCwd, []);
  assert.equal(config.maxSnippetChars, 240);
});

test("config paths: global first, project second, env replaces both", () => {
  assert.deepEqual(
    resolveConfigPaths({
      envPath: undefined,
      startupCwd: "/work",
      agentDir: "/agent",
      projectTrusted: true,
    }),
    [join("/agent", "session-search.json"), join("/work", ".pi", "session-search.json")],
  );
  assert.deepEqual(
    resolveConfigPaths({
      envPath: undefined,
      startupCwd: "/work",
      agentDir: "/agent",
      projectTrusted: false,
    }),
    [join("/agent", "session-search.json")],
  );
  assert.deepEqual(
    resolveConfigPaths({
      envPath: "cfg.json",
      startupCwd: "/work",
      agentDir: "/agent",
      projectTrusted: true,
    }),
    [join("/work", "cfg.json")],
  );
});

test("parseOverride accepts a partial file and rejects bad values", () => {
  assert.deepEqual(parseOverride({ includeThinking: true }), { includeThinking: true });
  assert.deepEqual(parseOverride({ version: 1, excludeCwd: ["/tmp/**"] }), {
    excludeCwd: ["/tmp/**"],
  });
  assert.throws(() => parseOverride({ nope: 1 }), /unknown property/);
  assert.throws(() => parseOverride({ version: 2 }), /expected 1/);
  assert.throws(() => parseOverride({ maxSnippetChars: -1 }), /positive integer/);
  assert.throws(() => parseOverride({ excludeCwd: "x" }), /array of strings/);
  assert.throws(() => parseOverride([]), /expected object/);
});

test("loader with no files present yields defaults and no errors", async () => {
  const loader = new SessionSearchConfigLoader(
    [join(tmpdir(), "nope-session-search.json")],
    "/agent",
  );
  const snapshot = await loader.refresh();
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.config.maxSnippetChars, 240);
});

test("later layers win per field, and a broken layer is reported but not fatal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-config-"));
  const global = join(dir, "global.json");
  const project = join(dir, "project.json");
  writeFileSync(global, JSON.stringify({ version: 1, includeThinking: true, maxSnippetChars: 100 }));
  writeFileSync(project, JSON.stringify({ maxSnippetChars: 50 }));

  const loader = new SessionSearchConfigLoader([global, project], "/agent");
  const snapshot = await loader.refresh();
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.config.includeThinking, true);
  assert.equal(snapshot.config.maxSnippetChars, 50);

  writeFileSync(project, "{ not json");
  const broken = await loader.refresh();
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.config.maxSnippetChars, 100);
});
