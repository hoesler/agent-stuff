import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pstackExtension from "./index.ts";
import { pstackRoot } from "./pstack.ts";

type Handler = (...args: any[]) => any;
type Sent = { content: string; options: { expandPromptTemplates?: boolean; deliverAs?: "steer" | "followUp" } | undefined };

const root = pstackRoot(import.meta.url);

function harness(options: { skillLoaded?: boolean; idle?: boolean } = {}) {
  const commands = new Map<string, { handler: Handler }>();
  const events = new Map<string, Handler>();
  const sent: Sent[] = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    on: (event: string, handler: Handler) => events.set(event, handler),
    getCommands: () => (options.skillLoaded === false ? [] : [{ name: "skill:poteto-mode", source: "skill" }]),
    sendUserMessage: (content: string, opts: Sent["options"]) => sent.push({ content, options: opts }),
  } as unknown as ExtensionAPI;
  pstackExtension(pi);
  const ctx = { isIdle: () => options.idle ?? true, ui: { notify: (message: string) => notifications.push(message) } };
  return {
    sent,
    notifications,
    run: (args: string) => commands.get("poteto-mode")!.handler(args, ctx),
    beforeAgentStart: (systemPrompt: string) => events.get("before_agent_start")!({ systemPrompt }, ctx),
  };
}

async function withAgentDir<T>(models: string | undefined, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pstack-"));
  if (models !== undefined) await writeFile(join(dir, "pstack-models.md"), models);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("the extension finds the pstack tree the package ships", () => {
  assert.ok(existsSync(join(root, "skills", "poteto-mode", "SKILL.md")));
  assert.ok(existsSync(join(root, "docs", "harness", "pi.md")));
});

test("/poteto-mode hands the task to pi's own skill expansion", async () => {
  const h = harness();
  await h.run("  fix the flaky test  ");
  assert.deepEqual(h.sent, [{ content: "/skill:poteto-mode fix the flaky test", options: { expandPromptTemplates: true, deliverAs: undefined } }]);
});

test("/poteto-mode queues behind a running turn", async () => {
  const h = harness({ idle: false });
  await h.run("fix it");
  assert.equal(h.sent[0]!.options?.deliverAs, "followUp");
});

test("/poteto-mode expands the skill itself when pi has not loaded it", async () => {
  const h = harness({ skillLoaded: false });
  await h.run("fix it");
  const [{ content, options }] = h.sent;
  const location = join(root, "skills", "poteto-mode", "SKILL.md");
  assert.ok(content.startsWith(`<skill name="poteto-mode" location="${location}">\nReferences are relative to ${join(root, "skills", "poteto-mode")}.\n\n# Poteto mode`));
  assert.ok(content.endsWith("</skill>\n\nfix it"));
  assert.doesNotMatch(content, /disable-model-invocation/);
  assert.equal(options?.expandPromptTemplates, undefined);
});

test("every turn's system prompt names the pstack path and carries the role lines", async () => {
  await withAgentDir("# budget: large (xhigh)\nbug-fix: openai/gpt-5.6:xhigh\n", async (dir) => {
    const { systemPrompt } = await harness().beforeAgentStart("BASE");
    assert.ok(systemPrompt.startsWith("BASE\n\n## pstack\n"));
    assert.ok(systemPrompt.includes(`pstack is installed at ${root}.`));
    assert.ok(systemPrompt.includes(join(root, "docs", "harness", "pi.md")));
    assert.ok(systemPrompt.includes(`### pstack role models (${join(dir, "pstack-models.md")})\n\n# budget: large (xhigh)\nbug-fix: openai/gpt-5.6:xhigh`));
  });
});

test("without a role file the prompt says every role inherits the parent model", async () => {
  await withAgentDir(undefined, async () => {
    const { systemPrompt } = await harness().beforeAgentStart("BASE");
    assert.match(systemPrompt, /No pstack role file exists at .*, so every pstack role runs on `inherit-parent`/);
    assert.doesNotMatch(systemPrompt, /role models/);
  });
});
