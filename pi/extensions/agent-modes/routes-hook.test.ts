import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type ModelRouteResolver, registerModelRouteResolver } from "./routes-hook.ts";

const global = globalThis as { __piModelRouteResolvers?: Set<ModelRouteResolver> };

afterEach(() => {
  global.__piModelRouteResolvers?.clear();
});

test("registers a resolver on the well-known global key", () => {
  registerModelRouteResolver((key) => (key === "oracle" ? "anthropic/claude-fable-5:high" : undefined));
  const answers = [...(global.__piModelRouteResolvers ?? [])].map((fn) => fn("oracle"));
  assert.deepEqual(answers, ["anthropic/claude-fable-5:high"]);
});

test("the returned function unregisters it", () => {
  const unregister = registerModelRouteResolver(() => "x");
  unregister();
  assert.equal(global.__piModelRouteResolvers?.size, 0);
});

test("several publishers coexist", () => {
  registerModelRouteResolver(() => undefined);
  registerModelRouteResolver(() => "y");
  assert.equal(global.__piModelRouteResolvers?.size, 2);
});
