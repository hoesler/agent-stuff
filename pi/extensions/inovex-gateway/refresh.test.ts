import assert from "node:assert/strict";
import { test } from "node:test";
import type { Catalog } from "./enrich.ts";
import { GatewayError, type GatewayModel } from "./gateway.ts";
import { createGatewayRefresh, type GatewayRefreshDeps, type RefreshContext } from "./refresh.ts";

const SNAPSHOT: GatewayModel[] = [{ id: "zai-org/GLM-5.3", name: "GLM-5.3", ownedBy: "nebul" }];
const FETCHED: GatewayModel[] = [
  { id: "zai-org/GLM-5.3", name: "GLM-5.3", ownedBy: "nebul" },
  { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", ownedBy: "anthropic" },
];

const catalog: Catalog = {
  providers: ["anthropic"],
  models: (provider) =>
    provider === "anthropic"
      ? [{ id: "claude-opus-5-5", input: ["text"], reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }]
      : [],
};

const network = (signal: AbortSignal = new AbortController().signal): RefreshContext => ({ allowNetwork: true, signal });
const cacheOnly: RefreshContext = { allowNetwork: false, signal: new AbortController().signal };

function setup(over: Partial<GatewayRefreshDeps> = {}) {
  const fetches: Array<{ token: string; signal: AbortSignal }> = [];
  const saved: GatewayModel[][] = [];
  const reports: string[] = [];
  const refresh = createGatewayRefresh({
    initial: SNAPSHOT,
    catalog: () => catalog,
    token: () => "sk-aigw-test",
    fetchModels: async (token, signal) => {
      fetches.push({ token, signal });
      return FETCHED;
    },
    saveSnapshot: async (models) => {
      saved.push([...models]);
    },
    onFailure: (reason) => reports.push(reason),
    ...over,
  });
  return { refresh, fetches, saved, reports };
}

const ids = (models: Array<{ id: string }>) => models.map((model) => model.id);

test("a cache-only pass hands back the snapshot's models without fetching", async () => {
  const { refresh, fetches } = setup();
  assert.deepEqual(ids(await refresh.refreshModels(cacheOnly)), ["zai-org/GLM-5.3"]);
  assert.equal(fetches.length, 0);
});

test("a cache-only pass after a network pass hands back the fetched list", async () => {
  const { refresh } = setup();
  await refresh.refreshModels(network());
  assert.deepEqual(ids(await refresh.refreshModels(cacheOnly)), ids(FETCHED));
});

test("a network pass fetches with the pass's signal, saves the list and returns it enriched", async () => {
  const { refresh, fetches, saved } = setup();
  const signal = new AbortController().signal;

  const models = await refresh.refreshModels(network(signal));

  assert.equal(fetches[0].token, "sk-aigw-test");
  assert.equal(fetches[0].signal, signal);
  assert.deepEqual(saved, [FETCHED]);
  const opus = models.find((model) => model.id === "anthropic/claude-opus-5-5");
  assert.equal(opus?.contextWindow, 1_000_000);
  assert.deepEqual(ids(refresh.current()), ids(FETCHED));
});

test("without a key nothing is fetched or reported", async () => {
  const { refresh, fetches, reports } = setup({ token: () => undefined });
  assert.deepEqual(ids(await refresh.refreshModels(network())), ["zai-org/GLM-5.3"]);
  assert.equal(fetches.length, 0);
  assert.deepEqual(reports, []);
});

test("a refused key is reported and thrown, and the previous list stays", async () => {
  const refused = "the gateway refused the key (401); it has probably expired — renew it with synapse auth";
  const { refresh, reports } = setup({
    fetchModels: async () => {
      throw new GatewayError(refused);
    },
  });
  await assert.rejects(refresh.refreshModels(network()), { message: refused });
  assert.deepEqual(reports, [refused]);
  assert.deepEqual(ids(refresh.current()), ["zai-org/GLM-5.3"]);
});

test("the same failure is reported once until a good read", async () => {
  let fail = true;
  const { refresh, reports } = setup({
    fetchModels: async () => {
      if (fail) throw new TypeError("fetch failed");
      return FETCHED;
    },
  });
  await assert.rejects(refresh.refreshModels(network()));
  await assert.rejects(refresh.refreshModels(network()));
  assert.deepEqual(reports, ["the gateway could not be reached: fetch failed"]);

  fail = false;
  await refresh.refreshModels(network());
  fail = true;
  await assert.rejects(refresh.refreshModels(network()));
  assert.equal(reports.length, 2);
});

test("an aborted pass stays quiet", async () => {
  const controller = new AbortController();
  const { refresh, reports } = setup({
    fetchModels: async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
  });
  await assert.rejects(refresh.refreshModels(network(controller.signal)));
  assert.deepEqual(reports, []);
});

test("a failed snapshot write is reported but the refresh still succeeds", async () => {
  const { refresh, reports } = setup({
    saveSnapshot: async () => {
      throw new Error("EACCES");
    },
  });
  assert.deepEqual(ids(await refresh.refreshModels(network())), ids(FETCHED));
  assert.deepEqual(reports, ["the model list could not be saved: EACCES"]);
});

test("a gateway that does not answer in time is reported, unlike a superseded pass", async () => {
  const controller = new AbortController();
  const { refresh, reports } = setup({
    fetchModels: async () => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  await assert.rejects(refresh.refreshModels(network(controller.signal)));
  assert.deepEqual(reports, ["the gateway did not answer in time"]);
});
