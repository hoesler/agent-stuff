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

A selection pinned on the command line wins over `defaultMode`: when the invocation contains `--model`, `--models`, `--provider`, or `--thinking`, no mode is applied at startup. This keeps `pi --model <x>` and subagents spawned with an explicit model on the model that was asked for. The status line then reads `mode:custom` unless the pinned selection happens to match a configured mode exactly.

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

## Routes

A route is a named key that resolves to a model, per mode. It answers "when I am
in this mode, which model is my *second opinion*?" — a question a mode catalog
cannot answer, because the target is not the mode you are running.

Both fields are optional. With neither present, behavior is exactly as before:
nothing is published and nothing is rendered.

```json
{
  "version": 1,
  "defaultMode": "medium",
  "defaultRoutes": {
    "oracle": {
      "provider": "anthropic",
      "model": "claude-fable-5",
      "thinkingLevel": "high",
      "description": "A second-opinion model, deliberately different from the one you are running on"
    }
  },
  "modes": [
    { "id": "low", "provider": "zai", "model": "glm-5.2", "thinkingLevel": "low",
      "routes": { "oracle": false } },
    { "id": "high", "provider": "openai", "model": "gpt-5.6-sol", "thinkingLevel": "high",
      "routes": { "oracle": { "provider": "google", "model": "gemini-4", "thinkingLevel": "max" } } }
  ]
}
```

- `defaultRoutes` — route key to target, applying to every mode that does not say otherwise.
- `modes[].routes` — route key to target, or `false` to opt this mode out of a default.
- A target is the same shape as a mode target: `provider`, `model`, optional
  `thinkingLevel` (default `off`, rendered without a `:off` suffix), and an
  optional `description` used only by the catalog block below.
- Route keys must be non-empty and must not contain `/`. That is what lets a
  consumer tell a key from a `provider/model` reference.

Resolution for a key, against the active mode:

1. the active mode sets it to `false` → no route;
2. the active mode gives a target → that target;
3. `defaultRoutes` has the key → that target;
4. otherwise → no route.

`mode:custom` and `mode:error` have no mode entry, so they land on step 3. That
is the point of `defaultRoutes`: a session pinned with `--model` still has a
second opinion.

A target that equals the live provider/model/thinkingLevel triple exactly
resolves to nothing. A second opinion from the model you are already running is
not a second opinion.

Routes are recomputed whenever the active mode can have changed — mode
activation, session start, model or thinking-level selection, and config reload —
so a mid-session `/mode` switch takes effect on the next dispatch with nothing to
invalidate.

### Consuming routes

Resolved routes are published through a dependency-free contract, the same shape
as the status hook above: a shared `Set` of resolver functions on
`globalThis.__piModelRouteResolvers`. A resolver takes a route key and returns a
`provider/model[:thinkingLevel]` string, or `undefined` to decline. Consumers
call every registered function at the moment they need a model, ignore thrown
errors, and take the first non-empty answer. Resolution is pull, not push, so
load order does not matter and a mode change needs no invalidation.

The `subagent` extension is the intended consumer: its personas' `model:`
frontmatter accepts a bare route key, resolved at dispatch time. See
`routes-hook.ts` for the full documented contract.

When `exposeCatalogInSystemPrompt` is on, resolved keys are also listed in the
catalog block, **by key only** — never as a resolved model string:

```text
Routes (resolved for the active mode; pass the key, not a model string):

- `oracle` — A second-opinion model, deliberately different from the one you are running on
```

A key suppressed by `false` or by the redundancy rule simply does not appear. The
prompt is built once per turn while the mode can change at any moment, so a
literal model string here would hand the agent a stale route; the key is stable
and resolved late.

## Doctor statuses

- `OK` — configuration is valid and every mode's model is currently available.
- `NOT_CONFIGURED` — no configuration file exists yet at the resolved path; run `/mode init` to draft one.
- `INVALID` — a configuration file exists but failed validation, or references a missing/incompatible model; the issues list explains why.
