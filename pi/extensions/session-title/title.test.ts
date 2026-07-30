import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSystemPrompt,
  buildUserPrompt,
  cleanTitle,
  extractTitleText,
  generateTitle,
  isUsableTitle,
} from "./title.ts";
import type { SessionTitleConfig } from "./types.ts";

const config: SessionTitleConfig = {
  version: 1,
  model: "copilot/gpt-5-mini",
  thinkingLevel: "off",
  enabled: true,
  maxLength: 50,
  debug: false,
};

const parts = [
  { role: "user" as const, text: "Rename pi sessions automatically" },
  { role: "assistant" as const, text: "I will add an extension" },
];

const assistantMessage = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  ...extra,
});

test("buildSystemPrompt states the length cap and forbids explanation", () => {
  const prompt = buildSystemPrompt(40);
  assert.match(prompt, /40 characters/);
  assert.match(prompt, /ONLY the title/);
});

test("buildSystemPrompt marks the conversation as untrusted", () => {
  assert.match(buildSystemPrompt(40), /untrusted/i);
});

test("buildUserPrompt tags each part by role and strips code noise", () => {
  const prompt = buildUserPrompt(
    [{ role: "user", text: "Fix ```const x = 1;``` in /src/a.ts" }],
    undefined,
  );
  assert.match(prompt, /<user>/);
  assert.match(prompt, /<\/user>/);
  assert.ok(!prompt.includes("const x = 1"));
  assert.ok(!prompt.includes("/src/a.ts"));
});

test("buildUserPrompt asks to keep a fitting current name", () => {
  const prompt = buildUserPrompt(parts, "Session titling extension");
  assert.match(prompt, /Session titling extension/);
  assert.match(prompt, /return it unchanged/i);
});

test("buildUserPrompt says there is no current name when there is none", () => {
  assert.match(buildUserPrompt(parts, undefined), /no current session name/i);
});

test("cleanTitle strips model prefixes", () => {
  assert.equal(cleanTitle("Here is a title: Fix auth refresh", 50), "Fix auth refresh");
  assert.equal(cleanTitle("Title: Fix auth refresh", 50), "Fix auth refresh");
  assert.equal(cleanTitle("Session：Fix auth refresh", 50), "Fix auth refresh");
});

test("cleanTitle strips surrounding quotes and newlines", () => {
  assert.equal(cleanTitle('"Fix auth refresh"', 50), "Fix auth refresh");
  assert.equal(cleanTitle("'Fix auth refresh'", 50), "Fix auth refresh");
  assert.equal(cleanTitle("「Fix auth refresh」", 50), "Fix auth refresh");
  assert.equal(cleanTitle("Fix auth\nrefresh", 50), "Fix auth refresh");
});

test("cleanTitle truncates with an ellipsis and never exceeds maxLength", () => {
  assert.equal(cleanTitle("abcdefghij", 8), "abcde...");
  assert.equal(cleanTitle("abcdefghij", 8).length, 8);
  assert.equal(cleanTitle("abcdefghij", 3), "abc");
  assert.equal(cleanTitle("abcdefghij", 2), "ab");
});

test("cleanTitle treats maxLength 0 as unlimited", () => {
  const long = "a".repeat(200);
  assert.equal(cleanTitle(long, 0), long);
});

test("isUsableTitle accepts a label", () => {
  assert.equal(isUsableTitle("Fix auth token refresh", 50), true);
});

test("isUsableTitle rejects too short, over-long, and content-free names", () => {
  assert.equal(isUsableTitle("ab", 50), false);
  assert.equal(isUsableTitle("a".repeat(51), 50), false);
  assert.equal(isUsableTitle("---", 50), false);
  assert.equal(isUsableTitle("", 50), false);
});

test("isUsableTitle rejects sentences", () => {
  assert.equal(isUsableTitle("Can you fix the auth bug?", 50), false);
  assert.equal(isUsableTitle("I fixed the auth bug.", 50), false);
  assert.equal(isUsableTitle("Fix auth, then ship, then rest", 50), false);
});

test("isUsableTitle ignores maxLength 0 for the upper bound", () => {
  assert.equal(isUsableTitle("a".repeat(200), 0), true);
});

test("extractTitleText prefers text blocks", () => {
  assert.equal(
    extractTitleText(
      assistantMessage([
        { type: "thinking", thinking: "Thinking title" },
        { type: "text", text: "Real title" },
      ]),
    ),
    "Real title",
  );
});

test("extractTitleText falls back to thinking blocks when text is empty", () => {
  assert.equal(
    extractTitleText(assistantMessage([{ type: "thinking", thinking: "Thinking title" }])),
    "Thinking title",
  );
});

test("generateTitle returns a cleaned title from the completion", async () => {
  const title = await generateTitle({
    complete: async () => assistantMessage([{ type: "text", text: '"Session titling extension"' }]),
    config,
    parts,
    currentName: undefined,
  });
  assert.equal(title, "Session titling extension");
});

test("generateTitle passes the model options through, omitting reasoning when off", async () => {
  let seen: any;
  await generateTitle({
    complete: async (_context, options) => {
      seen = options;
      return assistantMessage([{ type: "text", text: "Session titling extension" }]);
    },
    config,
    parts,
    currentName: undefined,
  });
  assert.equal("reasoning" in seen, false);
  assert.ok(seen.maxTokens > 0);
  assert.ok(seen.signal instanceof AbortSignal);
});

test("generateTitle forwards a real thinking level as reasoning", async () => {
  let seen: any;
  await generateTitle({
    complete: async (_context, options) => {
      seen = options;
      return assistantMessage([{ type: "text", text: "Session titling extension" }]);
    },
    config: { ...config, thinkingLevel: "low" },
    parts,
    currentName: undefined,
  });
  assert.equal(seen.reasoning, "low");
});

test("generateTitle throws on a provider error result", async () => {
  await assert.rejects(
    generateTitle({
      complete: async () =>
        assistantMessage([], { stopReason: "error", errorMessage: "rate limited" }),
      config,
      parts,
      currentName: undefined,
    }),
    /rate limited/,
  );
});

test("generateTitle throws on empty content", async () => {
  await assert.rejects(
    generateTitle({
      complete: async () => assistantMessage([]),
      config,
      parts,
      currentName: undefined,
    }),
    /empty/,
  );
});

test("generateTitle throws when the candidate fails the quality gate", async () => {
  await assert.rejects(
    generateTitle({
      complete: async () =>
        assistantMessage([{ type: "text", text: "Can you fix the auth bug?" }]),
      config,
      parts,
      currentName: undefined,
    }),
    /unusable/,
  );
});

test("generateTitle throws when there is nothing to title", async () => {
  await assert.rejects(
    generateTitle({
      complete: async () => assistantMessage([{ type: "text", text: "x" }]),
      config,
      parts: [],
      currentName: undefined,
    }),
    /no conversation/,
  );
});

test("generateTitle honours an external abort signal", async () => {
  const controller = new AbortController();
  controller.abort(new Error("gone"));
  await assert.rejects(
    generateTitle({
      complete: async (_context, options) => {
        options.signal?.throwIfAborted();
        return assistantMessage([{ type: "text", text: "unused" }]);
      },
      config,
      parts,
      currentName: undefined,
      signal: controller.signal,
    }),
  );
});
