import assert from "node:assert/strict";
import test from "node:test";
import { registerAmpEditorStatusHook } from "./status-hook.ts";

function hooks(): Set<() => string | undefined> {
  return (globalThis as unknown as { __ampEditorStatusHooks?: Set<() => string | undefined> }).__ampEditorStatusHooks!;
}

test("registerAmpEditorStatusHook adds to a shared global set and returns an unregister function", () => {
  const before = hooks()?.size ?? 0;
  const unregister = registerAmpEditorStatusHook(() => "mode:test");
  assert.equal(hooks().size, before + 1);
  assert.equal([...hooks()].some((hook) => hook() === "mode:test"), true);
  unregister();
  assert.equal(hooks().size, before);
});

test("multiple hooks can coexist without clobbering each other", () => {
  const before = hooks()?.size ?? 0;
  const unregisterA = registerAmpEditorStatusHook(() => "a");
  const unregisterB = registerAmpEditorStatusHook(() => "b");
  const values = [...hooks()].map((hook) => hook());
  assert.equal(values.includes("a"), true);
  assert.equal(values.includes("b"), true);
  unregisterA();
  unregisterB();
  assert.equal(hooks().size, before);
});

test("a hook returning undefined contributes nothing without breaking other hooks", () => {
  const unregisterSilent = registerAmpEditorStatusHook(() => undefined);
  const unregisterLoud = registerAmpEditorStatusHook(() => "loud");
  const values = [...hooks()].map((hook) => hook()).filter((value): value is string => Boolean(value));
  assert.deepEqual(values.sort(), ["loud"]);
  unregisterSilent();
  unregisterLoud();
});
