import assert from "node:assert/strict";
import { test } from "node:test";
import type { Exec } from "./cli.ts";
import { paneId, runArgs, spawnPane, splitArgs } from "./herdr.ts";

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

const SPLIT_OK = { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }) };

function options(overrides: Partial<Parameters<typeof spawnPane>[1]> = {}) {
  return { cwd: "/work", herdrBin: "herdr", hunkBin: "hunk", target: ["diff"], ...overrides };
}

test("a pane id is read from the split result", () => {
  assert.equal(paneId(JSON.stringify({ result: { pane: { pane_id: "w3:p7" } } })), "w3:p7");
});

test("output that carries no pane id yields none, rather than throwing", () => {
  assert.equal(paneId("not json"), undefined);
  assert.equal(paneId(JSON.stringify({ result: {} })), undefined);
  assert.equal(paneId(JSON.stringify({ result: { pane: { pane_id: 42 } } })), undefined);
});

test("the split is explicit about the calling pane, the direction, and the cwd", () => {
  assert.deepEqual(splitArgs("/work"), [
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--cwd",
    "/work",
    "--focus",
  ]);
});

test("the command reaches pane run as one shell-safe argument", () => {
  assert.deepEqual(runArgs("w1:p2", "hunk", ["diff", "--staged"]), [
    "pane",
    "run",
    "w1:p2",
    "'hunk' 'diff' '--staged'",
  ]);
});

test("outside a herdr pane nothing is driven at all", async () => {
  const { exec, calls } = fakeExec(SPLIT_OK);
  const result = await spawnPane({ exec, env: {} }, options());
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /not running inside a herdr pane/i);
  assert.deepEqual(calls, []);
});

test("inside a herdr pane the split runs, then the command runs in the new pane", async () => {
  const { exec, calls } = fakeExec(SPLIT_OK);
  const result = await spawnPane(
    { exec, env: { HERDR_ENV: "1" } },
    options({ target: ["diff", "main...HEAD"] }),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "herdr");
  assert.deepEqual(calls[0].args, splitArgs("/work"));
  assert.equal(calls[1].command, "herdr");
  assert.deepEqual(calls[1].args, ["pane", "run", "w1:p2", "'hunk' 'diff' 'main...HEAD'"]);
});

test("a configured binary is used for both calls", async () => {
  const { exec, calls } = fakeExec(SPLIT_OK);
  await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options({ herdrBin: "/opt/bin/herdr" }));
  assert.deepEqual(calls.map((call) => call.command), ["/opt/bin/herdr", "/opt/bin/herdr"]);
});

test("a failing split reports herdr's own message and never runs the command", async () => {
  const { exec, calls } = fakeExec({ code: 1, stderr: "herdr: pane_not_found" });
  const result = await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options());
  assert.equal(!result.ok && result.message, "pane_not_found");
  assert.equal(calls.length, 1);
});

test("a split that reports no pane id is a failure, not a run against nothing", async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: "{}" });
  const result = await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options());
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /pane id/i);
  assert.equal(calls.length, 1);
});

test("a killed split is a failure, not a code: 0 success", async () => {
  // pi's own exec resolves a kill as `{ code: 0, killed: true }`, so `killed` must be
  // checked before `code === 0` is trusted — the same trap ghostty.ts guards against.
  const { exec } = fakeExec({ code: 0, killed: true, stdout: SPLIT_OK.stdout });
  const result = await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options());
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /did not respond|timed out/i);
});

test("both calls are given a timeout, so an unreachable server cannot wedge the command", async () => {
  const { exec, calls } = fakeExec(SPLIT_OK);
  await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options());
  for (const call of calls) {
    assert.ok(call.options?.timeout && call.options.timeout > 0, "a timeout must be passed to exec");
  }
});

test("a split that succeeds but a run that fails names the pane left behind", async () => {
  const { exec } = fakeExec(SPLIT_OK, { code: 1, stderr: "herdr: pane_busy" });
  const result = await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options());
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /pane_busy/);
  assert.match(!result.ok ? result.message : "", /w1:p2/);
});

test("a herdr that cannot be executed is reported, not raised", async () => {
  const exec: Exec = async () => {
    throw new Error("spawn herdr ENOENT");
  };
  const result = await spawnPane({ exec, env: { HERDR_ENV: "1" } }, options());
  assert.equal(!result.ok && result.message, "spawn herdr ENOENT");
});
