import assert from "node:assert/strict";
import test from "node:test";
import { STATE_ENTRY_TYPE, alreadyTitled, latestMarker, parseMarker } from "./state.ts";

const entry = (data: unknown) => ({ type: "custom", customType: STATE_ENTRY_TYPE, data });

test("parseMarker reads a generated marker", () => {
  assert.deepEqual(parseMarker({ kind: "generated", name: "Titling extension", timestamp: 7 }), {
    kind: "generated",
    name: "Titling extension",
    timestamp: 7,
  });
});

test("parseMarker reads a user marker", () => {
  assert.deepEqual(parseMarker({ kind: "user", name: "My name", timestamp: 9 }), {
    kind: "user",
    name: "My name",
    timestamp: 9,
  });
});

test("parseMarker defaults a missing timestamp to 0", () => {
  assert.equal(parseMarker({ kind: "user", name: "My name" })?.timestamp, 0);
});

test("parseMarker rejects unknown and corrupt payloads", () => {
  assert.equal(parseMarker(undefined), undefined);
  assert.equal(parseMarker("string"), undefined);
  assert.equal(parseMarker({ kind: "legacy", name: "x" }), undefined);
  assert.equal(parseMarker({ kind: "user" }), undefined);
  assert.equal(parseMarker({ name: "x", timestamp: 1 }), undefined);
});

test("latestMarker returns the last parseable marker on the branch", () => {
  const branch = [
    entry({ kind: "generated", name: "First", timestamp: 1 }),
    { type: "message", message: { role: "user", content: "hi" } },
    entry({ kind: "user", name: "Second", timestamp: 2 }),
    entry({ kind: "legacy", name: "ignored" }),
    { type: "custom", customType: "other-extension", data: { kind: "user", name: "Nope" } },
  ];
  assert.deepEqual(latestMarker(branch), { kind: "user", name: "Second", timestamp: 2 });
});

test("latestMarker returns undefined when there is no marker", () => {
  assert.equal(latestMarker([{ type: "message", message: { role: "user", content: "hi" } }]), undefined);
});

test("alreadyTitled is false for an unnamed session", () => {
  assert.equal(alreadyTitled(undefined, undefined), false);
});

test("alreadyTitled is true for a named session with no marker", () => {
  assert.equal(alreadyTitled(undefined, "Named elsewhere"), true);
});

test("alreadyTitled is true when a marker matches the current name", () => {
  assert.equal(alreadyTitled({ kind: "generated", name: "Ours", timestamp: 1 }, "Ours"), true);
  assert.equal(alreadyTitled({ kind: "user", name: "Theirs", timestamp: 1 }, "Theirs"), true);
});

test("alreadyTitled is false when the name was cleared after a marker", () => {
  assert.equal(alreadyTitled({ kind: "generated", name: "Ours", timestamp: 1 }, undefined), false);
});

test("alreadyTitled is true when a stale marker disagrees with the current name", () => {
  assert.equal(alreadyTitled({ kind: "generated", name: "Old", timestamp: 1 }, "New"), true);
});
