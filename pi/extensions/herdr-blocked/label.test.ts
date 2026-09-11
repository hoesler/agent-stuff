import assert from "node:assert/strict";
import { test } from "node:test";
import { promptLabel } from "./label.ts";

test("a prompt's own title is the label", () => {
  assert.equal(promptLabel({ kind: "confirm", title: "Overwrite the branch?" }), "Overwrite the branch?");
});

// pi passes no title for `custom`, which is how the questionnaire this was
// written for blocks, so the fallback carries the common case rather than an
// edge of it.
test("a custom overlay, which pi never titles, says what it waits for", () => {
  assert.equal(promptLabel({ kind: "custom" }), "waiting for an answer");
});

test("every kind pi has a phrase to fall back on", () => {
  for (const kind of ["select", "confirm", "input", "editor", "custom"] as const) {
    assert.match(promptLabel({ kind }), /^waiting for /);
  }
});

// A blank message renders as a herdr bug rather than as a pane with no title.
test("a title of only whitespace counts as absent", () => {
  assert.equal(promptLabel({ kind: "input", title: "   " }), "waiting for input");
});

test("a kind from a later pi still gets a label", () => {
  assert.equal(promptLabel({ kind: "wizard" as never }), "waiting for input");
});
