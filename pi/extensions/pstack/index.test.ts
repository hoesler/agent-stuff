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

function harness(options: { idle?: boolean } = {}) {
  const commands = new Map<string, { handler: Handler; getArgumentCompletions?: Handler }>();
  const events = new Map<string, Handler>();
  const sent: Sent[] = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand: (name: string, command: { handler: Handler; getArgumentCompletions?: Handler }) => commands.set(name, command),
    on: (event: string, handler: Handler) => events.set(event, handler),
    sendUserMessage: (content: string, opts: Sent["options"]) => sent.push({ content, options: opts }),
  } as unknown as ExtensionAPI;
  pstackExtension(pi);
  const ctx = { isIdle: () => options.idle ?? true, ui: { notify: (message: string) => notifications.push(message) } };
  return {
    sent,
    notifications,
    run: (args: string, command = "poteto-mode") => commands.get(command)!.handler(args, ctx),
    pstack: (args: string) => commands.get("pstack")!.handler(args, ctx),
    complete: (prefix: string) => commands.get("pstack")!.getArgumentCompletions!(prefix),
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

test("/poteto-mode sends the skill the way pi's own skill expansion does", async () => {
  const h = harness();
  await h.run("  fix the flaky test  ");
  const [{ content, options }] = h.sent;
  const location = join(root, "skills", "poteto-mode", "SKILL.md");
  assert.ok(content.startsWith(`<skill name="poteto-mode" location="${location}">\nReferences are relative to ${join(root, "skills", "poteto-mode")}.\n\n# Poteto mode`));
  assert.ok(content.endsWith("</skill>\n\nfix the flaky test"));
  assert.doesNotMatch(content, /disable-model-invocation/);
  assert.deepEqual(options, { deliverAs: undefined });
});

test("/poteto-mode queues behind a running turn", async () => {
  const h = harness({ idle: false });
  await h.run("fix it");
  assert.equal(h.sent[0]!.options?.deliverAs, "followUp");
});

test("/poteto-help and /setup-pstack run their skills under upstream's names", async () => {
  const h = harness();
  await h.run("which playbook for a flaky test?", "poteto-help");
  await h.run("", "setup-pstack");
  assert.ok(h.sent[0]!.content.startsWith(`<skill name="poteto-help" location="${join(root, "skills", "poteto-help", "SKILL.md")}">`));
  assert.ok(h.sent[0]!.content.endsWith("</skill>\n\nwhich playbook for a flaky test?"));
  assert.ok(h.sent[1]!.content.startsWith(`<skill name="setup-pstack" location="${join(root, "skills", "setup-pstack", "SKILL.md")}">`));
  assert.ok(h.sent[1]!.content.endsWith("</skill>"));
});

test("/pstack runs the named skill with the rest as the task", async () => {
  const h = harness();
  await h.pstack(" arena   build the parser ");
  const [{ content }] = h.sent;
  assert.ok(content.startsWith(`<skill name="arena" location="${join(root, "skills", "arena", "SKILL.md")}">`));
  assert.ok(content.endsWith("</skill>\n\nbuild the parser"));
});

test("/pstack names what is wrong instead of sending nothing", async () => {
  const h = harness();
  await h.pstack("");
  await h.pstack("no-such-skill do it");
  assert.deepEqual(h.sent, []);
  assert.equal(h.notifications[0], "Usage: /pstack <skill> [task]");
  assert.match(h.notifications[1]!, /no skill named no-such-skill/);
});

test("/pstack completes skill names until the task begins", () => {
  const h = harness();
  const items = h.complete("princ") as { value: string; label: string; description: string }[];
  assert.ok(items.length > 20);
  assert.ok(items.every((item) => item.label.startsWith("principle-") && item.value === `${item.label} ` && item.description));
  assert.equal(h.complete("").length, 57);
  assert.equal(h.complete("arena build"), null);
  assert.equal(h.complete("zzz"), null);
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
