# Subagent

Delegation to a child `pi` process, as two tools.

| Tool | What it is |
| --- | --- |
| `subagent` | Delegate a task to a **persona** — a Markdown file you own — running in a separate `pi` process with its own context window. Single, parallel, and chained modes. |
| `oracle` | Escalate a hard question to a **model** — a deliberately different one, in a fresh context, with read-only tools and no memory of your conversation. |

One extension owns both because they share a child-process runner, and an extension directory has to be copyable on its own: everything under `pi/extensions/subagent/` imports only from itself. The single edge leaving the directory is the optional `globalThis` route contract in `routes.ts`, which is dependency-free by construction.

Everything from here to [Oracle](#oracle) is about `subagent`.

## Modes

- **Single** — `{ agent: "name", task: "..." }`
- **Parallel** — `{ tasks: [{ agent: "name", task: "..." }, ...] }` (up to 8 concurrent tasks, 4 at a time)
- **Chain** — `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }`, where `{previous}` is replaced with the prior step's final output

Exactly one mode must be provided per call.

## Deadlines

Two deadlines bound a run, and the one that ordinarily stops it is not the clock.

**The idle deadline** is the real guard: `IDLE_SECONDS` (600) of *complete silence* from the child. It is not configurable from either tool's schema, on purpose. A wall-clock budget asks the caller to predict how long the work will take, which it cannot do — it has never run this task on this repo — so a low guess kills a subagent that was working, which is the failure this replaced. Silence is a fact about the run rather than a prediction about it, and it is what a deadlocked child actually produces: a child blocked on a lock emits nothing and costs nothing, while the runaway loop a clock would catch is the one still streaming.

Liveness is measured on **every event the child emits**, not the two the result records. `--mode json` writes each session event to stdout, so a high-effort turn streams `message_update` thinking deltas for minutes on end; a clock that only watched `message_end` would kill the child precisely on the hard task it was delegated for. `run.test.ts` pins this with a child that streams nothing but thinking deltas.

The default is sized against the longest legitimate silence, which turns out to be a tool call rather than anything the provider does. pi's bash tool emits a `tool_execution_update` only when the command writes output (throttled to 10/s), so the boundary is not slow-versus-deadlocked but **noisy versus silent**: a command that streams anything — a test runner, a build, an installer — keeps the child alive for hours, while one that prints nothing until it finishes is indistinguishable from a deadlock from out here. `tsc` is the everyday example, and `npm run typecheck` in this repo is exactly that shape. Nothing available at this seam can tell the two apart; only the command itself knows.

So the number is chosen on an asymmetry rather than a measurement. Waiting out a deadlock costs only wall clock — a hung child issues no requests and burns no tokens — while killing a working command throws away the run. Erring high is nearly free. Provider-side silence sits well inside it, and a retry announces itself with `auto_retry_start`, so backoff is not silence at all.

A refinement left undone: `tool_execution_start` and `tool_execution_end` bracket the silence that happens *inside* a tool call, so the two kinds of quiet could carry different thresholds — a stalled agent loop has no business being quiet for ten minutes. That needs state this does not keep, and one constant was the agreed starting point.

**`timeoutSeconds` is a hard ceiling**, and optional. It is set per task or per step, with a whole-call value as the fallback — the same precedence as `model`. Most calls should omit it. It exists for the one case the idle deadline cannot reach: a child that streams steadily but never finishes, which unattended would run until the session ended. A parallel batch is where that bites, since one such task holds a concurrency slot and blocks the whole call.

On either deadline the child gets `SIGTERM`, then `SIGKILL` five seconds later if it is still alive. The run is *not* discarded: it comes back with `stopReason: "timeout"` — both deadlines report as one reason, since every rendering surface already reads it and what distinguishes them is the message — and everything the subagent produced before it was killed.

### What a killed run says it was doing

The error message names the tool calls the child had issued but never finished:

```
Terminated after no output for 180s. In flight: bash(npm test).
```

Without that line the caller reads `getFinalOutput`, which returns *text* parts — so it gets the prose that preceded the hang ("now let me run the test suite") and nothing about the `bash` call that swallowed the budget. The call is on the last assistant message the whole time; it is a `toolCall` part, and it never produced a `toolResult`. `inFlightToolCalls` pairs calls against results and reports the survivors, which is what lets the caller tell a deadlock from a task that merely needed longer — the difference between fixing the test and retrying it with a bigger number.

## Termination and partial results

A run killed from outside — by either deadline, or by the user aborting the turn — returns its partial result rather than throwing. That matters most in the modes that batch work: a chain aborted at step 3 still reports steps 1 and 2, and a parallel batch still reports the tasks that had already finished, including their cost. Throwing would discard all of it, along with the record of money already spent.

Every timer and listener is scoped to one child process and released when it exits, so a chain that reuses a single abort signal across steps does not accumulate a listener per completed step.

### How a failure is reported

A failed run carries its reason in one of two fields, and which one depends on
how far it got: a child that started and died reports through `errorMessage`,
while a run that failed *before* any child existed — an unknown persona, a
`model` that cannot be one — has only `stderr`. Both the tool result and every
TUI surface read `displayedFailureReason`, which consults both, so the reason
the calling agent is given and the reason you see are the same string.

They were not always. The renderers used to read `errorMessage` alone, so a
pre-dispatch failure has no reason *and* no messages and came out as a bare
`(no output)` under a red ✗, while the model was handed the full explanation.
Silence in the one surface a human is watching is the expensive kind, and one
shared function is what stops the two drifting again. `(no output)` now means
what it says: the run produced nothing and had nothing to say about why.

Chain steps and parallel tasks report the same way, per step and per task —
that is where it matters most, since a single bad `model` fails only its own
task and the batch otherwise looks merely incomplete. A task still running is
never labelled, its non-zero sentinel exit code notwithstanding.

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

`examples/agents/` holds four personas to copy and edit — `general-purpose`, `planner`, `reviewer`, and `scout`:

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

Keys are resolved at dispatch time through an optional, dependency-free contract: a shared `Set` of resolver functions on `globalThis.__piModelRouteResolvers`, published by [`agent-modes`](../agent-modes/README.md) from its per-mode `defaultRoutes` / `modes[].routes` table. The first non-empty answer wins; a resolver that throws is skipped.

Resolving late is the point. A key can mean a different model in each mode — `agent-modes` lets a mode override one, and a `distinct` route like `oracle` drops out entirely while it points at the model already running — so the answer is read at the moment the child is spawned rather than baked into a system prompt that may predate the current `/mode`.

A key that no mode touches is a plain alias: the same model everywhere, whatever `/mode` you are in. That is what makes a persona's `model:` frontmatter dependable — write `model: reviewer` in the file and move the target by editing the route table, without the name going quiet because you switched onto the model behind it.

With no publisher installed, or with a key nothing resolves, the bare value is passed to the child unchanged and the child errors on an unknown model — exactly the behavior before routes existed. The one exception is below.

A **mode id is not a route key**. `agent-modes` publishes only what its `defaultRoutes` and `modes[].routes` tables name; the ids you cycle with `/mode` are not in that set and resolve to nothing. The two are deliberately separate — a route is a name the route table owns, pointing wherever that table says, while a mode id names a target you cycle onto — so accepting ids here would blur the one distinction that tells a caller what it is passing. To dispatch to a mode's model, pass that mode's `provider/model:thinkingLevel` string, which the catalog block gives you ready to use; to have a name that outlives the target behind it, define an actual route key.

### Thinking levels are not models

A caller reading `model` as "how hard should this think" writes the thinking level on its own — `model: "medium"`. That value can never be a model: a reference is `provider/model` with the level as an optional `:thinkingLevel` suffix. Left to pass through, it would buy a child process before pi rejected it.

So a value that is exactly a thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) fails the task before anything is spawned, with the correct string to use instead:

```text
Invalid model "medium": that is a thinking level, not a model. Append it to a model
reference instead — e.g. "github-copilot/claude-sonnet-5:medium". Or omit `model` to
use the agent's own model.
```

When the persona's frontmatter names a real model reference, that reference is what the message suggests — the caller wanted this agent thinking harder, and the suggested value is the exact string that says so. A level arriving *from* the frontmatter names the persona file as the thing to fix, since omitting the parameter would not help.

The check runs after route resolution, so a route legitimately keyed `high` resolves to a full reference first and is never flagged. It is also the only bare word refused: pi's `--model` takes a *pattern*, so any other one may legitimately match a model id.

It fails the task, not the call — in a parallel batch a single bad `model` costs only its own task, and its siblings still run.

### Promoted guidance

`promote: true` splits the persona's `## When to use` section (from that heading to the next `##`) out of the child's system prompt and appends it to the **calling** agent's, so that the guidance lives in a file you edit rather than in this extension's source:

```text
## Subagent guidance (subagent extension)

### reviewer
Hand the reviewer the full final review of a change before it ships ...
```

- A `promote: true` persona with no `## When to use` section promotes nothing and still works normally.
- With no promotable persona, nothing is appended — there is never a heading without a section under it.
- Guidance is recomputed every turn, so it tracks the active mode with no reload.

A persona whose `model` is a bare route key is promoted **only while that key resolves**. When a mode turns the route off, the persona is no longer advertised — otherwise the calling agent would be told to use something whose model cannot be resolved, and the child would die on it. The persona still stays in the `agent` enum and still runs when the caller names it explicitly; dispatch is not gated, because this extension cannot tell a route key from a model name the caller simply typed. That inability cuts both ways: a persona meant to be promoted unconditionally needs a `model` containing a `/`, since a bare one is read as a route key and stays unadvertised until something resolves it. The shipped `reviewer` uses `anthropic/claude-sonnet-4-5` for exactly that reason.

No shipped example exercises route-gated promotion any more: the `oracle` persona that used to demonstrate it became [a tool of its own](#oracle), since a second opinion is a model tier rather than a workflow, and putting both in one `agent` enum manufactured a choice between them. The rule stays correct for any persona that uses it.

Promotion inherits the project-trust gate: untrusted project personas are not discovered at all, so a repo cannot promote text into your prompt. Note that promoted text is a stronger surface than the catalog line beside it — imperative rather than descriptive — so restricting promotion to user personas is a reasonable future tightening if repo-authored guidance proves noisy.

## Oracle

The oracle is defined by *who answers*, not by what it is asked. It carries no specialty and no output shape — only:

- **a route**, `oracle`, resolved from [`agent-modes`](../agent-modes/README.md);
- **a capability contract**: read-only (`read`, `grep`, `find`, `ls`), its own context window, deeper reasoning, higher cost and latency;
- **an invocation policy**: advertised, never forced.

| Parameter | Meaning |
| --- | --- |
| `question` | The question, passed to the child verbatim. The oracle sees nothing of your conversation, so state the problem in full and name the files it should read. |
| `timeoutSeconds` | Optional hard ceiling on wall clock. Usually omitted — the idle deadline stops a run that has gone silent. On expiry the child is terminated and its partial output is returned. |

There is deliberately no `context` or `files` parameter: the oracle has read tools and the question can name paths, and a `context` parameter in particular invites dumping conversation history — the cost the separate context window exists to avoid. There is no `cwd` either: it was the only model-supplied input that changed the child's *prompt*, by selecting which `AGENTS.md` was appended, and dropping it costs no reach, since `read` applies no containment check and a question naming an absolute path still works. The tool list is fixed rather than configurable: read-only is part of what the oracle *is*.

### The posture prompt

The oracle replaces pi's base system prompt rather than appending to it:

> You are being consulted for a second opinion by another coding agent. You have no history of its conversation; everything you need is in the question. You can read files but cannot edit, write, or run commands. Answer the question directly.

Sending *no* prompt would not leave the model unprimed — it would leave it primed as pi's default coding agent, whose opening sentence tells the child it edits code and runs commands while it holds four read-only tools. Every sentence above states a fact about the run. Nothing names a subject, a task type, or an output shape; the test for anything added later is whether it could be false for some question the oracle is asked.

`--no-skills` goes with it: a one-shot consultation has no use for the skills catalog, whose descriptions are repo-authored text that would reach the child for nothing.

### What actually reaches the oracle child

| Source | Reaches the child | Note |
| --- | --- | --- |
| Posture prompt | Yes | Extension source, four sentences |
| The question | Yes | Verbatim, from the calling agent |
| `AGENTS.md` / `CLAUDE.md` | **Yes** | Appended for any prompt mode, exactly as for a subagent run |
| Skills catalog | No | Suppressed by `--no-skills` |
| pi's coding-assistant framing | No | Replaced by `--system-prompt` |
| Conversation history | No | Separate context is the point |
| Persona bodies | No | The oracle has none |

There is no project-trust gate on the oracle: `subagent` needs one because repo-controlled *persona* bodies and descriptions reach the model, and the oracle has no persona file. Context files still reach it, as they reach any child `pi` — not a gate the oracle removed, just not one it needs.

### Configuration

None of its own. Point the `oracle` route at a model in `agent-modes.json`:

```json
{
  "version": 1,
  "defaultMode": "medium",
  "defaultRoutes": {
    "oracle": { "provider": "anthropic", "model": "claude-fable-5", "thinkingLevel": "high" }
  },
  "modes": [
    { "id": "medium", "provider": "openai", "model": "gpt-5.6-sol", "thinkingLevel": "medium" },
    { "id": "fable", "provider": "anthropic", "model": "claude-fable-5", "thinkingLevel": "high",
      "routes": { "oracle": false } }
  ]
}
```

`/mode doctor` reports whether the key resolves for the mode you are in, and
when it does not, which of the reasons in the table below applies:

```text
Routes (active mode: fable):
- oracle -> unavailable (this mode opts out)
```

That is the direct answer to "is the oracle live right now?", and it is read
from the same resolution the tool dispatches through — so a tool missing from
the list and a route missing from the report always agree.

## Availability

Each tool is advertised only while it can do anything:

| Tool | Active while |
| --- | --- |
| `oracle` | the `oracle` route resolves |
| `subagent` | at least one persona was discovered |

A sync pass on `session_start`, `model_select`, `thinking_level_select`, and `turn_start` adds or removes each name from the active tool list. `turn_start` is the cheap catch-all: it covers `/mode` switches and config reloads without this extension needing to know which events `agent-modes` recomputes on. There is no `unregisterTool`; active-list membership is the mechanism.

The `subagent` row is what a fresh install notices: with no personas configured, the tool is simply not advertised, rather than advertised with a description telling the caller not to invoke it. It also answers the "oracle without subagent" case structurally — write no persona files and only the oracle is advertised.

| Missing | Result |
| --- | --- |
| `agent-modes` not installed | Nothing publishes, the route never resolves, `oracle` is never active |
| Route absent or `false` for the active mode | `oracle` inactive for that mode, active again on switching back, no reload |
| Route suppressed as redundant | Same as absent — a second opinion from the model already running is not one |
| No personas configured | `subagent` inactive; `oracle` unaffected |
| Neither personas nor route | Both inactive; the extension advertises nothing |

Every direction produces silence rather than a dangling instruction. The route is read again at call time, so a `/mode` switch between the last sync and the call is seen: the oracle then returns an error naming the fix rather than dispatching to nothing.

Silence is the correct behavior and an awkward thing to debug, which is what the routes section of `/mode doctor` is for: the tool list shows only that the oracle is absent, while the report separates "this mode opts out" from "suppressed as redundant" from "configured, but only for another mode". The first row is the one case the report cannot explain — with no `agent-modes` installed there is no `/mode` command to run.

## Resolved model display

The displayed model is the one the child process actually used, not the raw value that was requested — so aliases or mode-like values (e.g. `ultra` from an agent-modes catalog) never appear as though they were the real model name.

The resolved model is read from the child's assistant message: `provider/responseModel` when the provider reports a response model, otherwise `provider/model`. Only once that message arrives does the display switch from the requested value to the resolved one.

If the child process never produces an assistant message (e.g. it crashes or is aborted immediately), the display falls back to the originally requested model (if one was given), or an `(unresolved)` marker when no explicit model was supplied.

A thinking level requested as a `:<level>` suffix (as produced by the agent-modes catalog) is re-attached to the resolved model. Assistant messages carry only provider and model — never the thinking level — so the level cannot be read back from the child and would otherwise vanish the moment the model resolved. Only the segment after the *last* colon counts, and only when it names a valid level, so model ids that legitimately contain colons (`openai/gpt-4o:extended`, `llama3.1:8b`) are left intact.

Example usage line:

```text
7 turns ↑14 ↓1.4k R92k W16k $0.0736 ctx:18k github-copilot/claude-sonnet-5:high [agent]
```

For chain and parallel modes, each expanded step/task line shows its own resolved model and source; aggregate "Total" lines remain model-neutral since they combine potentially different models across steps/tasks.

## Testing

The logic that does not need a running pi is split into pure modules with colocated tests: discovery, name matching, and the promoted-section split in `agents.ts`, the tool contract in `catalog.ts`, model selection and display in `model-display.ts`, route resolution in `routes.ts`, promoted guidance in `promotion.ts`, and the active-list rule in `availability.ts`.

The `globalThis` route key is itself a clean test seam: `routes.test.ts` sets `__piModelRouteResolvers` directly, with no mocking machinery.

`run.test.ts` covers the one child-process seam both tools reach the child through — both deadlines, abort, the in-flight diagnostics, the partial result each returns, the dispatch arguments, and which of `--system-prompt` / `--append-system-prompt` a run gets. Every test that expects a child to be killed carries its own `timeout`, so a deadline that fails to fire fails the suite instead of hanging it. It injects `spawnChild`, so those paths run against real child processes, real signals, and real timers without needing a pi to be installed or authenticated. It also covers `displayedFailureReason`, which exists as a named function mainly so the rule every rendered surface follows can be asserted: the renderers build pi TUI widgets and are not otherwise reachable from a test.

`subagent-tool.test.ts` and `oracle-tool.test.ts` cover the composition each tool adds on top: persona lookup and the `Task:` framing for one, and for the other the load-bearing invariants that make the oracle what it is — the fixed read-only tool list, the posture prompt sent as replacing, `--no-skills`, the question passed through verbatim, no `cwd` parameter, and a missing route failing without attempting a run. The oracle's test injects `runAgent` at the same seam where the subagent's injects `spawnChild`.

```bash
node --test pi/extensions/subagent/*.test.ts
```
