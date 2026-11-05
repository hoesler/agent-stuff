import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";

const MODELS = [
  { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", ownedBy: "anthropic" },
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", ownedBy: "nebul" },
];

const scratch = () => mkdtempSync(join(tmpdir(), "inovex-gateway-"));

test("what was written reads back", async () => {
  const path = join(scratch(), "models.json");
  await writeSnapshot(path, MODELS);
  assert.deepEqual(readSnapshot(path), MODELS);
});

test("a missing file reads as no models", () => {
  assert.deepEqual(readSnapshot(join(scratch(), "nope.json")), []);
});

test("a corrupt or foreign file reads as no models", () => {
  const dir = scratch();
  const read = (content: string) => {
    const path = join(dir, "models.json");
    writeFileSync(path, content);
    return readSnapshot(path);
  };
  assert.deepEqual(read("{not json"), []);
  assert.deepEqual(read('{"version":2,"models":[{"id":"a/b","name":"b","ownedBy":"x"}]}'), []);
  assert.deepEqual(read('{"version":1,"models":[{"name":"x"}]}'), []);
});

test("writing creates the directory", async () => {
  const path = join(scratch(), "inovex-gateway", "models.json");
  await writeSnapshot(path, MODELS);
  assert.equal(readSnapshot(path).length, 2);
});
