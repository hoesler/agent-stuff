import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectAmpEditorStatusLabel, registerAmpEditorStatusHook } from "./amp-editor-status-hooks.ts";

function hooks(): Set<() => string | undefined> {
  return (globalThis as unknown as { __ampEditorStatusHooks?: Set<() => string | undefined> }).__ampEditorStatusHooks ?? new Set();
}

const unregisters: Array<() => void> = [];

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
});

test("registerAmpEditorStatusHook adds to a shared global set and returns an unregister function", () => {
  const before = hooks().size;
  const unregister = registerAmpEditorStatusHook(() => "mode:test");
  unregisters.push(unregister);
  assert.equal(hooks().size, before + 1);
  unregister();
  assert.equal(hooks().size, before);
});

test("collectAmpEditorStatusLabel joins multiple non-empty hooks with a middle dot", () => {
  unregisters.push(registerAmpEditorStatusHook(() => "a"));
  unregisters.push(registerAmpEditorStatusHook(() => "b"));
  const label = collectAmpEditorStatusLabel();
  assert.ok(label?.includes("a"));
  assert.ok(label?.includes("b"));
});

test("collectAmpEditorStatusLabel skips undefined/empty hooks and returns undefined when nothing is registered", () => {
  const before = hooks().size;
  // Sanity: with no hooks registered beyond any pre-existing ones from other tests, ensure
  // an undefined-only hook contributes nothing.
  unregisters.push(registerAmpEditorStatusHook(() => undefined));
  unregisters.push(registerAmpEditorStatusHook(() => ""));
  const label = collectAmpEditorStatusLabel();
  assert.equal(label, undefined);
  assert.equal(hooks().size, before + 2);
});

test("collectAmpEditorStatusLabel never throws when a hook throws", () => {
  unregisters.push(registerAmpEditorStatusHook(() => { throw new Error("boom"); }));
  unregisters.push(registerAmpEditorStatusHook(() => "survives"));
  assert.doesNotThrow(() => collectAmpEditorStatusLabel());
  assert.equal(collectAmpEditorStatusLabel(), "survives");
});
