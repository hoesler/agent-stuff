import assert from "node:assert/strict";
import { test } from "node:test";
import { captureConsole } from "./amp-console.ts";

function fakeConsole() {
  const written: string[] = [];
  const target = {
    log: (...args: unknown[]) => written.push(`log:${args.join(" ")}`),
    info: (...args: unknown[]) => written.push(`info:${args.join(" ")}`),
    warn: (...args: unknown[]) => written.push(`warn:${args.join(" ")}`),
    error: (...args: unknown[]) => written.push(`error:${args.join(" ")}`),
    debug: (...args: unknown[]) => written.push(`debug:${args.join(" ")}`),
  };
  return { target, written };
}

test("routes console output to notify while the UI is active", () => {
  const { target, written } = fakeConsole();
  const notes: Array<[string, string]> = [];
  const restore = captureConsole(target, () => true, (message, type) => notes.push([message, type]));

  target.error("[pi-web-access] Install `gh` CLI");
  target.warn("careful", 42);
  target.log("hello");

  assert.deepEqual(written, []);
  assert.deepEqual(notes, [
    ["[pi-web-access] Install `gh` CLI", "warning"],
    ["careful 42", "warning"],
    ["hello", "info"],
  ]);
  restore();
});

test("passes output through to the terminal when the UI is not active", () => {
  const { target, written } = fakeConsole();
  const notes: string[] = [];
  const restore = captureConsole(target, () => false, (message) => notes.push(message));

  target.error("crash");

  assert.deepEqual(written, ["error:crash"]);
  assert.deepEqual(notes, []);
  restore();
});

test("restore puts the original methods back", () => {
  const { target } = fakeConsole();
  const original = target.error;
  const restore = captureConsole(target, () => true, () => {});
  assert.notEqual(target.error, original);
  restore();
  assert.equal(target.error, original);
});

test("formats non-string arguments like console does and skips empty output", () => {
  const { target } = fakeConsole();
  const notes: string[] = [];
  const restore = captureConsole(target, () => true, (message) => notes.push(message));

  target.error(new Error("boom"));
  target.log({ a: 1 });
  target.log("");

  assert.match(notes[0] ?? "", /^Error: boom/);
  assert.equal(notes[1], "{ a: 1 }");
  assert.equal(notes.length, 2);
  restore();
});
