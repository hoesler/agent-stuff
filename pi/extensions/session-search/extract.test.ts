import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEntry, extractHeader } from "./extract.ts";

const OPTIONS = { includeThinking: false };

function entry(overrides: Record<string, unknown>) {
  return { id: "e1", parentId: null, timestamp: "2026-08-01T10:00:00.000Z", ...overrides };
}

test("a header yields the file row", () => {
  assert.deepEqual(
    extractHeader({
      type: "session",
      id: "8f2a1c",
      timestamp: "2026-08-01T09:00:00.000Z",
      cwd: "/work/repo",
      parentSession: "/sessions/parent.jsonl",
    }),
    {
      sessionId: "8f2a1c",
      created: "2026-08-01T09:00:00.000Z",
      cwd: "/work/repo",
      parentPath: "/sessions/parent.jsonl",
    },
  );
  assert.equal(extractHeader({ type: "message" }), undefined);
});

test("user text is prose, string content included", () => {
  const string = extractEntry(
    entry({ type: "message", message: { role: "user", content: "why not duckdb?" } }),
    OPTIONS,
  );
  assert.equal(string!.text, "why not duckdb?");
  assert.equal(string!.role, "user");
  assert.equal(string!.kind, "message");

  const blocks = extractEntry(
    entry({
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at" },
          { type: "image", data: "AAAABBBB", mimeType: "image/png" },
          { type: "text", text: "this diagram" },
        ],
      },
    }),
    OPTIONS,
  );
  assert.equal(blocks!.text, "look at this diagram");
});

test("assistant text is prose; thinking is excluded by default and included on request", () => {
  const message = entry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the user probably means the index" },
        { type: "text", text: "FTS5 keeps the snippet function" },
      ],
    },
  });
  assert.equal(extractEntry(message, OPTIONS)!.text, "FTS5 keeps the snippet function");
  assert.equal(
    extractEntry(message, { includeThinking: true })!.text,
    "the user probably means the index FTS5 keeps the snippet function",
  );
});

test("tool calls become evidence with read and write separated", () => {
  const extracted = extractEntry(
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "editing now" },
          { type: "toolCall", id: "t1", name: "read", arguments: { file_path: "/work/auth.ts" } },
          { type: "toolCall", id: "t2", name: "edit", arguments: { path: "/work/auth.ts" } },
          { type: "toolCall", id: "t3", name: "bash", arguments: { command: "npm run migrate" } },
          { type: "toolCall", id: "t4", name: "grep", arguments: { pattern: "TODO" } },
        ],
      },
    }),
    OPTIONS,
  );
  assert.equal(extracted!.text, "editing now");
  assert.deepEqual(extracted!.evidence, [
    { tool: "read", action: "read", target: "/work/auth.ts" },
    { tool: "edit", action: "write", target: "/work/auth.ts" },
    { tool: "bash", action: "run", target: "npm run migrate" },
    { tool: "grep", action: "read", target: "TODO" },
  ]);
});

test("tool results and bash output are indexed as neither prose nor evidence targets", () => {
  const result = extractEntry(
    entry({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "t1",
        content: [{ type: "text", text: "the entire contents of auth.ts" }],
        isError: false,
      },
    }),
    OPTIONS,
  );
  assert.equal(result!.text, undefined);
  assert.equal(result!.role, "toolResult");
  assert.deepEqual(result!.evidence, []);

  const bash = extractEntry(
    entry({
      type: "message",
      message: { role: "bashExecution", command: "npm test", output: "300 passing", exitCode: 0 },
    }),
    OPTIONS,
  );
  assert.equal(bash!.text, undefined);
  assert.deepEqual(bash!.evidence, [{ tool: "bash", action: "run", target: "npm test" }]);
});

test("summaries, names, and labels are prose; structural entries are metadata only", () => {
  assert.equal(
    extractEntry(entry({ type: "compaction", summary: "we chose sqlite", firstKeptEntryId: "e0" }), OPTIONS)!
      .text,
    "we chose sqlite",
  );
  assert.equal(
    extractEntry(
      entry({ type: "branch_summary", fromId: "e0", summary: "abandoned the duckdb branch" }),
      OPTIONS,
    )!.text,
    "abandoned the duckdb branch",
  );
  assert.equal(
    extractEntry(entry({ type: "session_info", name: "Session search" }), OPTIONS)!.text,
    "Session search",
  );
  assert.equal(
    extractEntry(entry({ type: "label", targetId: "e0", label: "the decision" }), OPTIONS)!.text,
    "the decision",
  );

  const model = extractEntry(entry({ type: "model_change", provider: "copilot", modelId: "gpt-5" }), OPTIONS);
  assert.equal(model!.kind, "model_change");
  assert.equal(model!.text, undefined);
});

test("every entry with an id yields a row, so the tree stays complete", () => {
  const unknown = extractEntry(entry({ type: "something_new_pi_added" }), OPTIONS);
  assert.equal(unknown!.kind, "something_new_pi_added");
  assert.equal(unknown!.text, undefined);

  assert.equal(extractEntry({ type: "message" }, OPTIONS), undefined);
  assert.equal(extractEntry(null, OPTIONS), undefined);
  assert.equal(extractEntry({ type: "session", id: "s1" }, OPTIONS), undefined);
});

test("empty prose is undefined, not an empty string", () => {
  const blank = extractEntry(
    entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "   " }] } }),
    OPTIONS,
  );
  assert.equal(blank!.text, undefined);
});
