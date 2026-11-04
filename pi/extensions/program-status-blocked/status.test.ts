import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import { holdOn } from "./status.ts";

class FakeTerminal {
  written: ProgramStatus[] = [];
  setProgramStatus(status: ProgramStatus): void {
    this.written.push(status);
  }
}

const WORKING: ProgramStatus = { state: "working", message: "palette", app: "pi" };

test("pi's reports pass straight through while nothing blocks", () => {
  const terminal = new FakeTerminal();
  holdOn(terminal);
  terminal.setProgramStatus(WORKING);
  assert.deepEqual(terminal.written, [WORKING]);
});

test("a block reports the question and its label", () => {
  const terminal = new FakeTerminal();
  const hold = holdOn(terminal);
  terminal.setProgramStatus(WORKING);
  hold.block("Predicate");
  assert.deepEqual(terminal.written.at(-1), { state: "blocked", kind: "question", message: "Predicate", app: "pi" });
});

// pi skips a report equal to its last, so after the questionnaire it says
// nothing: unless the hold puts "working" back, the terminal stays on blocked.
test("releasing puts back what pi last reported", () => {
  const terminal = new FakeTerminal();
  const hold = holdOn(terminal);
  terminal.setProgramStatus(WORKING);
  hold.block("Predicate");
  hold.release();
  assert.deepEqual(terminal.written.at(-1), WORKING);
});

test("a report pi makes while blocked is held, then replayed on release", () => {
  const terminal = new FakeTerminal();
  const hold = holdOn(terminal);
  terminal.setProgramStatus(WORKING);
  hold.block("Predicate");
  const renamed: ProgramStatus = { state: "working", message: "renamed", app: "pi" };
  terminal.setProgramStatus(renamed);
  assert.equal(terminal.written.at(-1)?.state, "blocked");
  hold.release();
  assert.deepEqual(terminal.written.at(-1), renamed);
});

test("with nothing from pi to put back, releasing clears the record", () => {
  const terminal = new FakeTerminal();
  const hold = holdOn(terminal);
  hold.block("Predicate");
  hold.release();
  assert.deepEqual(terminal.written.at(-1), { state: "clear" });
});

test("releasing without a block writes nothing", () => {
  const terminal = new FakeTerminal();
  const hold = holdOn(terminal);
  hold.release();
  assert.deepEqual(terminal.written, []);
});

test("detaching ends a block and hands the terminal back to pi", () => {
  const terminal = new FakeTerminal();
  const hold = holdOn(terminal);
  terminal.setProgramStatus(WORKING);
  hold.block("Predicate");
  hold.detach();
  assert.deepEqual(terminal.written.at(-1), WORKING);
  assert.equal(Object.hasOwn(terminal, "setProgramStatus"), false);
});
