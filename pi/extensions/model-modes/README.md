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

Every mode is user-defined. The extension does not supply fallback modes and never writes this file.

## Commands

- `/mode` — open the picker
- `/mode <id>` — select a mode
- `/mode next` — cycle forward
- `/mode previous` — cycle backward
- `/mode doctor` — validate config and model compatibility
- `/mode help` — show usage and resolved config path

In non-interactive contexts, `/mode` lists the configured modes instead of opening the picker.

## Reload behavior

Mapping edits are detected before the next command or shortcut action. Changing `cycleShortcut` requires `/reload`.

## Startup and Custom State

`defaultMode` applies only to fresh startup and `/new` sessions. Resumed, forked, and reloaded sessions keep their Pi state. `mode:custom` means the actual provider/model/thinking triple does not exactly match a configured mode.
