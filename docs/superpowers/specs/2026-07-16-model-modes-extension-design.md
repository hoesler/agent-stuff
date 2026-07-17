# Model Modes Pi Extension Design

**Date:** 2026-07-16

**Status:** Approved

## Summary

Add a purpose-built Pi extension that treats a provider, model, and thinking level as one named mode. Users define every mode in a required JSON configuration file. The extension provides direct selection, deterministic cycling, exact active-mode detection, fresh-session defaults, diagnostics, and a compact status indicator.

Version 1 changes only the model and Pi thinking level. It does not modify tools or the system prompt, infer a mode from the user's task, or edit the configuration from inside Pi.

## Goals

- Make model and effort selection one user action.
- Support arbitrary user-defined modes and providers without built-in model assumptions.
- Provide both direct mode selection and ordered cycling.
- Represent the active mode accurately when the model or effort changes outside the extension.
- Apply a configured default to fresh sessions without overriding resumed sessions.
- Allow separate Pi launches to select different mapping files through an environment variable.
- Fail safely and explain configuration, model, authentication, and effort incompatibilities.

## Non-goals

- Mode-specific tools or system prompts.
- Automatic routing based on task content.
- A configuration editor or setup wizard.
- Built-in Low, Medium, High, or Ultra mappings.
- Merging global, project, and environment-specific files.
- Persisting a separate active-mode value.

## Prior Art

### `@zigai/pi-model-modes`

Useful patterns:

- Session-aware default model application.
- Detection of model changes outside the extension.
- A distinct custom state.
- Model selection through Pi's registry.
- Thorough validation and tests.

Not adopted:

- In-Pi configuration editing.
- Project/global settings merging.
- File locking and patch-based writes.
- Editor border patches and mode colors.
- A separately persisted current mode.

### `pi-cycle`

Useful patterns:

- Model and thinking level as one profile.
- Deterministic array-based cycle order.
- Skipping unusable profiles while cycling.
- A doctor command with actionable diagnostics.
- Clear activation feedback.

Not adopted:

- OpenAI-specific discovery and defaults.
- Mutable configuration written by the extension.
- Low-context effort adjustment.
- A globally persisted active profile.
- A large menu-based configuration surface.

### Pi preset example

Pi's bundled `preset.ts` demonstrates the standard APIs used by this extension:

- `ctx.modelRegistry.find(provider, model)`
- `pi.setModel(model)`
- `pi.setThinkingLevel(level)`
- `pi.getThinkingLevel()`
- `ctx.ui.custom()` with `SelectList`
- `ctx.ui.setStatus()`

## Package Placement

The extension belongs in the existing Pi package at:

```text
pi/extensions/model-modes/
├── index.ts
├── config.ts
├── mode-state.ts
└── types.ts
```

Responsibilities:

- `index.ts`: register commands, the configured shortcut, events, and status updates.
- `config.ts`: resolve the source path, parse and validate JSON, and reload changed files.
- `mode-state.ts`: infer active modes, cycle modes, apply modes, and roll back failed applications.
- `types.ts`: configuration, diagnostics, and runtime interfaces.

The root `package.json` already discovers `pi/extensions`, so no Pi manifest change is required.

## Configuration

### Source resolution

Configuration is selected once per Pi process:

1. If non-empty, `PI_MODEL_MODES_CONFIG` names the configuration file.
2. Otherwise, use `~/.pi/agent/model-modes.json`.

An absolute environment path is used unchanged. A relative environment path is resolved against Pi's startup working directory. The extension does not merge files or fall back from an invalid environment-selected file to the global file.

The resolved path is visible through `/mode doctor` and `/mode help`. Configuration contents and paths are never sent to the model.

### Schema

```json
{
  "version": 1,
  "defaultMode": "medium",
  "cycleShortcut": "f8",
  "modes": [
    {
      "id": "medium",
      "label": "Medium",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "medium",
      "description": "Balanced intelligence, speed, and cost"
    }
  ]
}
```

Fields:

- `version`: required and exactly `1`.
- `defaultMode`: required mode ID applied to fresh sessions.
- `cycleShortcut`: optional Pi shortcut string. When absent, shortcut cycling is disabled.
- `modes`: required non-empty array. Array order is cycle order.
- `modes[].id`: required stable command identifier.
- `modes[].label`: optional display label; defaults to `id`.
- `modes[].provider`: required Pi provider ID.
- `modes[].model`: required model ID within the provider.
- `modes[].thinkingLevel`: required Pi thinking level.
- `modes[].description`: optional picker and notification text.

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

### Validation

The complete document is rejected when it has:

- Invalid JSON.
- An unsupported version.
- Unknown properties.
- An empty mode array.
- Duplicate mode IDs.
- Empty strings in required fields.
- Mode IDs containing whitespace.
- Reserved IDs: `next`, `previous`, `doctor`, and `help`.
- An unsupported thinking level.
- A `defaultMode` that does not identify a configured mode.
- Invalid shortcut syntax.

Duplicate provider/model/thinking triples are permitted because users may want separate labels for the same behavior. Exact matching chooses the first mode in array order.

The extension uses focused runtime validators rather than adding a schema-library dependency.

## User Interface

### Command surface

The extension registers one command namespace:

```text
/mode                 Open the mode picker
/mode <id>            Activate a mode directly
/mode next            Activate the next usable mode
/mode previous        Activate the previous usable mode
/mode doctor          Show configuration and compatibility diagnostics
/mode help            Show usage and the resolved configuration path
```

In non-interactive modes, `/mode` without arguments prints or reports the configured modes and usage instead of opening a picker.

### Picker

The picker uses Pi's `SelectList` and displays each mode's:

- Label and active marker.
- Provider/model.
- Thinking level.
- Optional description.

Selecting an item applies the complete mode.

### Shortcut

When `cycleShortcut` is configured and valid, the extension registers it to cycle forward. Shortcut registration happens during extension loading. Changing only the shortcut therefore requires `/reload`; all other mapping changes are detected without reloading Pi.

### Status

The extension uses Pi's standard extension status area:

```text
mode:medium
mode:custom
mode:error
```

- A named ID means Pi's actual provider, model, and effort exactly match that mode.
- `custom` means a valid configuration is loaded but the actual triple does not match.
- `error` means the selected configuration is missing or invalid.

The status is presentation only; actual Pi state remains authoritative.

## Runtime State and Data Flow

The runtime holds:

- The resolved configuration path.
- The latest file modification time.
- Either the latest valid parsed configuration or its current load error.
- The inferred active mode ID, `custom`, or `error`.
- An `applying` guard for extension-initiated model changes.

It does not write configuration or persist an active mode.

### Reload behavior

Before each command or shortcut operation, the extension checks the configuration file's modification time.

- A changed valid file replaces the entire in-memory configuration.
- A changed missing or invalid file disables mode operations and sets `mode:error`.
- The extension does not continue using stale mappings after a validation failure.
- Fixing the file makes the next operation usable without `/reload`.
- A changed shortcut is reported as requiring `/reload` because already registered shortcuts cannot be replaced safely in place.

Session event handlers use the latest loaded configuration. They do not perform synchronous file reads on every model or thinking event.

## Active-mode Inference

A mode matches only when all three values match Pi's actual state:

1. Provider ID.
2. Model ID.
3. Effective thinking level from `pi.getThinkingLevel()`.

The first exact match in array order becomes active. If no mode matches, the state is `custom`.

The extension re-infers state after:

- Session start.
- Successful or failed mode application.
- Pi's `model_select` event.
- Pi's `thinking_level_select` event.
- A valid configuration reload.

While `applying` is true, model and thinking events do not update the visible state. The state is inferred once after the complete operation to avoid transient mismatches.

## Applying a Mode

### Preflight

Before changing Pi state, the extension:

1. Finds the target with `ctx.modelRegistry.find(provider, model)`.
2. Rejects a missing model.
3. Rejects non-`off` effort for a model marked as non-reasoning.
4. Rejects thinking levels explicitly disabled by the model's `thinkingLevelMap`.
5. Captures the current model and thinking level for rollback.

Authentication may not be fully testable without attempting `pi.setModel()`, so activation remains the final authority.

### Activation

1. Set `applying = true`.
2. Call `pi.setModel(target)`.
3. If it returns `false` or throws, do not change thinking and report failure.
4. Call `pi.setThinkingLevel(configuredLevel)`.
5. Read `pi.getThinkingLevel()`.
6. If the effective level differs from the requested level, treat activation as failed and attempt rollback.
7. Clear `applying`, infer actual state, update status, and notify the user.

A successful notification includes the mode label and optional description.

### Rollback

If model activation succeeded but effort application did not:

1. Attempt to restore the previous model with `pi.setModel(previousModel)`.
2. If model restoration succeeds, restore the previous thinking level.
3. Infer actual state regardless of rollback outcome.
4. Report whether rollback succeeded.

This provides best-effort transactional behavior over Pi APIs that do not expose a single atomic model-and-effort operation. The extension never claims atomicity when rollback fails.

## Cycling

Cycle order is the order of `modes[]`.

Forward and backward cycling:

1. Use the exact active mode as the base when available.
2. When state is `custom`, start from before the first mode for forward cycling and after the last mode for backward cycling.
3. Attempt each mode at most once.
4. Skip modes that fail before changing state or that fail after a successful rollback.
5. Stop immediately if rollback fails, avoiding cascading changes from an uncertain state.
6. Stop at the first successful mode.
7. If none succeeds, preserve the resulting actual Pi state and show one summary warning.

Direct `/mode <id>` does not skip to another mode; it reports that mode's failure.

## Startup Semantics

The configured default is applied only to genuinely fresh sessions:

- `session_start` with reason `new` is fresh.
- Initial startup is fresh only when the session contains no conversational content and at most Pi's initial model/thinking state entries.
- `resume`, `fork`, and `reload` are not fresh.

For a fresh session:

1. Load and validate configuration.
2. Apply `defaultMode` through the normal guarded activation path.
3. If activation fails, leave or restore Pi's existing state where possible and warn.

For an existing session, the extension only infers the active mode from Pi's restored model and effort.

## Diagnostics and Error Handling

### `/mode doctor`

The report includes:

- Resolved configuration path.
- Whether `PI_MODEL_MODES_CONFIG` is active.
- Parse and validation errors with property paths.
- Effective default and cycle order.
- Registered and configured shortcut values, including reload requirements.
- Missing models.
- Models currently unavailable according to Pi's registry.
- Non-reasoning models with non-`off` effort.
- Effort levels excluded by `thinkingLevelMap`.

In TUI mode, the report opens through `ctx.ui.editor()` and any returned edits are discarded. In non-interactive modes, the command writes the report to standard output.

### Failure policy

- Missing or invalid configuration never prevents Pi startup.
- Invalid configuration disables switching instead of creating implicit defaults.
- Startup activation failures do not terminate the session.
- Explicit activation failures produce concise warnings.
- Cycling consolidates skipped-mode failures into a final warning rather than showing a notification for every attempt.
- File paths are shown only in user-facing diagnostics and never injected into model context.

## Testing Strategy

The implementation adds root package scripts for type checking and tests. Tests use a lightweight TypeScript-compatible runner and fake Pi contexts; they do not require live provider credentials.

### Configuration tests

- Global path resolution.
- Absolute and relative environment overrides.
- Empty environment variable behavior.
- Valid document parsing.
- Rejection of every schema violation.
- Unknown property detection.
- Modification-time reload behavior.
- Recovery after fixing an invalid file.
- Shortcut-change reload detection.

### Mode-state tests

- Exact triple matching.
- `custom` and `error` state inference.
- First match for duplicate triples.
- Forward and backward order.
- Custom-state cycle starting points.
- Fresh-session classification.
- Resumed, forked, and reloaded session preservation.

### Application tests

- Successful model and effort application.
- Missing model preflight.
- Non-reasoning incompatibility.
- Explicitly unsupported thinking level.
- `pi.setModel()` returning `false`.
- `pi.setModel()` throwing.
- Effort clamping detected through read-back.
- Successful rollback.
- Failed rollback and accurate resulting state.
- Cycling past unusable modes after preflight failures or successful rollback.
- Cycling stops after failed rollback.
- Direct selection not falling through to another mode.

### Extension wiring tests

- Command registration and subcommand dispatch.
- Optional shortcut registration.
- Picker selection.
- Non-interactive `/mode` behavior.
- Model and thinking event handling.
- Suppression of intermediate state during application.
- Status updates.
- Default application only for fresh sessions.

## Acceptance Criteria

- A valid user-authored file can define any number of ordered modes.
- `PI_MODEL_MODES_CONFIG` selects an alternate complete mapping file.
- `/mode` directly selects a configured model-and-effort pair.
- The configured shortcut cycles through modes in array order.
- `/mode next` and `/mode previous` skip unusable modes.
- Manual model or effort changes produce `mode:custom` unless an exact mode matches.
- Fresh sessions apply `defaultMode`; resumed and forked sessions retain their state.
- Missing, invalid, or incompatible configuration never crashes Pi and is explained by `/mode doctor`.
- The extension never writes the mapping file or invents model defaults.
- Type checking and automated tests pass.

## Alternatives Rejected

### Fork `@zigai/pi-model-modes`

Rejected because its settings UI, persistence, file-write concurrency, and editor customization add substantial complexity unrelated to the required JSON-only behavior.

### Wrap an installed mode package

Rejected because a wrapper would create multiple configuration sources, package-version coupling, and awkward command and startup interactions.

### Extend Pi's general preset example

Rejected because presets intentionally include tools and prompt instructions, while this extension needs a narrower model-and-effort contract and environment-selected configuration.

## Addendum (post-implementation): Missing-Configuration UX and `/mode init`

After initial implementation and install, a fresh user with no `~/.pi/agent/model-modes.json` saw a generic `Status: ERROR` / raw `ENOENT` message from `/mode doctor`, indistinguishable from an actually-broken configuration. This addendum captures two follow-up decisions and their scope.

### Decision: distinguish "not configured" from "invalid"

`ConfigSnapshot`'s failure variant now carries `reason: "missing" | "invalid"`. `"missing"` means `stat()` on the resolved path failed (no file present or inaccessible); `"invalid"` means the file was read but failed JSON parsing or schema validation. `DoctorReport.status` is now `"OK" | "NOT_CONFIGURED" | "INVALID"` (previously `"OK" | "ERROR"`). User-facing warnings from `/mode`, `/mode <id>`, `/mode next`, and `/mode previous` use a friendlier, distinct message for the missing case that names `/mode init`, and a separate message for genuinely invalid configuration that points at `/mode doctor`. This is a pure messaging/classification change; it does not alter when mode switching is blocked (still blocked whenever `snapshot.ok` is false, for either reason).

### Decision: `/mode init` — model-drafted starter config, still never written by the extension

The constraint "the extension never writes the mapping file" is preserved exactly. `/mode init` is a new reserved subcommand (added to `RESERVED_IDS` in `config.ts`) that:

1. Reads `ctx.modelRegistry.getAvailable()` to get the user's actually configured/authenticated models.
2. Builds a prompt describing the `model-modes.json` schema, the resolved target path, and the available model catalog, asking the running agent to pick a sensible spread of modes using only listed models and to reply with exactly one fenced ` ```json ` block plus a one-line save instruction, and explicitly instructing the agent not to create, write, or modify any file itself.
3. Delivers that prompt via `pi.sendUserMessage(...)`, i.e. as a normal user turn processed by whatever model/session is currently active — no direct LLM API call is made by the extension, and no separate inference dependency or credential is introduced.

This keeps "no production path may write/mutate the mapping file" true at the extension-code level: the extension's own code contains no `writeFile`/`appendFile`/`fs.write` call on the config path, matching all prior tasks. The generated suggestion is plain chat output the user must manually save; nothing at the extension layer persists it. (It is possible for the agent's own turn to subsequently use a general-purpose file-write tool if the user asks it to — that would be the same as the user asking Pi to write any other file, and is intentionally outside this extension's control surface, exactly as it was before this addendum for any other file in the user's project.)

This was scoped as a single follow-up task (not part of the original six-task plan) and was implemented and reviewed after the branch's final whole-branch review had already approved the original six tasks.
