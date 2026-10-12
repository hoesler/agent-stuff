# amp-ui

[Amp](https://ampcode.com)-inspired UI for pi:

- **Editor chrome.** A rounded editor box. Context-window usage and session cost
  sit top-left, `model · thinking` top-right, and the working status with
  `cwd (branch)` along the bottom border. It replaces pi's footer and working row.
- **User messages.** Compact, with a bar in the current thinking level's color.
- **Tool display.** Amp-style rendering for the built-in tools (read, grep,
  find, ls, bash, edit, write): compact headers, collapsed output previews, a
  live bash spinner, colored edit diffs. The renderers are registered with
  `pi.registerToolRenderer()`, so the tools themselves are never re-registered:
  whichever implementation is registered under these names keeps its
  execution, schema and prompt text, and disabled tools stay disabled. Other
  tools, MCP included, keep their own rendering. Needs pi 1.0.1 or later.
- **Themes.** `amp-dark`, `amp-light` and `amp-gruvbox-dark-hard`, shipped in
  `pi/themes`. While an `amp-dark`/`amp-light` theme is active, it follows the
  device appearance.

Forked from [amp-themes](https://github.com/me-frankan/amp-themes) by Frank
(MIT, see `LICENSE`).

## What changed from amp-themes

- Third-party extensions can prepend a status label to the model row (see
  below). The chrome hides pi's footer, so `ctx.ui.setStatus()` never shows.
- The context-window usage is back in the top-left corner.
- Console output from other extensions (e.g. pi-web-access's `gh` hint) shows
  as a notification. Before, it landed raw at the cursor, inside the prompt box,
  and stuck there until that row was redrawn.
- `amp-gruvbox-dark-hard` is kept, where upstream dropped it.
- The built-in tools are no longer re-registered to swap their renderers. That
  re-registration activated `grep`, `find` and `ls`, re-enabled tools turned
  off with `--tools`, bound the tools to the cwd pi started in, and replaced any
  other extension's version of these tools.
- Packaging: the four upstream extensions load through one `index.ts`, the
  tests run on `node:test` instead of vitest, and parameter properties became
  plain fields so Node can strip the types.

## Install

Remove `npm:amp-themes` first, from the packages in `~/.pi/agent/settings.json`
or through `pi config`; both would draw the same tools. Packages that render
the built-in tools differently, such as `npm:pi-tool-display`, are best left
out too: amp-ui's renderers win over a tool's own, and between two renderer
extensions the one loaded first wins. Then enable this extension for the
`hoesler` package:

```
+pi/extensions/amp-ui/index.ts
```

and pick a theme:

```json
{
  "theme": "amp-dark"
}
```

Set `AMP_APPEARANCE=dark` or `AMP_APPEARANCE=light` to pin the appearance
instead of following the device.

## Status labels in the model row

Any extension can prepend a short label, such as a mode name, to the
`model · thinking` text. The contract is a `Set` on `globalThis`, so nothing
needs to import this extension:

```ts
type AmpEditorStatusHook = () => string | undefined;

function ampEditorStatusHooks(): Set<AmpEditorStatusHook> {
  const g = globalThis as typeof globalThis & { __ampEditorStatusHooks?: Set<AmpEditorStatusHook> };
  if (!g.__ampEditorStatusHooks) g.__ampEditorStatusHooks = new Set();
  return g.__ampEditorStatusHooks;
}

// Return a label, or undefined/"" to show nothing right now.
ampEditorStatusHooks().add(() => "mode:high");
```

Every hook runs on each render, and one that throws is skipped. Non-empty labels
are joined with ` · ` in front of the model: `mode:high · claude-sonnet-5 · high`.
`amp-editor-status-hooks.ts` exports `registerAmpEditorStatusHook` and
`collectAmpEditorStatusLabel` with the same shape.
