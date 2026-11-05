import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "./cli.ts";
import { insideRex, REX_TIMEOUT_MS, spawnTab, windowArgs } from "./rex.ts";

type Outcome = { stdout?: string; stderr?: string; code?: number; killed?: boolean };

/** Replies in order, one per call, repeating the last reply once exhausted. */
function fakeExec(...outcomes: Outcome[]) {
  const calls: Array<{ command: string; args: string[]; options?: { timeout?: number } }> = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, options });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)] ?? {};
    return {
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      code: outcome.code ?? 0,
      killed: outcome.killed,
    };
  };
  return { exec, calls };
}

const IN_REX = { REX_SESSION: "s1" };

function options(overrides: Partial<Parameters<typeof spawnTab>[1]> = {}) {
  return { cwd: "/work", rexBin: "rex", hunkBin: "hunk", target: ["diff"], ...overrides };
}

test("a Rex session is recognised by REX_SESSION", () => {
  assert.equal(insideRex(IN_REX), true);
});

test("a missing or empty REX_SESSION means no Rex session", () => {
  assert.equal(insideRex({}), false);
  assert.equal(insideRex({ REX_SESSION: "" }), false);
});

test("the tab is named, opened in pi's session and the repository, and runs hunk", () => {
  assert.deepEqual(windowArgs("s1", "/work", "hunk", ["diff", "main...HEAD"]), [
    "window",
    "new",
    "-s",
    "s1",
    "Hunk",
    "-c",
    "/work",
    "--json",
    "--",
    "hunk",
    "diff",
    "main...HEAD",
  ]);
});

test("a target word with a space reaches rex as one word", () => {
  assert.deepEqual(windowArgs("s1", "/work", "hunk", ["diff", "a b.ts"]).slice(-2), ["diff", "a b.ts"]);
});

test("outside a Rex session nothing is driven at all", async () => {
  const { exec, calls } = fakeExec({});
  const result = await spawnTab({ exec, env: {} }, options());
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /not running inside a Rex session/i);
  assert.deepEqual(calls, []);
});

test("inside a Rex session one tab is opened, under the timeout", async () => {
  const { exec, calls } = fakeExec({});
  const result = await spawnTab({ exec, env: IN_REX }, options());
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "rex");
  assert.deepEqual(calls[0].args, windowArgs("s1", "/work", "hunk", ["diff"]));
  assert.equal(calls[0].options?.timeout, REX_TIMEOUT_MS);
});

test("the configured rex binary is the one invoked", async () => {
  const { exec, calls } = fakeExec({});
  await spawnTab({ exec, env: IN_REX }, options({ rexBin: "/opt/bin/rex" }));
  assert.equal(calls[0].command, "/opt/bin/rex");
});

test("a killed rex is a failure even when it reports code 0", async () => {
  const { exec } = fakeExec({ code: 0, killed: true });
  const result = await spawnTab({ exec, env: IN_REX }, options());
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /did not respond within 10s/);
});

test("rex's own error reaches the user unchanged", async () => {
  const { exec } = fakeExec({ code: 1, stderr: "Error: session s1 not found\n" });
  const result = await spawnTab({ exec, env: IN_REX }, options());
  assert.deepEqual(result, { ok: false, message: "Error: session s1 not found" });
});

test("a silent rex failure still carries a reason", async () => {
  const { exec } = fakeExec({ code: 1 });
  const result = await spawnTab({ exec, env: IN_REX }, options());
  assert.deepEqual(result, { ok: false, message: "rex window new failed" });
});

test("an exec that throws becomes a failure, not an exception", async () => {
  const exec: Exec = async () => {
    throw new Error("spawn rex ENOENT");
  };
  const result = await spawnTab({ exec, env: IN_REX }, options());
  assert.deepEqual(result, { ok: false, message: "spawn rex ENOENT" });
});
