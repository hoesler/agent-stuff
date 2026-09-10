import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import copilotModelLimits from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(): { seen: { name?: string; config?: ProviderConfig }; handlers: Map<string, Handler> } {
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
  copilotModelLimits(pi);
  return { seen, handlers };
}

/** The two bits of pi's ExtensionContext this extension reaches for. */
function extensionContext() {
  const refreshes: Array<Record<string, unknown>> = [];
  const notes: Array<{ message: string; type?: string }> = [];
  const ctx = {
    modelRegistry: {
      refresh: async (options: Record<string, unknown>) => {
        refreshes.push(options);
        return { aborted: false, errors: new Map() };
      },
    },
    ui: {
      notify: (message: string, type?: string) => notes.push({ message, type }),
    },
  };
  return { ctx, refreshes, notes };
}

const sessionStart = (reason: string) => ({ type: "session_start", reason });

test("the refresh is registered on pi's own Copilot provider", () => {
  const { seen } = load();
  assert.equal(seen.name, "github-copilot");
  assert.equal(typeof seen.config?.refreshModels, "function");
});

// pi strips the headers off every model a refreshModels returns, and Copilot
// answers a request without Editor-Version with a 400. Registering them on the
// provider is what puts them back.
test("the headers pi's Copilot models carry are registered on the provider", () => {
  const { seen } = load();
  assert.equal(seen.config?.headers?.["Editor-Version"], "vscode/1.107.0");
  assert.equal(seen.config?.headers?.["Copilot-Integration-Id"], "vscode-chat");
});

// Only one pass in pi 0.85 reads the limits over the network, and it runs once
// after startup. Every other refresh — a /reload, a logout, another extension
// registering a provider — is a cache-only pass that hands pi its catalog back,
// so without this the limits fall back to the shipped numbers and stay there.
test("every session start reads the limits again, over the network", async () => {
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    const { handlers } = load();
    const { ctx, refreshes } = extensionContext();
    await handlers.get("session_start")?.(sessionStart(reason), ctx);
    assert.equal(refreshes.length, 1, reason);
    assert.deepEqual(refreshes[0]?.providers, ["github-copilot"]);
    assert.equal(refreshes[0]?.allowNetwork, true);
  }
});

test("the refresh is asked for on its own, so no other provider is disturbed", async () => {
  const { handlers } = load();
  const { ctx, refreshes } = extensionContext();
  await handlers.get("session_start")?.(sessionStart("reload"), ctx);
  assert.deepEqual(refreshes[0]?.providers, ["github-copilot"]);
});

test("PI_OFFLINE is honoured, so an offline pi is left alone", async () => {
  const before = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const { handlers } = load();
    const { ctx, refreshes } = extensionContext();
    await handlers.get("session_start")?.(sessionStart("startup"), ctx);
    assert.deepEqual(refreshes, []);
  } finally {
    if (before === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = before;
  }
});

// The refresh that reads the limits runs before the first session_start, and pi
// throws its errors away. Holding the reason until there is a UI to say it in is
// what turns "limits that are silently wrong" into something visible.
test("a failure is shown to the user, even one from before the session started", async () => {
  const { seen, handlers } = load();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: async () => ({}),
  })) as unknown as typeof globalThis.fetch;
  try {
    await assert.rejects(
      seen.config?.refreshModels?.({
        allowNetwork: true,
        credential: { type: "oauth", access: "tid=a;proxy-ep=proxy.individual.githubcopilot.com" },
        signal: AbortSignal.any([]),
      } as never) as Promise<unknown>,
    );
  } finally {
    globalThis.fetch = original;
  }

  const { ctx, notes } = extensionContext();
  await handlers.get("session_start")?.(sessionStart("startup"), ctx);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.type, "error");
  assert.match(notes[0]?.message ?? "", /401 Unauthorized/);
  // It has to say whose numbers are on screen instead.
  assert.match(notes[0]?.message ?? "", /copilot-model-limits/);
});

test("a session start with nothing wrong says nothing", async () => {
  const { handlers } = load();
  const { ctx, notes } = extensionContext();
  await handlers.get("session_start")?.(sessionStart("startup"), ctx);
  assert.deepEqual(notes, []);
});
