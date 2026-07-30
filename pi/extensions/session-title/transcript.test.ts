import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PART_CHARS,
  blockText,
  firstExchange,
  initialDialogue,
  recentWindow,
  stripNoise,
} from "./transcript.ts";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

test("blockText reads a plain string", () => {
  assert.equal(blockText("hello"), "hello");
});

test("blockText concatenates text blocks and ignores other block types", () => {
  assert.equal(
    blockText([
      { type: "text", text: "a" },
      { type: "thinking", thinking: "secret" },
      { type: "toolCall", name: "bash" },
      { type: "text", text: "b" },
    ]),
    "a b",
  );
});

test("blockText returns empty string for unusable content", () => {
  assert.equal(blockText(undefined), "");
  assert.equal(blockText(null), "");
  assert.equal(blockText([{ type: "toolCall", name: "bash" }]), "");
});

test("stripNoise removes fenced code, inline code, URLs, and paths", () => {
  const stripped = stripNoise(
    "Fix ```const x = 1;``` and `foo()` per https://example.com/docs in /src/deep/file.ts and ~/notes.md",
  );
  assert.ok(!stripped.includes("const x"));
  assert.ok(!stripped.includes("foo()"));
  assert.ok(!stripped.includes("example.com"));
  assert.ok(!stripped.includes("/src/deep/file.ts"));
  assert.ok(!stripped.includes("~/notes.md"));
  assert.ok(stripped.includes("Fix"));
});

test("firstExchange returns the first user message and first following assistant reply", () => {
  const branch = [
    message("user", "Rename my sessions"),
    message("assistant", [{ type: "text", text: "Sure, here is how" }]),
    message("user", "thanks"),
  ];
  assert.deepEqual(firstExchange(branch), [
    { role: "user", text: "Rename my sessions" },
    { role: "assistant", text: "Sure, here is how" },
  ]);
});

test("firstExchange skips tool-only and empty messages", () => {
  const branch = [
    message("user", [{ type: "image", data: "..." }]),
    message("user", "real prompt"),
    message("toolResult", "ignored"),
    message("assistant", [{ type: "toolCall", name: "bash" }]),
    message("assistant", [{ type: "text", text: "reply" }]),
  ];
  assert.deepEqual(firstExchange(branch), [
    { role: "user", text: "real prompt" },
    { role: "assistant", text: "reply" },
  ]);
});

test("firstExchange returns an empty array when the assistant has not replied", () => {
  assert.deepEqual(firstExchange([message("user", "hello")]), []);
});

test("firstExchange uses a compaction summary when the first exchange was compacted away", () => {
  const branch = [
    { type: "compaction", summary: "Earlier: set up the titling extension" },
    message("assistant", [{ type: "text", text: "continuing" }]),
  ];
  assert.deepEqual(firstExchange(branch), [
    { role: "user", text: "Earlier: set up the titling extension" },
    { role: "assistant", text: "continuing" },
  ]);
});

test("firstExchange caps each part", () => {
  const long = "x".repeat(MAX_PART_CHARS + 500);
  const parts = firstExchange([message("user", long), message("assistant", long)]);
  assert.equal(parts[0].text.length, MAX_PART_CHARS);
  assert.equal(parts[1].text.length, MAX_PART_CHARS);
});

test("recentWindow returns the last N messages in chronological order", () => {
  const branch = [
    message("user", "one"),
    message("assistant", "two"),
    message("user", "three"),
    message("assistant", "four"),
  ];
  assert.deepEqual(recentWindow(branch, 2), [
    { role: "user", text: "three" },
    { role: "assistant", text: "four" },
  ]);
});

test("recentWindow ignores non-message entries and non-user/assistant roles", () => {
  const branch = [
    { type: "custom", customType: "session-title-state", data: {} },
    message("toolResult", "nope"),
    message("user", "kept"),
  ];
  assert.deepEqual(recentWindow(branch, 6), [{ role: "user", text: "kept" }]);
});

test("initialDialogue uses the first exchange for a fresh session", () => {
  const branch = [message("user", "first ask"), message("assistant", "reply")];
  assert.deepEqual(initialDialogue(branch), [
    { role: "user", text: "first ask" },
    { role: "assistant", text: "reply" },
  ]);
});

test("initialDialogue uses the recent window once the session has moved on", () => {
  const branch = [
    message("user", "one"),
    message("assistant", "two"),
    message("user", "three"),
    message("assistant", "four"),
  ];
  assert.deepEqual(initialDialogue(branch).at(-1), { role: "assistant", text: "four" });
});

test("initialDialogue still uses the first exchange when a single turn spans several tool-call rounds", () => {
  // One user message, but the agent loop appended several text-bearing
  // assistant messages across tool-call rounds. This must still count as the
  // opening exchange, not "the session has moved on" — a count over all
  // messages (rather than user messages) would wrongly route this to
  // recentWindow and could even drop the user's original prompt entirely.
  const branch = [
    message("user", "set up the titling extension"),
    message("assistant", [{ type: "toolCall", name: "bash" }]),
    message("assistant", [{ type: "text", text: "checking the repo" }]),
    message("assistant", [{ type: "toolCall", name: "bash" }]),
    message("assistant", [{ type: "text", text: "running tests" }]),
    message("assistant", [{ type: "text", text: "done, all green" }]),
  ];
  assert.deepEqual(initialDialogue(branch), [
    { role: "user", text: "set up the titling extension" },
    { role: "assistant", text: "checking the repo" },
  ]);
});
