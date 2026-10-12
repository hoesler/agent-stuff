/**
 * Optional, dependency-free extension point: any third-party Pi extension
 * (e.g. a mode/preset picker) can register a short status label to be shown
 * inline with amp-editor's model/thinking indicator, without amp-themes
 * depending on that extension or vice versa.
 *
 * Contract:
 * - A shared `Set` of zero-argument functions lives on
 *   `globalThis.__ampEditorStatusHooks`.
 * - Each function returns a short plain-text label (e.g. "mode:high") to
 *   prepend, or `undefined`/"" to contribute nothing right now.
 * - amp-editor calls every registered function on each render, ignores
 *   thrown errors, and joins non-empty results with " · ".
 *
 * Third-party extensions do not need to import this file; they can write to
 * the same global key directly. It is exported here purely for convenience
 * and to document the exact shape of the contract.
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

/** Collect all currently-registered hook results, joined with " · ". Never throws. */
export function collectAmpEditorStatusLabel(): string | undefined {
  const parts: string[] = [];
  for (const hook of ampEditorStatusHooks()) {
    try {
      const value = hook();
      if (value) parts.push(value);
    } catch {
      // A misbehaving third-party hook must never break the editor.
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
