import assert from "node:assert/strict";
import test from "node:test";
import { createController, normalizeName } from "./controller.ts";
import type { TitleMarker } from "./types.ts";

interface Harness {
  controller: ReturnType<typeof createController>;
  names: string[];
  markers: TitleMarker[];
  current: () => string | undefined;
}

function harness(
  generate: (request: { mode: string; currentName?: string; signal: AbortSignal }) => Promise<string | undefined>,
  options: { enabled?: boolean } = {},
): Harness {
  const names: string[] = [];
  const markers: TitleMarker[] = [];
  let currentName: string | undefined;
  const controller = createController({
    now: () => 1000,
    isEnabled: () => options.enabled ?? true,
    getCurrentName: () => currentName,
    setSessionName: (name) => {
      currentName = name;
      names.push(name);
    },
    appendMarker: (marker) => markers.push(marker),
    generateTitle: generate,
    debug: () => {},
  });
  return { controller, names, markers, current: () => currentName };
}

test("normalizeName trims and collapses whitespace", () => {
  assert.equal(normalizeName("  Fix   auth  "), "Fix auth");
  assert.equal(normalizeName("   "), undefined);
  assert.equal(normalizeName(undefined), undefined);
});

test("a successful request sets the name and appends a generated marker", async () => {
  const h = harness(async () => "Titling extension");
  await h.controller.run("initial");
  assert.deepEqual(h.names, ["Titling extension"]);
  assert.equal(h.markers.length, 1);
  assert.equal(h.markers[0].kind, "generated");
  assert.equal(h.markers[0].name, "Titling extension");
});

test("a request is skipped when titling is disabled", async () => {
  const h = harness(async () => "Titling extension", { enabled: false });
  assert.equal(await h.controller.run("initial"), undefined);
  assert.deepEqual(h.names, []);
});

test("a manual request runs even when titling is disabled", async () => {
  const h = harness(async () => "Titling extension", { enabled: false });
  assert.equal(await h.controller.run("manual"), "Titling extension");
  assert.deepEqual(h.names, ["Titling extension"]);
});

test("an unchanged name is not written again", async () => {
  const h = harness(async () => "Same name");
  await h.controller.run("manual");
  await h.controller.run("manual");
  assert.deepEqual(h.names, ["Same name"], "second identical result must not write");
  assert.equal(h.markers.length, 1, "an unchanged result appends no session metadata write");
});

test("a generator returning undefined writes nothing", async () => {
  const h = harness(async () => undefined);
  assert.equal(await h.controller.run("initial"), undefined);
  assert.deepEqual(h.names, []);
  assert.deepEqual(h.markers, []);
});

test("a throwing generator writes nothing and does not reject", async () => {
  const h = harness(async () => {
    throw new Error("provider down");
  });
  assert.equal(await h.controller.run("initial"), undefined);
  assert.deepEqual(h.names, []);
});

test("a failed initial run latches so it is not retried", async () => {
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    throw new Error("provider down");
  });
  assert.equal(await h.controller.run("initial"), undefined);
  assert.equal(h.controller.isTitled(), true, "one automatic attempt is spent, successful or not");
  assert.equal(await h.controller.run("initial"), undefined);
  assert.equal(calls, 1, "a second automatic run must not call the generator again");
});

test("a failed manual run does not latch, so automatic titling remains possible", async () => {
  const h = harness(async () => {
    throw new Error("provider down");
  });
  assert.equal(await h.controller.run("manual"), undefined);
  assert.equal(h.controller.isTitled(), false, "a failed /title must not block later automatic titling");
});

test("a superseded request is aborted and its result discarded", async () => {
  let firstSignal: AbortSignal | undefined;
  let releaseFirst: (() => void) | undefined;
  const h = harness(async (request) => {
    if (!firstSignal) {
      firstSignal = request.signal;
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "Stale title";
    }
    return "Fresh title";
  });

  const first = h.controller.run("initial");
  const second = h.controller.run("manual");
  assert.equal(await second, "Fresh title");
  assert.equal(firstSignal?.aborted, true, "the superseded request must be aborted");
  releaseFirst?.();
  assert.equal(await first, undefined, "the stale result must be discarded");
  assert.deepEqual(h.names, ["Fresh title"]);
});

test("shutdown aborts an in-flight request and discards its result", async () => {
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const h = harness(async (request) => {
    signal = request.signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "Too late";
  });
  const pending = h.controller.run("initial");
  h.controller.shutdown();
  assert.equal(signal?.aborted, true);
  release?.();
  assert.equal(await pending, undefined);
  assert.deepEqual(h.names, []);
});

test("an in-flight automatic title is discarded, not applied, when the user renames mid-flight", async () => {
  let release: (() => void) | undefined;
  const h = harness(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return "Generated title";
  });

  const pending = h.controller.run("initial");
  h.controller.observeNameChange("User name");
  release?.();
  assert.equal(await pending, undefined, "the in-flight result must be discarded");
  assert.deepEqual(h.names, [], "setSessionName must never be called with the generated title");
  assert.equal(h.current(), undefined, "the recorded name is whatever observeNameChange saw, not the generated title");
});

test("our own name change is not recorded as a user rename", async () => {
  const h = harness(async () => "Ours");
  await h.controller.run("initial");
  h.controller.observeNameChange("Ours");
  assert.equal(h.markers.length, 1, "no user marker for the echo of our own write");
  assert.equal(h.controller.isTitled(), true);
});

test("an external name change records a user marker and latches", async () => {
  const h = harness(async () => "Ours");
  h.controller.observeNameChange("Theirs");
  assert.equal(h.markers.length, 1);
  assert.equal(h.markers[0].kind, "user");
  assert.equal(h.markers[0].name, "Theirs");
  assert.equal(h.controller.isTitled(), true);
});

test("a cleared name is not recorded", () => {
  const h = harness(async () => "Ours");
  h.controller.observeNameChange(undefined);
  assert.deepEqual(h.markers, []);
  assert.equal(h.controller.isTitled(), false);
});

test("restore latches for an already-titled session", () => {
  const h = harness(async () => "Ours");
  h.controller.restore(true, "Existing");
  assert.equal(h.controller.isTitled(), true);
});

test("restore of an unnamed session leaves titling open", () => {
  const h = harness(async () => "Ours");
  h.controller.restore(false, undefined);
  assert.equal(h.controller.isTitled(), false);
});

test("restore recognises the restored name as ours so its echo is not a rename", () => {
  const h = harness(async () => "Ours");
  h.controller.restore(true, "Existing");
  h.controller.observeNameChange("Existing");
  assert.deepEqual(h.markers, [], "the restored name must not be re-recorded");
});
