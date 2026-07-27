# Subagent

Delegate tasks to specialized subagents, each running in a separate `pi` process with its own isolated context window.

## Modes

- **Single** — `{ agent: "name", task: "..." }`
- **Parallel** — `{ tasks: [{ agent: "name", task: "..." }, ...] }` (up to 8 concurrent tasks, 4 at a time)
- **Chain** — `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }`, where `{previous}` is replaced with the prior step's final output

Exactly one mode must be provided per call.

## Agents

Agents are discovered from Markdown files with frontmatter:

- User agents: `~/.pi/agent/agents/*.md`
- Project agents: nearest `.pi/agents/*.md` above the current working directory

Each agent file's frontmatter supports `name`, `description`, `tools` (comma-separated), and `model`. The Markdown body becomes the subagent's system prompt.

Use `agentScope` to control which agents are visible: `"user"` (default), `"project"`, or `"both"`. Running project-local agents prompts for confirmation in interactive sessions (`confirmProjectAgents`, default `true`) since project agents are repo-controlled.

## Model selection

A subagent's model is resolved with the following precedence:

1. Per-task/per-step `model` (chain step or parallel task)
2. Top-level `subagent.model` (applies to all tasks in the call)
3. Agent frontmatter `model`
4. Child Pi's own default (no explicit model)

The usage line for each result shows a short source label indicating which of these applied:

| Label           | Meaning                                                                          |
| --------------- | --------------------------------------------------------------------------------- |
| `[agent]`       | The *calling* agent explicitly set the model — either a per-task/per-step override or the top-level `subagent.model` override |
| `[frontmatter]` | Model came from the subagent persona's own `model:` frontmatter field           |
| `[pi-default]`  | No explicit model anywhere; the child Pi process chose its own default          |

`[agent]` deliberately covers both override forms (per-task and whole-call): in both cases it's the orchestrating agent that made the explicit choice, not the persona's own configuration.

## Resolved model display

The displayed model is the one the child process actually used, not the raw value that was requested — so aliases or mode-like values (e.g. `ultra` from a model-modes catalog) never appear as though they were the real model name.

The resolved model is read from the child's assistant message: `provider/responseModel` when the provider reports a response model, otherwise `provider/model`. Only once that message arrives does the display switch from the requested value to the resolved one.

If the child process never produces an assistant message (e.g. it crashes or is aborted immediately), the display falls back to the originally requested model (if one was given), or an `(unresolved)` marker when no explicit model was supplied.

A thinking level requested as a `:<level>` suffix (as produced by the model-modes catalog) is re-attached to the resolved model. Assistant messages carry only provider and model — never the thinking level — so the level cannot be read back from the child and would otherwise vanish the moment the model resolved. Only the segment after the *last* colon counts, and only when it names a valid level, so model ids that legitimately contain colons (`openai/gpt-4o:extended`, `llama3.1:8b`) are left intact.

Example usage line:

```text
7 turns ↑14 ↓1.4k R92k W16k $0.0736 ctx:18k github-copilot/claude-sonnet-5:high [agent]
```

For chain and parallel modes, each expanded step/task line shows its own resolved model and source; aggregate "Total" lines remain model-neutral since they combine potentially different models across steps/tasks.

## Testing

Pure model-selection and display logic lives in `model-display.ts` and is covered by `model-display.test.ts`:

```bash
node --test pi/extensions/subagent/model-display.test.ts
```
