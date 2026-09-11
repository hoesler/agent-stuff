import assert from "node:assert/strict";
import { test } from "node:test";
import { commandLine, shellQuote, startupInput } from "./command.ts";

test("shellQuote wraps in single quotes and escapes embedded ones", () => {
  assert.equal(shellQuote("src/ui"), "'src/ui'");
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  assert.equal(shellQuote(""), "''");
});

test("the command line is shell-safe and unterminated", () => {
  assert.equal(commandLine("hunk", ["diff", "main...HEAD"]), "'hunk' 'diff' 'main...HEAD'");
});

test("a target carrying a space stays one argument", () => {
  assert.equal(commandLine("hunk", ["show", "a b"]), "'hunk' 'show' 'a b'");
});

test("the startup input is one runnable line, newline terminated", () => {
  assert.equal(startupInput("hunk", ["diff", "main...HEAD"]), "'hunk' 'diff' 'main...HEAD'\n");
});
