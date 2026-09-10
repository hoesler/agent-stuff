import assert from "node:assert/strict";
import { test } from "node:test";
import { createCopilotModelRefresh } from "./refresh.ts";
import type { RefreshContext } from "./refresh.ts";

const MODELS = [
  { id: "gpt-5.4", name: "GPT-5.4", reasoning: true, input: ["text" as const], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 64_000 },
];

const TOKEN = "tid=a;proxy-ep=proxy.individual.githubcopilot.com";

/** pi hands over the whole stored credential; RefreshContext only promises its tag. */
const credential = (over: Record<string, unknown> = {}) =>
  ({ type: "oauth", access: TOKEN, refresh: "r", expires: 0, ...over }) as RefreshContext["credential"];

const context = (over: Partial<RefreshContext> = {}): RefreshContext => ({
  allowNetwork: true,
  credential: credential(),
  signal: AbortSignal.any([]),
  ...over,
});

const answering = (body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchModels = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK",
      json: async () => body,
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchModels };
};

const catalogue = {
  data: [{ id: "gpt-5.4", capabilities: { limits: { max_prompt_tokens: 1_000_000, max_output_tokens: 128_000, max_context_window_tokens: 1_128_000 } } }],
};

test("the reported limits replace pi's own", async () => {
  const { fetchModels } = answering(catalogue);
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels });
  const models = await refresh(context());
  assert.equal(models[0]?.contextWindow, 1_000_000);
  assert.equal(models[0]?.maxTokens, 128_000);
});

test("the account's own endpoint is asked, with the headers Copilot expects", async () => {
  const { calls, fetchModels } = answering(catalogue);
  await createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels })(context());
  assert.equal(calls[0]?.url, "https://api.individual.githubcopilot.com/models");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tid=a;proxy-ep=proxy.individual.githubcopilot.com");
  assert.equal(headers["Copilot-Integration-Id"], "vscode-chat");
});

test("pi's cancellation is passed through, so a closed picker stops the request", async () => {
  const { calls, fetchModels } = answering(catalogue);
  const signal = AbortSignal.any([]);
  await createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels })(context({ signal }));
  assert.equal(calls[0]?.init?.signal, signal);
});

// pi runs a cache-only pass at startup. Reaching for the network there would
// both disobey it and delay the first paint of the model list.
test("the offline pass returns pi's list untouched and asks nothing", async () => {
  const { calls, fetchModels } = answering(catalogue);
  const models = await createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels })(context({ allowNetwork: false }));
  assert.equal(calls.length, 0);
  assert.equal(models[0]?.contextWindow, 400_000);
});

// /models speaks the OAuth proxy token. A COPILOT_GITHUB_TOKEN api key is an
// ordinary GitHub PAT and cannot read it, so there is nothing to try.
test("without an OAuth credential pi's list is returned untouched and nothing is asked", async () => {
  for (const stored of [undefined, { type: "api_key" as const, key: "ghp_x" }]) {
    const { calls, fetchModels } = answering(catalogue);
    const models = await createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels })(context({ credential: stored }));
    assert.equal(calls.length, 0);
    assert.equal(models[0]?.contextWindow, 400_000);
  }
});

// These two do throw. pi turns a throw into "Could not refresh github-copilot;
// showing cached models." in the picker, which is the whole point: a Copilot
// account that cannot be read should say so rather than look correct.
test("a refused request is reported, not swallowed", async () => {
  const { fetchModels } = answering({}, { ok: false, status: 401, statusText: "Unauthorized" });
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels });
  await assert.rejects(refresh(context()), /401 Unauthorized/);
});

test("a catalog that carries no limits at all is reported, not silently accepted", async () => {
  const { fetchModels } = answering({ data: [{ id: "gpt-5.4" }] });
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels });
  await assert.rejects(refresh(context()), /no usable token limits/);
});

test("an enterprise credential without a proxy-ep is asked at its own host", async () => {
  const { calls, fetchModels } = answering(catalogue);
  await createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels })(
    context({ credential: credential({ access: "opaque", enterpriseUrl: "https://ghe.example.com" }) }),
  );
  assert.equal(calls[0]?.url, "https://copilot-api.ghe.example.com/models");
});

// pi's startup refresh ends in `.catch(() => {})` and never reads
// result.errors, so throwing alone is invisible exactly where the limits are
// first read. The extension has to say so itself.
test("a refused request is announced as well as thrown", async () => {
  const said: string[] = [];
  const { fetchModels } = answering({}, { ok: false, status: 401, statusText: "Unauthorized" });
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels, onFailure: (reason) => said.push(reason) });
  await assert.rejects(refresh(context()), /401 Unauthorized/);
  assert.equal(said.length, 1);
  assert.match(said[0] ?? "", /401 Unauthorized/);
});

test("a catalog with no readable limits is announced as well as thrown", async () => {
  const said: string[] = [];
  const { fetchModels } = answering({ data: [{ id: "gpt-5.4" }] });
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels, onFailure: (reason) => said.push(reason) });
  await assert.rejects(refresh(context()), /no usable token limits/);
  assert.match(said[0] ?? "", /no usable token limits/);
});

test("an endpoint that cannot be reached is announced, not only thrown", async () => {
  const said: string[] = [];
  const fetchModels = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.individual.githubcopilot.com");
  }) as unknown as typeof globalThis.fetch;
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels, onFailure: (reason) => said.push(reason) });
  await assert.rejects(refresh(context()), /ENOTFOUND/);
  assert.match(said[0] ?? "", /could not be reached/);
});

// A superseded refresh is routine: pi aborts the previous pass for a provider
// whenever a new one starts. Announcing that would cry wolf on every reload.
test("a cancelled request is pi's own business and says nothing", async () => {
  const said: string[] = [];
  const controller = new AbortController();
  const fetchModels = (async () => {
    controller.abort();
    throw new Error("This operation was aborted");
  }) as unknown as typeof globalThis.fetch;
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels, onFailure: (reason) => said.push(reason) });
  await assert.rejects(refresh(context({ signal: controller.signal })));
  assert.deepEqual(said, []);
});

test("the passes that are expected to stay quiet announce nothing", async () => {
  const said: string[] = [];
  const { fetchModels } = answering(catalogue);
  const refresh = createCopilotModelRefresh({ builtInModels: () => MODELS, fetchModels, onFailure: (reason) => said.push(reason) });
  await refresh(context({ allowNetwork: false }));
  await refresh(context({ credential: undefined }));
  await refresh(context());
  assert.deepEqual(said, []);
});

// pi's own network pass and the one the extension asks for on session start can
// both fail on the same trouble. Saying it twice per session start is noise.
test("the same trouble is announced once, and again only after it cleared", async () => {
  const said: string[] = [];
  let ok = false;
  const fetchModels = (async () => ({
    ok,
    status: ok ? 200 : 401,
    statusText: ok ? "OK" : "Unauthorized",
    json: async () => catalogue,
  })) as unknown as typeof globalThis.fetch;
  const refresh = createCopilotModelRefresh({
    builtInModels: () => MODELS,
    fetchModels,
    onFailure: (reason) => said.push(reason),
  });

  await assert.rejects(refresh(context()));
  await assert.rejects(refresh(context()));
  assert.equal(said.length, 1, "a repeat of the same reason stays quiet");

  ok = true;
  await refresh(context());
  ok = false;
  await assert.rejects(refresh(context()));
  assert.equal(said.length, 2, "trouble that comes back after a good read is announced again");
});
