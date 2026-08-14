# Subagent

Delegate tasks to specialized subagents, each running in a separate `pi` process with its own isolated context window.

## Modes

- **Single** — `{ agent: "name", task: "..." }`
- **Parallel** — `{ tasks: [{ agent: "name", task: "..." }, ...] }` (up to 8 concurrent tasks, 4 at a time)
- **Chain** — `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }`, where `{previous}` is replaced with the prior step's final output

Exactly one mode must be provided per call.

## Timeouts

`timeoutSeconds` bounds a run's wall clock. It is set per task or per step, with a whole-call value as the fallback — the same precedence as `model`. There is deliberately no default: only the caller knows whether it asked for a one-file read or a module-wide refactor, and any number this extension picked would be wrong for one of them. Omitted, a run is unbounded, exactly as before.

On expiry the child gets `SIGTERM`, then `SIGKILL` five seconds later if it is still alive. The run is *not* discarded: it comes back with `stopReason: "timeout"`, an error message naming the budget, and everything the subagent produced before it was killed — output, tool calls, tokens, and cost. For a timeout that partial output is the main evidence for choosing a larger budget on the retry.

## Termination and partial results

A run killed from outside — by `timeoutSeconds`, or by the user aborting the turn — returns its partial result rather than throwing. That matters most in the modes that batch work: a chain aborted at step 3 still reports steps 1 and 2, and a parallel batch still reports the tasks that had already finished, including their cost. Throwing would discard all of it, along with the record of money already spent.

Every timer and listener is scoped to one child process and released when it exits, so a chain that reuses a single abort signal across steps does not accumulate a listener per completed step.

## Agents

Agents are discovered from Markdown files with frontmatter, in two places:

| Source    | Directory                                                     |
| --------- | ------------------------------------------------------------- |
| `user`    | `~/.pi/agent/agents/*.md`                                       |
| `project` | nearest `.pi/agents/*.md` above the current working directory   |

A name defined in both resolves to the project file, so a repo can shadow one of your own personas.

Each agent file's frontmatter supports `name`, `description`, `tools` (comma-separated), `model`, and `promote`. The Markdown body becomes the subagent's system prompt. Files missing `name` or `description` are skipped.

| Field         | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `name`        | The value the caller passes as `agent`. Required.                                            |
| `description` | One line shown in the catalog. Required.                                                      |
| `tools`       | Comma-separated tool allowlist for the child. Omit to leave the child's defaults in place.     |
| `model`       | A `provider/model[:thinkingLevel]` reference, or a bare route key (see below).                 |
| `promote`     | `true` moves the body's `## When to use` section into the *calling* agent's prompt.            |

### Examples

`examples/agents/` holds five personas to copy and edit — `general-purpose`, `oracle`, `planner`, `reviewer`, and `scout`:

```bash
mkdir -p ~/.pi/agent/agents
cp pi/extensions/subagent/examples/agents/scout.md ~/.pi/agent/agents/
```

They are examples, not defaults: nothing loads them where they sit. That keeps every persona a file you own, so deactivating one is deleting it and overriding one is editing it — there is no separate enable/disable layer, and nothing shadows anything you wrote.

### Project agents and trust

Project personas are repo-controlled: both their prompt bodies and their descriptions end up in the model's context. They are therefore included only when pi has marked the project trusted, and each run is confirmed separately in interactive sessions. That confirmation is deliberately not a tool parameter — the calling agent must not be able to waive its own gate.

## The catalog

The set of available personas is part of the tool contract, not the system prompt: descriptions of active tools are sent with every request anyway, and only the parameter schema can turn an invented persona name into a validation failure rather than a runtime error.

Concretely, the `agent` field is a closed enum over the discovered names, and both it and the tool description carry the full `name (source) — description` catalog. Providers that constrain decoding to the tool schema cannot emit a name outside it; where a name does slip through, the error names the closest match (`Unknown agent: "code-reviewer". Did you mean "reviewer"? Available agents: ...`) so the caller can correct itself in one turn.

With no personas configured at all, the `agent` field falls back to a plain string — an empty enum is not valid JSON Schema for several providers. Its description then carries the setup instructions instead of a catalog, naming both `~/.pi/agent/agents` and the examples directory, and telling the caller not to invoke the tool until a persona exists. A fresh install therefore reports that it has nothing to delegate to, rather than leaving the model to invent a name.

The catalog is built at extension load and rebuilt on `session_start`, once the session's real working directory and trust decision are known. `registerTool` is keyed by tool name, so re-registering replaces the definition and refreshes the live tool list; re-registration is skipped when the catalog is unchanged.

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

### Route keys

Wherever a model value is accepted — the `model` parameter, `subagent.model`, or a persona's `model:` frontmatter — it may be a **route key** instead of a `provider/model[:thinkingLevel]` reference. The discriminator is `/`: a model reference always contains one, a route key never does.

Route resolution is not a fifth level in the precedence list above. It is one step applied to whichever value won, so a key works wherever a model string does.

Keys are resolved at dispatch time through an optional, dependency-free contract: a shared `Set` of resolver functions on `globalThis.__piModelRouteResolvers`, published by [`model-modes`](../model-modes/README.md) from its per-mode `defaultRoutes` / `modes[].routes` table. The first non-empty answer wins; a resolver that throws is skipped.

Resolving late is the point. A key like `oracle` can mean a different model in each mode, so the answer is read at the moment the child is spawned rather than baked into a system prompt that may predate the current `/mode`.

With no publisher installed, or with a key nothing resolves, the bare value is passed to the child unchanged and the child errors on an unknown model — exactly the behavior before routes existed.

### Promoted guidance

`promote: true` splits the persona's `## When to use` section (from that heading to the next `##`) out of the child's system prompt and appends it to the **calling** agent's, so that the guidance lives in a file you edit rather than in this extension's source:

```text
## Subagent guidance (subagent extension)

### oracle
Consult the oracle for code review and architecture feedback, ...
```

- A `promote: true` persona with no `## When to use` section promotes nothing and still works normally.
- With no promotable persona, nothing is appended — there is never a heading without a section under it.
- Guidance is recomputed every turn, so it tracks the active mode with no reload.

A persona whose `model` is a bare route key is promoted **only while that key resolves**. When a mode turns the route off, the persona is no longer advertised — otherwise the calling agent would be told to use something whose model cannot be resolved, and the child would die on it. The persona still stays in the `agent` enum and still runs when the caller names it explicitly; dispatch is not gated, because this extension cannot tell a route key from a model name the caller simply typed.

Promotion inherits the project-trust gate: untrusted project personas are not discovered at all, so a repo cannot promote text into your prompt. Note that promoted text is a stronger surface than the catalog line beside it — imperative rather than descriptive — so restricting promotion to user personas is a reasonable future tightening if repo-authored guidance proves noisy.

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

The logic that does not need a running pi is split into pure modules with colocated tests: discovery, name matching, and the promoted-section split in `agents.ts`, the tool contract in `catalog.ts`, model selection and display in `model-display.ts`, route resolution in `routes.ts`, and promoted guidance in `promotion.ts`.

The `globalThis` route key is itself a clean test seam: `routes.test.ts` sets `__piModelRouteResolvers` directly, with no mocking machinery.

`run.test.ts` covers termination — timeout, abort, and the partial result each returns. It injects `spawnChild`, so those paths run against real child processes, real signals, and real timers without needing a pi to be installed or authenticated.

```bash
node --test pi/extensions/subagent/*.test.ts
```
