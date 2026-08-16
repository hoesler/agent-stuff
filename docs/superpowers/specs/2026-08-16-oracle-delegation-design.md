# Oracle: One Delegation Extension, Two Tools

**Date:** 2026-08-16

**Status:** Draft

**Supersedes:** `2026-08-14-oracle-tool-design.md`

**Unchanged:** `2026-08-14-oracle-routing-design.md`. The route table, resolution
order, redundancy suppression, and the `globalThis` publish contract all stand.

## Summary

Keep the oracle as a tool. Delete the second extension.

`subagent` becomes the one extension that owns child-`pi` delegation, and it
registers two tools: `subagent`, which delegates to a persona, and `oracle`,
which escalates to a model. `pi/extensions/shared/` disappears, because with one
owner there is nothing to share.

The oracle also gains a replacing system prompt. The superseded spec sent none,
which does not produce a neutral model — it produces pi's default coding agent.

## Problem

Two faults in the design this spec replaces. Neither touches the invocation
surface, which was right.

### The extensions are no longer self-contained

`oracle/index.ts` imports `../shared/agent-run.ts`, `../shared/agent-display.ts`,
and `../shared/model-display.ts`. So does `subagent/index.ts`. An extension
directory is a shareable artifact: copy it into `~/.pi/agent/extensions/` and it
should run. Both of these now depend on a sibling directory that travels with
neither.

The superseded spec argued that a build-time import is safe because `shared/`
always ships with the package. That is true of this package and false of the
artifact. It answers the wrong question.

The alternative it feared — duplicating the runner — is worse. The duplicated
code is `spawnAgentRun`: process spawn, line-buffered JSON parsing, the
SIGTERM/SIGKILL ladder, and the partial-result contract. Two copies of that drift
silently, and both test suites stay green while they do.

Merging removes the choice. One directory, local imports only, nothing
duplicated, and `routes.ts` goes from two copies to one.

### "No system prompt" inherits a prompt

`dist/core/system-prompt.js:73` opens the base prompt with a fixed sentence:

> You are an expert coding assistant operating inside pi, a coding agent harness.
> You help users by reading files, executing commands, editing code, and writing
> new files.

The oracle child receives that verbatim while holding only `read`, `grep`,
`find`, and `ls`. The tools *list* adapts to `--tools`
(`system-prompt.js:41-43`), but the framing above it does not. The child is told
it edits code and runs commands; it can do neither.

So sending no prompt does not leave the model unprimed. It leaves it primed as
pi's default coding agent — an opinion the superseded spec never examined,
adopted by declining to choose one.

That spec rejected a built-in prompt because "any prompt is an opinion about what
the oracle is for." The claim holds for a *subject-matter* prompt and fails for a
*posture* statement, which the fixed tool list already forces. It also states
that the read-only posture is "enforced by the tool list, not by asking" — while
the prompt in flight asks for the opposite.

The runner uses `--append-system-prompt`, which stacks on that framing.
`--system-prompt` replaces it (`dist/cli/args.js:46`). The superseded design
never had the replacing flag in view.

## Goals

- Every extension directory self-contained: no imports outside itself.
- No duplicated runner, and no invisible "keep these two files identical" coupling.
- The oracle's system prompt states the truth about the run and nothing else.
- Both tools advertised only while they can do anything.
- Preserve every invocation-surface decision the superseded spec got right.

## Non-goals

- **No routing change.** This spec adds and moves consumers.
- **No output shape, and no specialty.** The posture prompt says what the run
  *is*, never what the question should be about.
- **No `context`, `files`, or conversation passing.** Unchanged.
- **No fallback to the main model.** Unchanged.
- **No removal of persona promotion or route-gated promotion.**
- **No extension rename.** `subagent` stays the directory name. It is the
  headline tool, and renaming breaks configured paths for a tidiness gain.

## Design

### Layout

```
pi/extensions/subagent/
  index.ts            registration and event wiring only
  subagent-tool.ts    the subagent tool definition      (from index.ts)
  oracle-tool.ts      the oracle tool definition        (from oracle/index.ts)
  run.ts              spawn, parse, terminate           (from shared/agent-run.ts)
  display.ts          tool-call and usage rendering     (from shared/agent-display.ts)
  model-display.ts    resolved-model display            (from shared/model-display.ts)
  routes.ts           route reader — one copy, not two
  availability.ts     active-list gating for both tools
  agents.ts           persona discovery                 (unchanged)
  catalog.ts          tool schema                       (unchanged)
  promotion.ts        promoted guidance                 (unchanged)
  examples/agents/*.md
```

`pi/extensions/oracle/` and `pi/extensions/shared/` are deleted.

An extension is a directory with `index.ts` plus helper modules
(`docs/extensions.md:235-243`), and one extension may register several tools
(`docs/extensions.md:2111-2127`). Both are ordinary pi shapes.

`index.ts` drops from 906 lines to registration and event wiring. Splitting the
two tool definitions out is the structural gain that pays for the merge on its
own.

The only edge leaving this directory is the optional `globalThis` route contract,
which is dependency-free by construction and already documented in
`model-modes/routes-hook.ts`.

### The oracle tool

```
name        oracle
label       Oracle
parameters  { question: string, timeoutSeconds?: number }
dispatch    pi --mode json -p --no-session --no-skills
               --model <resolveRoute("oracle")>
               --tools read,grep,find,ls
               --system-prompt <posture>
               <question>
```

Four changes from the superseded design; everything else is carried forward.

**1. `--system-prompt`, replacing.** The posture prompt, in full:

> You are being consulted for a second opinion by another coding agent. You have
> no history of its conversation; everything you need is in the question. You can
> read files but cannot edit, write, or run commands. Answer the question
> directly.

Every sentence states a fact about the run. Nothing names a subject, a task type,
or an output shape. The test for anything added here later: could it be false for
some question the oracle is asked? If so, it does not belong.

This needs a new `AgentRunOptions` field. `systemPrompt` keeps appending, for
personas; `replaceSystemPrompt` maps to `--system-prompt`. Supplying both is a
programming error, so the runner rejects it rather than picking one.

**2. `--no-skills`.** A one-shot consultation has no use for the skills catalog,
and the descriptions are repo-authored text reaching the child for nothing
(`docs/skills.md:41`).

**3. `cwd` dropped.** It was the only model-supplied input that changed the
child's *prompt*, by selecting which `AGENTS.md` got appended
(`system-prompt.js:19-26`). It costs no reach to remove: `read` resolves relative
paths against `cwd` but applies no containment check, so an absolute path outside
it reads normally (`path-utils.js:72-85`). A question naming an absolute path
still works. Re-adding a parameter later is cheap; removing one is not.

**4. It lives in `subagent/`.** Local imports throughout.

Carried forward unchanged: the description stating the invocation policy, the
`promptSnippet` rather than `promptGuidelines`, the `question` parameter
description, the fixed read-only tool list, `timeoutSeconds` with no default, and
the absence of a `context` or `files` parameter.

### Availability

One pure function gates both tools:

```ts
nextActiveTools(name: string, available: boolean, current: string[]): string[] | undefined
```

It derives its answer from the live list, adds or removes only `name`, and
returns `undefined` when nothing changes. `setActiveTools` replaces the whole
list, so building one from anywhere else would clobber another extension's
toggling.

| Tool | Available while |
| --- | --- |
| `oracle` | `resolveRoute("oracle")` resolves |
| `subagent` | at least one persona was discovered |

The `subagent` row is new, and it fixes a wart. Today a fresh install advertises
`subagent` with a description telling the caller not to invoke it until a persona
exists. Removing it from the active list says the same thing without spending
context on it, and it answers the "oracle without subagent" case structurally:
write no persona files and only the oracle is advertised.

Synced on `session_start`, `model_select`, `thinking_level_select`, and
`turn_start`. `turn_start` is the cheap catch-all covering `/mode` switches and
config reloads, which preserves the pull-not-push property that makes the route
contract order-independent.

There is no `unregisterTool`; active-list membership is the mechanism.

### What actually reaches the oracle child

The superseded README claims the oracle has "no repo-authored text" reaching the
model. That is too strong, and this spec records the real accounting:

| Source | Reaches the child | Note |
| --- | --- | --- |
| Posture prompt | Yes | Extension source, four sentences |
| The question | Yes | Verbatim, from the calling agent |
| `AGENTS.md` / `CLAUDE.md` | **Yes** | Appended for any prompt mode (`system-prompt.js:19-26`) |
| Skills catalog | No | Suppressed by `--no-skills` |
| pi's coding-assistant framing | No | Replaced by `--system-prompt` |
| Conversation history | No | Separate context is the point |
| Persona bodies | No | The oracle has none |

Context files still reach it, exactly as they reach any subagent run. That is not
a regression this design introduces, and no gate here would remove it. It is
written down so the next reader is not misled by the stronger claim.

### Degradation

| Missing | Result |
| --- | --- |
| `model-modes` not installed | Nothing publishes, the route never resolves, `oracle` is never active |
| Route absent or `false` for the active mode | `oracle` inactive for that mode, active again on switching back, no reload |
| Route suppressed as redundant | Same as absent — a second opinion from the running model is not one |
| No personas configured | `subagent` inactive; `oracle` unaffected |
| Neither personas nor route | Both inactive; the extension advertises nothing |

Every direction produces silence rather than a dangling instruction.

### Errors

| Case | Behavior |
| --- | --- |
| Route unresolved at call time | `isError` naming the fix: set `defaultRoutes.oracle` or `modes[].routes.oracle` |
| Child fails — unknown model, auth failure | Returns with stderr and exit code |
| Timeout or abort | Partial result, unchanged from the runner |

The route is read at call time, not at registration, so a `/mode` switch between
the last sync and the call is seen.

No project-trust gate on the oracle. `subagent` needs one because persona bodies
and descriptions are repo-controlled; the oracle has no persona file.

## Testing Strategy

Colocated `node:test` files. No running pi, no provider credentials.

- **`run.test.ts`** — the moved `shared/agent-run.test.ts`, plus one case: a
  replacing prompt produces `--system-prompt` and an appending one produces
  `--append-system-prompt`; supplying both throws.
- **`model-display.test.ts`** — moved unchanged.
- **`availability.test.ts`** — `nextActiveTools` for both names: adds when absent
  and available, removes when present and unavailable, returns `undefined` when
  already correct, and preserves every other name in all four cases.
- **`oracle-tool.test.ts`** — the moved `oracle/index.test.ts`, plus assertions
  on the new dispatch: `--no-skills` is passed, the posture prompt is sent as
  replacing, and no `cwd` parameter is accepted.
- **`routes.test.ts`** — the `globalThis` seam, one copy.
- **Every existing `subagent` test passes unchanged.** That is the merge's
  correctness criterion.

`package.json`'s `test` script drops the `shared` and `oracle` entries.

## Acceptance Criteria

- No file under `pi/extensions/` imports from a sibling extension directory.
- `pi/extensions/shared/` and `pi/extensions/oracle/` no longer exist.
- With `routes.oracle` configured, `oracle({question})` spawns a child on the
  route's model, with the four read-only tools, `--no-skills`, and the posture
  prompt as `--system-prompt`; the result shows the resolved model, not the key.
- The oracle tool schema has no `cwd` parameter.
- In a mode with `"routes": {"oracle": false}`, `oracle` is not in
  `getActiveTools()`; `/mode` back restores it by the next turn without a reload.
- When the resolved target equals the live provider/model/thinkingLevel triple,
  `oracle` is not active.
- With no personas discovered, `subagent` is not in `getActiveTools()`.
- `oracle` does not appear in the `subagent` tool's `agent` enum.
- `reviewer`'s promoted guidance appears in the calling agent's system prompt.
- `subagent`'s chain, parallel, timeout, abort, and project-trust behaviors are
  unchanged.
- `subagent/index.ts` is registration and event wiring only.
- `npm run typecheck` and `npm test` pass.

## Migration

The work is parked at `.worktrees/feat-oracle-tool` (13 commits, 334 tests
green). Most of it survives; rebase rather than restart.

| Parked work | Fate |
| --- | --- |
| `shared/agent-run.ts` and its tests | Move into `subagent/run.ts`, add the replacing-prompt option |
| `shared/model-display.ts`, `shared/agent-display.ts` | Move into `subagent/` |
| `oracle/index.ts` | Becomes `subagent/oracle-tool.ts`; drop `cwd`, add prompt and `--no-skills` |
| `oracle/availability.ts` | Becomes `subagent/availability.ts`, parameterized by tool name |
| `oracle/routes.ts` | Deleted; `subagent/routes.ts` is the one copy |
| Deleting `examples/agents/oracle.md` | Keep |
| `reviewer.md` gaining `promote: true` | Keep |
| Both READMEs | Rewrite as one |

## Alternatives Rejected

### The oracle as a skill

The strongest-sounding option, and it loses on mechanism. Skills encode a
*procedure*; the oracle has none. A skill saying "call `subagent` with agent
`oracle`" adds a discovery hop in front of an invocation, and it is the weaker
surface of the two: active tool descriptions ship with every request, while a
skill body loads only when the model decides to read it
(`docs/skills.md:64-71`). It also cannot be gated on the route resolving.

The pure version — `SKILL.md` telling the agent to run
`pi --model X --tools read,... -p '<question>'` over `bash` — is the most
self-contained artifact available and gives up route resolution, streaming, TUI
rendering, timeout handling, and abort integration, while requiring `bash`. Too
much quality for the packaging win.

### The oracle back to a persona

Zero code, and the option I would take if the oracle had a system prompt. It
does not, and a persona file *is* a system prompt — an `oracle.md` with a
deliberately blank body is a file fighting its own format. Personas also live in
`examples/agents/`, which nothing loads where it sits, so the capability would
exist only after a manual copy.

The enum-ambiguity argument from the superseded spec is weaker than it was
presented there: the session that misfired did so because both files advertised
"code review" and only the oracle carried `promote: true`, which a rewrite fixes.
This rejection does not rest on it.

### Two extensions, each with its own runner

Satisfies self-containment and preserves independent installation. Rejected
because it duplicates the JSON parsing and the termination ladder, where a
divergence is least visible, to buy an independence the availability rule above
now provides without any code.

### A published `@hoesler/pi-agent-run` package

The textbook answer for shared library code, and real infrastructure — a
publish step, a version, a second release cadence — for exactly one consumer
outside this repo. Rejected as heavier than the problem.

### Keep `pi/extensions/shared/`

The status quo on the parked branch. Rejected: it makes two extensions
un-copyable to buy nothing that merging does not also buy.

### Rename the extension to `delegation`

Describes the merged concept more precisely. Rejected: `subagent` is the
headline tool, and the rename breaks configured resource paths and every README
link for a tidiness gain.
