import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedModelHeaders } from "./headers.ts";

const COPILOT = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
};

test("headers every model carries become the provider's", () => {
  const shared = sharedModelHeaders([{ headers: { ...COPILOT } }, { headers: { ...COPILOT } }]);
  assert.deepEqual(shared, COPILOT);
});

// A provider header applies to every model, so one only the majority carries
// would be a guess about the rest.
test("a header the models disagree on is left out, the agreed ones stay", () => {
  const shared = sharedModelHeaders([
    { headers: { ...COPILOT, "X-Api": "one" } },
    { headers: { ...COPILOT, "X-Api": "two" } },
    { headers: { ...COPILOT } },
  ]);
  assert.deepEqual(shared, COPILOT);
});

test("a model without headers leaves nothing shared", () => {
  assert.equal(sharedModelHeaders([{ headers: { ...COPILOT } }, {}]), undefined);
});

test("an empty catalog shares nothing", () => {
  assert.equal(sharedModelHeaders([]), undefined);
});
