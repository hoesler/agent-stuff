/**
 * Unit tests for the tool renderer resolver: ours for the built-in tools,
 * merged over what the rest of the chain resolves, and a pass-through for every
 * other tool.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExtensionAPI, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import ampToolDisplay, { resolveAmpToolRenderers } from "./amp-tool-display.ts";
import { renderBashCall, renderBashResult } from "./amp-tools-bash.ts";
import { renderEditCall } from "./amp-tools-edit.ts";

const BUILT_INS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

describe("resolveAmpToolRenderers", () => {
  test("uses our renderers for every built-in tool", () => {
    for (const name of BUILT_INS) {
      const resolved = resolveAmpToolRenderers(name, () => undefined);
      assert.equal(typeof resolved?.renderCall, "function", name);
      assert.equal(typeof resolved?.renderResult, "function", name);
    }
    const bash = resolveAmpToolRenderers("bash", () => undefined);
    assert.equal(bash?.renderCall, renderBashCall);
    assert.equal(bash?.renderResult, renderBashResult);
  });

  test("keeps the rest of the chain's renderers, such as edit's own shell", () => {
    const next: ToolRenderers = { renderShell: "self", renderCall: () => assert.fail("replaced") };
    const resolved = resolveAmpToolRenderers("edit", () => next);
    assert.equal(resolved?.renderShell, "self");
    assert.equal(resolved?.renderCall, renderEditCall);
  });

  test("passes other tools through untouched", () => {
    const next: ToolRenderers = { renderShell: "default" };
    assert.equal(resolveAmpToolRenderers("mcp__docs__search", () => next), next);
    assert.equal(resolveAmpToolRenderers("toString", () => undefined), undefined);
  });

  test("registers a renderer resolver and no tools", () => {
    const resolvers: ToolRendererResolver[] = [];
    const pi = {
      registerToolRenderer: (resolver: ToolRendererResolver) => resolvers.push(resolver),
      registerTool: () => assert.fail("must not re-register built-in tools"),
    } as unknown as ExtensionAPI;
    ampToolDisplay(pi);
    assert.deepEqual(resolvers, [resolveAmpToolRenderers]);
  });
});
