import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { GatewayError } from "./gateway.ts";
import { createInovexGateway, type InovexGatewayOptions } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function snapshotPath(content?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "inovex-gateway-")), "models.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

function load(options: Partial<InovexGatewayOptions> = {}) {
  const seen: { name?: string; config?: ProviderConfig } = {};
  const handlers = new Map<string, Handler>();
  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      seen.name = name;
      seen.config = config;
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  createInovexGateway({ snapshotPath: snapshotPath(), token: () => undefined, ...options })(pi);
  return { seen, handlers };
}

/** The two bits of pi's ExtensionContext this extension reaches for. */
function extensionContext(refresh: (options: Record<string, unknown>) => Promise<unknown> = async () => ({})) {
  const refreshes: Array<Record<string, unknown>> = [];
  const notes: Array<{ message: string; type?: string }> = [];
  const ctx = {
    modelRegistry: {
      refresh: (options: Record<string, unknown>) => {
        refreshes.push(options);
        return refresh(options);
      },
    },
    ui: { notify: (message: string, type?: string) => notes.push({ message, type }) },
  };
  return { ctx, refreshes, notes };
}

const sessionStart = { type: "session_start", reason: "startup" };

test("registers the inovex provider with bearer auth from INOVEX_GATEWAY_API_KEY", () => {
  const { seen } = load();
  assert.equal(seen.name, "inovex");
  assert.equal(seen.config?.name, "inovex AI Gateway");
  assert.equal(seen.config?.apiKey, "$INOVEX_GATEWAY_API_KEY");
  assert.equal(seen.config?.authHeader, true);
  assert.equal(seen.config?.baseUrl, "https://gateway.inovex.ai/v1");
  assert.equal(seen.config?.api, "openai-completions");
  assert.equal(typeof seen.config?.refreshModels, "function");
});

test("models from the snapshot are registered at load", () => {
  const path = snapshotPath(JSON.stringify({ version: 1, models: [{ id: "zai-org/GLM-5.3", name: "GLM-5.3", ownedBy: "nebul" }] }));
  const { seen } = load({ snapshotPath: path });
  assert.deepEqual(seen.config?.models?.map((model) => model.id), ["zai-org/GLM-5.3"]);
});

test("a corrupt snapshot still loads, with no models", () => {
  const { seen } = load({ snapshotPath: snapshotPath("{not json") });
  assert.deepEqual(seen.config?.models, []);
});

test("session start asks for a network refresh of inovex only, without waiting", async () => {
  const { handlers } = load();
  const { ctx, refreshes } = extensionContext(() => new Promise(() => {}));
  const saved = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  try {
    // Never settles; a handler that awaited it would never return.
    await handlers.get("session_start")?.(sessionStart, ctx);
  } finally {
    if (saved !== undefined) process.env.PI_OFFLINE = saved;
  }
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0].providers, ["inovex"]);
  assert.equal(refreshes[0].allowNetwork, true);
  assert.ok(refreshes[0].signal instanceof AbortSignal);
});

test("PI_OFFLINE suppresses the session-start refresh", async () => {
  const { handlers } = load();
  const { ctx, refreshes } = extensionContext();
  const saved = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    await handlers.get("session_start")?.(sessionStart, ctx);
  } finally {
    if (saved === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = saved;
  }
  assert.equal(refreshes.length, 0);
});

test("a failure from before the first session start is shown once it starts", async () => {
  const { seen, handlers } = load({
    token: () => "sk-aigw-test",
    fetchModels: async () => {
      throw new GatewayError("the gateway refused the key (401); it has probably expired — renew it with synapse auth");
    },
  });
  const refreshModels = seen.config?.refreshModels as (context: unknown) => Promise<unknown>;
  await assert.rejects(refreshModels({ allowNetwork: true, signal: new AbortController().signal }));

  const { ctx, notes } = extensionContext();
  await handlers.get("session_start")?.(sessionStart, ctx);

  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, "error");
  assert.match(notes[0].message, /^inovex-gateway: the gateway refused the key \(401\)/);
});
