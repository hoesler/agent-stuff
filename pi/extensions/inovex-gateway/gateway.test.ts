import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGatewayModels, GatewayError, parseGatewayModels } from "./gateway.ts";

const KEY = "sk-aigw-secret";

/** A fetch that answers with `response` and remembers what it was asked. */
function fakeFetch(response: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

test("parses id, display name and owner from the gateway list", () => {
  assert.deepEqual(
    parseGatewayModels({
      data: [
        { id: "anthropic/claude-opus-5-5", display_name: "Claude Opus 5.5", owned_by: "anthropic" },
        { id: "zai-org/GLM-5.3", display_name: "GLM-5.3", owned_by: "nebul" },
      ],
    }),
    [
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", ownedBy: "anthropic" },
      { id: "zai-org/GLM-5.3", name: "GLM-5.3", ownedBy: "nebul" },
    ],
  );
});

test("drops entries without an id, keeps the first of duplicates, names by id when unnamed", () => {
  assert.deepEqual(
    parseGatewayModels({ data: [{ owned_by: "x" }, { id: "a/b" }, { id: "a/b", display_name: "Second" }] }),
    [{ id: "a/b", name: "a/b", ownedBy: "" }],
  );
});

test("a body without a data array parses to nothing", () => {
  assert.deepEqual(parseGatewayModels({ error: "nope" }), []);
  assert.deepEqual(parseGatewayModels(null), []);
});

test("asks /v1/models with the bearer key and the caller's signal", async () => {
  const { fetchImpl, calls } = fakeFetch(json({ data: [{ id: "a/b", owned_by: "nebul" }] }));
  const signal = new AbortController().signal;

  await fetchGatewayModels(KEY, signal, fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.inovex.ai/v1/models");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init?.signal, signal);
});

test("a 401 is reported as a refused, probably expired key", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("", { status: 401, statusText: "Unauthorized" }));
  await assert.rejects(
    fetchGatewayModels(KEY, AbortSignal.any([]), fetchImpl),
    (error) => error instanceof GatewayError && /expired/.test(error.message) && !error.message.includes(KEY),
  );
});

test("another HTTP failure names the status", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("", { status: 503, statusText: "Service Unavailable" }));
  await assert.rejects(
    fetchGatewayModels(KEY, AbortSignal.any([]), fetchImpl),
    (error) => error instanceof GatewayError && error.message.includes("503"),
  );
});

test("an empty list is a failure", async () => {
  const { fetchImpl } = fakeFetch(json({ data: [] }));
  await assert.rejects(
    fetchGatewayModels(KEY, AbortSignal.any([]), fetchImpl),
    (error) => error instanceof GatewayError && /no models/.test(error.message),
  );
});
