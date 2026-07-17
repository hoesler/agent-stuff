# Model Modes: System-Prompt Catalog for Subagent Dispatch

**Date:** 2026-07-17

**Status:** Approved

## Summary

Extend the existing `model-modes` Pi extension with an opt-in feature that
appends the user's configured mode catalog to the system prompt. This gives a
controller agent (e.g. one following the subagent-driven-development skill)
the exact `provider/model:thinkingLevel` string for each named mode, so it can
pass a concrete, correct value to the `subagent` tool's `model` parameter
instead of guessing a model name from training data.

This is an addendum-style extension of the model-modes design
(`2026-07-16-model-modes-extension-design.md`), following the same pattern
already used for that document's `/mode init` addendum: a scoped follow-up,
not a rewrite.

## Problem

The subagent-driven-development skill instructs the controller to pick a
model tier ("cheap", "standard", "most capable") per dispatched task and to
"always specify the model explicitly when dispatching a subagent." In
practice the controller has to invent a literal model string from its own
training knowledge, which:

- may not match any model the user actually has configured/authenticated
- has no reliable way to reflect the user's own cost/capability preferences
- duplicates information that already lives in `model-modes.json`

Meanwhile, `model-modes.json` already encodes exactly this information —
provider, model, thinking level, and a human-readable description per named
mode — but v1 of the extension deliberately never touches the system prompt
(a stated non-goal), so the controller has no way to see it.

## Goals

- Surface the user's configured mode catalog (id, `provider/model` +
  effective thinking-level suffix, description) inside the system prompt.
- Give the controller a ready-to-use string for the `subagent` tool's
  `model` parameter — no assembly or guessing required.
- Keep this fully opt-in and backward compatible: existing installs with no
  flag set see zero behavior change.
- Reuse `model-modes.json` as the single source of truth; no new
  configuration file or schema field.

## Non-goals

- No change to the subagent-driven-development skill itself (it lives in an
  external, separately-versioned skill repository, not this project). The
  model-modes README instead gets a short note describing the pairing so
  users can discover it.
- No formal mapping from the skill's tier vocabulary ("cheap" / "standard" /
  "most capable") to specific mode IDs. The existing `description` field
  already reads as tier guidance (e.g. "Fast, low-cost mode for small,
  well-defined tasks"); the controller matches tasks to modes using that
  free text, the same way it already reads any other prose guidance.
- No attempt to control per-task thinking level through a new subagent-tool
  parameter. Effort is carried entirely inside the existing `:thinkingLevel`
  suffix convention `pi-subagents` already parses from the `model` string
  (confirmed in `pi-args.ts`'s `applyThinkingSuffix`), so no changes to
  `pi-subagents` are needed either.
- No injection when configuration is missing or invalid — the extension
  never surfaces raw config errors through the system prompt.

## Design

### Configuration

Add one optional top-level field to the existing schema:

```json
{
  "version": 1,
  "defaultMode": "medium",
  "exposeCatalogInSystemPrompt": true,
  "modes": [ ... ]
}
```

- `exposeCatalogInSystemPrompt`: optional boolean, default `false`. When
  absent or `false`, behavior is identical to today's model-modes — no
  system prompt changes, no new hook registered.
- No other schema changes. Duplicate/validation rules from the v1 design are
  unaffected.

### Injection mechanism

Register a `before_agent_start` handler (alongside the extension's existing
event handlers) that:

1. Reads the current `ConfigSnapshot`.
2. If `exposeCatalogInSystemPrompt` is not `true`, or the snapshot is not
   `ok: true`, returns `event` unchanged (no injection, no warning text).
3. Otherwise appends a catalog block to `event.systemPrompt` and returns the
   modified event.

Injection happens on every qualifying turn — it is **not** gated on whether
the `subagent` tool is active in the current tool set, since subagent
tooling availability can change over a session and the block is small.

### Catalog format

One line per mode, in `modes[]` array order, each combining provider, model,
and thinking level into the single string the `subagent` tool's `model`
parameter already accepts:

```
## Available model modes (model-modes extension)

When dispatching subagents (e.g. via the `subagent` tool's `model`
parameter), pass one of these exact strings — including the `:level`
suffix — to pin both the model and its thinking level for that task:

- `low` → `zai/glm-5.2:low` — Fast, low-cost mode for small, well-defined tasks
- `medium` → `openai/gpt-5.6-sol:medium` — Balanced intelligence, speed, and cost
- `high` → `openai/gpt-5.6-sol:high` — Deep reasoning for hard tasks
- `ultra` → `openai/gpt-5.6-sol:max` — Maximum effort for hard, open-ended tasks
```

- Format per mode: `` `id` → `provider/model:thinkingLevel` — description ``.
- A mode with `thinkingLevel: "off"` omits the suffix (matching
  `applyThinkingSuffix`'s own behavior of not appending `:off`).
- A mode with no `description` omits the trailing `— description` segment
  rather than printing an empty dash.
- The intro line is fixed, short, and does not repeat on every mode (avoids
  needless prompt bloat).

### Error handling

- Missing config, invalid config, or the flag left unset → no injection, no
  error text in the prompt. Matches the v1 extension's existing "fail
  safely" philosophy — this feature can never break a session, at worst it
  is silently inactive.
- Reload semantics reuse the extension's existing modification-time check;
  no new file-watching logic is introduced. A config edited mid-session
  (enabling the flag, adding/removing modes) is reflected on the next
  qualifying turn, consistent with how `/mode` already detects live edits.

### Documentation

- Add a short section to the model-modes `README.md` describing:
  - the `exposeCatalogInSystemPrompt` flag and its default-off behavior
  - the exact catalog format shown above
  - a pointer to the subagent-driven-development skill as the intended
    consumer, without editing that skill's own repository

## Testing Strategy

Extends the existing test suite (lightweight TypeScript-compatible runner,
fake Pi contexts, no live provider credentials):

- Flag unset or `false` → `before_agent_start` handler not registered, or
  registered but a no-op; system prompt unchanged either way.
- Flag `true`, snapshot `ok: false` (missing or invalid) → system prompt
  unchanged.
- Flag `true`, valid snapshot → system prompt gains exactly the expected
  catalog block, formatted per the rules above.
- Modes with `thinkingLevel: "off"` produce no `:off` suffix.
- Modes with no `description` produce no dangling `—` separator.
- Catalog line order matches `modes[]` array order.
- A config reload (mtime change) that toggles the flag or edits modes is
  reflected on the next `before_agent_start` call without requiring
  `/reload`.

## Acceptance Criteria

- Existing installs without `exposeCatalogInSystemPrompt` set see no change
  in system prompt content or extension behavior.
- Setting `exposeCatalogInSystemPrompt: true` with a valid config appends a
  catalog block usable verbatim as the `subagent` tool's `model` argument
  (including thinking-level suffix) for every configured mode.
- Missing/invalid configuration with the flag on results in no injected
  block and no visible error in the prompt.
- Type checking and automated tests pass.

## Alternatives Rejected

### Standalone extension reading the same config file

Considered to avoid touching model-modes' documented v1 non-goals at all.
Rejected because it would split one logical concern (what modes exist, and
how they're surfaced) across two independently-versioned extensions with an
implicit, undocumented shared-file contract, for no real decoupling benefit
— nothing about system-prompt injection needs a different config source,
reload strategy, or validation path than model-modes already has.

### Formal tier field (`tier: "cheap" | "standard" | "capable"`) in schema

Considered as an explicit, unambiguous bridge to the subagent-driven-
development skill's vocabulary. Rejected because the existing free-text
`description` field already does this work in practice (verified against
the shipped `example.json`), and adding a second parallel vocabulary that
must be kept consistent with `description` is unnecessary schema surface
for no behavioral gain — the controller reads prose either way.

### New per-task thinking-level parameter in `pi-subagents`

Rejected because it's unnecessary: `pi-subagents` already parses a
`:thinkingLevel` suffix directly out of the `model` string
(`applyThinkingSuffix` in `pi-args.ts`), so the catalog can encode effort by
construction without any change to `pi-subagents` itself.

### Always-on injection (no opt-in flag)

Considered for simplicity. Rejected because it would change system prompt
content for every existing model-modes user without their consent, which
conflicts with the extension's established pattern of being inert until a
user opts into each new capability (e.g. `cycleShortcut` is also optional
and inert when absent).
