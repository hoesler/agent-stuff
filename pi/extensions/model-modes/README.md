# Model Modes

Select a provider, model, and Pi thinking level as one named mode.

## Configuration

Create `~/.pi/agent/model-modes.json`, or set `PI_MODEL_MODES_CONFIG` to an absolute path or a path relative to Pi's startup directory. The environment-selected file replaces the global file; files are never merged.

```json
{
  "version": 1,
  "defaultMode": "medium",
  "cycleShortcut": "f8",
  "modes": [
    {
      "id": "low",
      "label": "Low",
      "provider": "zai",
      "model": "glm-5.2",
      "thinkingLevel": "low",
      "description": "Fast, low-cost mode for small, well-defined tasks"
    },
    {
      "id": "medium",
      "label": "Medium",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "medium",
      "description": "Balanced intelligence, speed, and cost"
    },
    {
      "id": "high",
      "label": "High",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "high",
      "description": "Deep reasoning for hard tasks"
    },
    {
      "id": "ultra",
      "label": "Ultra",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "max",
      "description": "Maximum effort for hard, open-ended tasks"
    }
  ]
}
```

These provider and model IDs are examples. They are never used unless you copy this file to a selected configuration path.

Every mode is user-defined. The extension does not supply fallback modes and never writes this file — not even on your explicit request (see `/mode init` below).

If no configuration file exists yet, `/mode` and `/mode doctor` report **not configured** rather than a generic error, and point you at `/mode init`.

## Commands

- `/mode` — open the picker
- `/mode <id>` — select a mode
- `/mode next` — cycle forward
- `/mode previous` — cycle backward
- `/mode doctor` — validate config and model compatibility
- `/mode init` — ask the current model to draft a starter configuration from your installed models
- `/mode help` — show usage and resolved config path

In non-interactive contexts, `/mode` lists the configured modes instead of opening the picker.

### `/mode init`

If you have not authored `model-modes.json` yet, run `/mode init`. It gathers your currently available provider/model pairs (`ctx.modelRegistry.getAvailable()`) and sends the running agent a prompt asking it to design 3–4 modes (e.g. low/medium/high/ultra) using only those models, and to reply with exactly one fenced ` ```json ` block matching the configuration schema above.

`/mode init` only asks the model to *print* a suggested document as a normal chat reply — it never creates, writes, or edits any file itself. Copy the JSON block from the response and save it to the path shown in the prompt (also the path reported by `/mode doctor`).

## Reload behavior

Mapping edits are detected before the next command or shortcut action. Changing `cycleShortcut` requires `/reload`.

## Startup and Custom State

`defaultMode` applies only to fresh startup and `/new` sessions. Resumed, forked, and reloaded sessions keep their Pi state. `mode:custom` means the actual provider/model/thinking triple does not exactly match a configured mode.

## Status indicator

The footer status combines the active mode id with the currently active model and thinking level, e.g. `mode:high (gpt-5.6-sol · thinking:high)`. It reads `mode:custom (...)` when the live provider/model/thinking triple does not exactly match any configured mode, and just `mode:error` (no model detail) when the configuration itself is missing or invalid.

Mode descriptions are shown in the `/mode` picker list (and its non-interactive `/mode` listing), not in the status line or in the toast shown when a mode is applied.

### Custom editors/themes that replace the built-in footer (e.g. amp-themes)

`ctx.ui.setStatus()` only renders through Pi's built-in footer. Some themes (e.g. [`amp-themes`](https://github.com/hoesler/amp-themes)) draw their own editor chrome, blank the built-in footer entirely, and show their own model/thinking indicator instead — so the status above never appears there.

To cover that case, this extension also publishes the active mode label (bare `mode:<id>` or `mode:custom`; nothing while the configuration is missing/invalid) through a tiny, dependency-free contract: a shared `Set` of callbacks on `globalThis.__ampEditorStatusHooks`. Any consuming extension can read it without depending on this package. See `amp-themes`' README for the exact shape it expects and where it renders the label.

## Exposing the mode catalog to the agent (subagent dispatch)

Set `"exposeCatalogInSystemPrompt": true` at the top level of `model-modes.json` to append the configured modes to the system prompt on every turn:

```json
{
  "version": 1,
  "defaultMode": "medium",
  "exposeCatalogInSystemPrompt": true,
  "modes": [ ... ]
}
```

Each mode is rendered as a ready-to-use `provider/model:thinkingLevel` string plus its description:

```text
## Available model modes (model-modes extension)

When dispatching subagents (e.g. via the `subagent` tool's `model` parameter), pass one of these exact strings — including the `:level` suffix — to pin both the model and its thinking level for that task:

- `low` → `zai/glm-5.2:low` — Fast, low-cost mode for small, well-defined tasks
- `medium` → `openai/gpt-5.6-sol:medium` — Balanced intelligence, speed, and cost
- `high` → `openai/gpt-5.6-sol:high` — Deep reasoning for hard tasks
- `ultra` → `openai/gpt-5.6-sol:max` — Maximum effort for hard, open-ended tasks
```

This pairs well with skills that instruct an agent to pick a model tier per
subagent task (e.g. superpowers' subagent-driven-development skill's "cheap /
standard / most capable" guidance): the agent matches its own tier language
against each mode's `description` and passes the exact string straight
through to the `subagent` tool's `model` parameter, which understands the
trailing `:thinkingLevel` suffix directly.

This field is optional and defaults to `false` — existing configurations are
unaffected unless you opt in. When unset, invalid, or missing, no catalog is
added and no error text appears in the prompt.

## Doctor statuses

- `OK` — configuration is valid and every mode's model is currently available.
- `NOT_CONFIGURED` — no configuration file exists yet at the resolved path; run `/mode init` to draft one.
- `INVALID` — a configuration file exists but failed validation, or references a missing/incompatible model; the issues list explains why.
