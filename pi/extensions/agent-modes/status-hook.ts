/**
 * Optional, dependency-free contract that lets a custom editor/theme extension
 * (e.g. `amp-themes`'s `amp-editor.ts`) surface this extension's active mode
 * label inline with its own model/thinking display, without either extension
 * depending on the other.
 *
 * Contract (documented so any third-party extension can opt in on either side):
 * - A shared `Set` of zero-argument functions is stored on
 *   `globalThis.__ampEditorStatusHooks`.
 * - Each function returns a short plain-text label to prepend (e.g. "mode:high"),
 *   or `undefined`/"" to contribute nothing right now.
 * - Consumers (like amp-editor) call every registered function on each render,
 *   ignore thrown errors, and join non-empty results with " · ".
 * - This module never imports from, or requires the presence of, the consuming
 *   extension; it only touches a well-known global key.
 */

export type AmpEditorStatusHook = () => string | undefined;

function ampEditorStatusHooks(): Set<AmpEditorStatusHook> {
  const g = globalThis as typeof globalThis & { __ampEditorStatusHooks?: Set<AmpEditorStatusHook> };
  if (!g.__ampEditorStatusHooks) g.__ampEditorStatusHooks = new Set();
  return g.__ampEditorStatusHooks;
}

/** Register a hook. Returns an unregister function. */
export function registerAmpEditorStatusHook(hook: AmpEditorStatusHook): () => void {
  const hooks = ampEditorStatusHooks();
  hooks.add(hook);
  return () => hooks.delete(hook);
}
