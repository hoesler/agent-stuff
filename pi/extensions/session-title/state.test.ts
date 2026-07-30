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
  assert.equal(alreadyTitled(undefined), false);
});

test("alreadyTitled is true for a named session", () => {
  assert.equal(alreadyTitled("Named elsewhere"), true);
});
