# Oracle: Mode-Dependent Model Routing for Subagent Personas

**Date:** 2026-08-14

**Status:** Draft

## Summary

Give the main agent an Amp-style "oracle" — a second-opinion model it consults
for hard debugging, review, and planning — without building an oracle feature
into any extension.

Two general capabilities do the work. `model-modes` gains a per-mode **routing
table**: named keys that resolve to a `provider/model:thinkingLevel` string for
whichever mode is active. `subagent` gains **route resolution** on the model
value it already accepts, and **persona promotion**, which lifts a persona's
"when to use" text into the calling agent's system prompt.

The oracle is then a configuration of those two capabilities: a `routes.oracle`
entry in `model-modes.json` and an `oracle.md` persona file. Neither extension
learns what an oracle is.

This is an addendum to the model-modes catalog design
(`2026-07-17-model-modes-subagent-catalog-design.md`) and to the subagent
resolved-model display design (`2026-07-23-subagent-resolved-model-display-design.md`).

## Problem

Amp exposes an `oracle` tool: a read-only advisor on a deliberately different
model, which the main agent consults when it is stuck. Its extracted tool spec
takes `task`, optional `context`, and optional `files`, and grants the advisor
only `list_directory, Read, Grep, glob, web_search, read_web_page` — no bash, no
edits, no nested delegation. Its routing is mode-dependent: in Amp's high mode
the advisor is a different model family from the main agent, or the same model
at a different reasoning level, depending on which subscription is connected.

The interesting property is that the advisor is not reliably *stronger*. It is a
different vantage point, chosen per mode. That is a routing table the user
authors, not a capability ranking to derive.

This project already owns the expensive part. `subagent/index.ts:346` spawns a
child Pi with `--mode json -p --no-session --model … --tools … --append-system-prompt …`,
which is the same invocation the published pi `oracle` extension builds across
1,685 lines. What is missing is not a runner. It is:

1. **Routing** — no way to say "when I am in `high`, my second opinion is this
   other model", and in particular no answer at all in `mode:custom`, which is
   every session started with `--model`, `--models`, `--provider`, or
   `--thinking`.
2. **Nudging** — nothing tells the main agent that a second opinion exists or
   when to reach for it. A persona's one-line `description` inside the `agent`
   enum is the only surface, and it describes the persona rather than the
   escalation.

## Goals

- Let the user author a per-mode routing table in `model-modes.json`, with a
  default that also covers `mode:custom`.
- Resolve a route at **dispatch time**, so a mid-session `/mode` change takes
  effect without invalidating anything.
- Let a persona carry its own "when to use" guidance into the calling agent's
  system prompt, so that text lives in a file the user edits rather than in
  extension source.
- Keep both extensions free of the word "oracle".
- Keep both extensions independently installable: every missing piece produces
  silence, never a dangling instruction.
- Add no new tool parameter and no second model-selection vocabulary.

## Non-goals

- **No dedicated `oracle` tool.** Invocation stays `subagent(agent: "oracle", …)`.
  A tool literally named `oracle` is the strongest nudge available — models reach
  for tools whose name matches their intent — but it requires extracting the
  runner from subagent's ~1,200-line `index.ts`, or duplicating it. Deferred
  until usage shows the persona route is insufficient.
- **No runner extraction and no changes to subprocess code.** All work lands in
  `config.ts` and `agents.ts`, which is where the pure-function tests already live.
- **No `context` or `files` parameters.** The advisor has read tools and the task
  string can name paths. Amp attaches files because its oracle is a separate
  service; here it is a child process in the same working directory.
- **No model ranking or auto-derivation.** The published pi `oracle` extension
  ranks provider models by heuristic ("favor opus/pro, penalize mini/flash/haiku").
  That contradicts this extension's stated stance: every mode is user-defined,
  the extension never supplies fallbacks and never writes the configuration file.
  Routes follow the same rule.
- **No conversation passing.** `rpiv-advisor` serializes the live conversation
  branch to the reviewer. That is a different design from Amp's and a much larger
  change; the task-string shape is what this spec implements.
- **No shipped `oracle.md`.** It goes in `pi/extensions/subagent/examples/agents/`
  alongside the existing four, to be copied and edited. Nothing loads it in place.

## Design

### Two channels, and only one is the extension interface

This distinction governs everything below.

**Channel 1 — a `globalThis` contract, extension to extension.** `model-modes`
registers a resolver function. `subagent` calls it in code at dispatch time to
turn `oracle` into `anthropic/claude-fable-5:high` before building the `--model`
argument. The model never sees this.

**Channel 2 — the system prompt, extension to the LLM.** The mode catalog names
`oracle` as a value the caller may pass. It carries the **key only, never the
resolved model string**.

The value must not travel through the prompt. The system prompt is built once at
`before_agent_start`, but the active mode can change mid-session. A prompt
carrying a literal model string would hand the agent a stale route from an
earlier mode. Carrying the key means the agent asks for a name and gets whatever
that name means at the instant of dispatch.

### model-modes: routing table

Two optional schema additions:

```json
{
  "version": 1,
  "defaultMode": "medium",
  "exposeCatalogInSystemPrompt": true,
  "defaultRoutes": {
    "oracle": { "provider": "anthropic", "model": "claude-fable-5", "thinkingLevel": "high" }
  },
  "modes": [
    { "id": "low", "provider": "zai", "model": "glm-5.2", "thinkingLevel": "low",
      "routes": { "oracle": false } },
    { "id": "medium", "provider": "openai", "model": "gpt-5.6-sol", "thinkingLevel": "medium" },
    { "id": "high", "provider": "openai", "model": "gpt-5.6-sol", "thinkingLevel": "high",
      "routes": { "oracle": { "provider": "anthropic", "model": "claude-fable-5", "thinkingLevel": "high" } } }
  ]
}
```

- `defaultRoutes`: optional map of route key to target. Absent means no defaults.
- `modes[].routes`: optional map of route key to target, or `false` to opt the
  mode out of a default.
- A target reuses the mode target shape: `provider`, `model`, optional
  `thinkingLevel` (defaulting to `off`, and rendered without a `:off` suffix,
  matching `modelString`), and optional `description` used only by the catalog
  rendering below.
- Route keys must be non-empty and must not contain `/`. The `/` restriction is
  what makes Channel 1's discriminator work, so it is validated rather than
  assumed.
- `ROOT_KEYS` gains `defaultRoutes`; the per-mode key set gains `routes`.
- Both fields absent means today's behavior exactly: nothing published, nothing
  rendered.

**Resolution for a key `k`, against the active mode:**

1. Active mode has `routes[k] === false` → no route.
2. Active mode has `routes[k]` as a target → that target.
3. `defaultRoutes[k]` exists → that target.
4. Otherwise → no route.

`mode:custom` and `mode:error` have no mode entry, so they fall to step 3. This
is the point of `defaultRoutes`: a session pinned with `--model` still has a
second opinion.

**Redundancy suppression.** If the resolved target equals the live
provider/model/thinkingLevel triple exactly, resolve to no route. A second
opinion from the model you are already running is not a second opinion. This
mirrors `rpiv-advisor`'s executor blocklist, obtained here as a triple comparison
rather than a separate configuration surface.

**Where routes are recomputed.** `updateStatus` (`model-modes/index.ts:85`)
already runs on every path that can change the active mode — `activate`, session
start, `model_select`, `thinking_level_select`, and config reload — and already
holds both the `ConfigSnapshot` and the effective live selection. It gains one
step: recompute a module-level `currentRoutes: Record<string, string>` from
`active` and `effective`. No new event handler, no new file watching.

### model-modes: the publish contract

A new `routes-hook.ts`, structurally identical to `status-hook.ts` including its
doc comment spelling out the contract for third parties on both sides:

```ts
export type ModelRouteResolver = (key: string) => string | undefined;

function resolvers(): Set<ModelRouteResolver> {
  const g = globalThis as typeof globalThis & { __piModelRouteResolvers?: Set<ModelRouteResolver> };
  if (!g.__piModelRouteResolvers) g.__piModelRouteResolvers = new Set();
  return g.__piModelRouteResolvers;
}

/** Register a resolver. Returns an unregister function. */
export function registerModelRouteResolver(fn: ModelRouteResolver): () => void {
  const set = resolvers();
  set.add(fn);
  return () => set.delete(fn);
}
```

`model-modes` registers one resolver at load: `(key) => currentRoutes[key]`.

A `Set` rather than a single slot, matching the status hook, so a second
publisher can coexist; the first non-empty answer wins.

**Pull, not push.** Consumers call at dispatch time. Load order therefore does
not matter, no re-broadcast on registration is needed, and a mid-session mode
change is picked up with nothing to invalidate.

### subagent: route resolution

`subagent` needs only the read half, inlined — no import, no shared package, no
build dependency:

```ts
type ModelRouteResolver = (key: string) => string | undefined;

function resolveRoute(key: string): string | undefined {
  const g = globalThis as { __piModelRouteResolvers?: Set<ModelRouteResolver> };
  for (const fn of g.__piModelRouteResolvers ?? []) {
    try {
      const hit = fn(key);
      if (hit) return hit;
    } catch {
      // a misbehaving publisher must not break dispatch
    }
  }
  return undefined;
}
```

**The existing precedence chain is unchanged:** per-task/per-step `model` →
top-level `subagent.model` → persona frontmatter `model` → child Pi default.
Route resolution is not a new level in that chain. It is a resolution step
applied once to whichever value won:

```ts
const model = requested.includes("/") ? requested : (resolveRoute(requested) ?? requested);
```

**Discriminator: `/`.** A model reference is `provider/model[:thinkingLevel]` and
always contains a slash; a route key never does. This is preferred over a
`route:` prefix (extra syntax for no gain) and over checking the model registry
(makes the meaning of a bare value depend on ambient provider availability, and
gives subagent a registry dependency it does not have today).

**Miss behavior: pass through unchanged.** An unresolved bare value reaches the
child exactly as it does today, and the child errors on an unknown model. The
worst case of the whole mechanism is current behavior.

**Display.** No new source label. The resolved-model display already reports what
the child actually used, so `[agent]` and `[frontmatter]` stay truthful and the
usage line shows the real model. The `:thinkingLevel` re-attachment logic already
handles the suffix a route target produces.

### subagent: persona promotion

Frontmatter gains `promote: true`. When set, `agents.ts` splits the Markdown body:
the `## When to use` section (from its heading to the next `##` or end of file)
becomes `promotedPrompt`; the remainder stays the child's `systemPrompt`.

A `before_agent_start` handler appends every discovered persona's
`promotedPrompt` to the calling agent's system prompt:

```
## Subagent guidance (subagent extension)

### oracle
<promoted text>
```

- `promote: true` with no `## When to use` section promotes nothing. The persona
  still works.
- No promoted personas means no handler output and no heading.
- **Promotion depends only on persona discovery, which subagent fully controls.**
  It therefore cannot inject an instruction for something that is not there —
  which is why promotion is deliberately independent of whether any route
  resolves.
- **Trust.** Promotion inherits the existing gate: project personas enter the
  catalog only when Pi has marked the project trusted, so an untrusted repo
  cannot promote text into the parent's prompt. Note that promotion is a stronger
  surface than the catalog line it sits beside — it is imperative rather than
  descriptive — and restricting promotion to user personas (`~/.pi/agent/agents`)
  is a reasonable future tightening if repo-authored guidance proves noisy.

### Catalog rendering (Channel 2)

Gated by the existing `exposeCatalogInSystemPrompt` flag, `formatModeCatalog`
gains a routes section listing keys resolved for the active mode:

```text
## Available model modes (model-modes extension)

When dispatching subagents (e.g. via the `subagent` tool's `model` parameter),
pass one of these exact strings — including the `:level` suffix — to pin both the
model and its thinking level for that task:

- `low`   → `zai/glm-5.2:low` — Fast, low-cost mode for small, well-defined tasks
- `high`  → `openai/gpt-5.6-sol:high` — Deep reasoning for hard tasks
- `ultra` → `openai/gpt-5.6-sol:max` — Maximum effort for hard, open-ended tasks

Routes (resolved for the active mode; pass the key, not a model string):

- `oracle` — a second-opinion model, deliberately different from the one you are running on
```

One line per key that resolves for the active mode, so a key suppressed by
`false` or by redundancy simply does not appear. The trailing text comes from the
target's optional `description`; without one, the line is the key alone, with no
dangling separator.

This section earns its place by preventing a specific failure. The block above it
tells the agent to pass mode strings as `model`; without a routes entry, an agent
calling the oracle helpfully passes `high` as well, per-task `model` beats
frontmatter, and the route is silently overridden by the main model. Listing
`oracle` in the same menu makes the more specific answer visible next to the
tempting wrong one.

Emitting the key rather than the resolved string is what keeps a stale prompt
from producing a stale dispatch.

### The oracle itself

`pi/extensions/subagent/examples/agents/oracle.md`:

```markdown
---
name: oracle
description: Second-opinion advisor for hard debugging, code review, and planning. Read-only.
tools: read, grep, find, ls
model: oracle
promote: true
---

## When to use

Consult the oracle for code review and architecture feedback, for bugs spanning
multiple files, for planning complex refactors, and for questions needing deep
reasoning.

Do not use it for simple file reads, greps, or codebase search, and do not use it
to make edits — do those yourself.

Tell the user why you are consulting it: "I'm going to ask the oracle for advice."

## Advisor prompt

You are a senior engineering advisor. You cannot modify anything...
```

`model: oracle` is a route key, so the persona routes when `model-modes` is
present and errors informatively when it is not. Substituting a literal
`anthropic/claude-fable-5:high` makes it work standalone.

The `tools` list matches Amp's read-only posture using Pi's own tool names. Amp
also grants `web_search` and `read_web_page`; equivalents are added only if Pi
exposes them under known names.

### Degradation

| Missing | Result |
| --- | --- |
| `model-modes` not installed | Nothing publishes. Bare model values pass through as today. Persona works with a literal `model:`. |
| `subagent` not installed | `model-modes` publishes into the void. No behavior change. |
| No `oracle.md` | Nothing promoted, nothing dispatched. The route resolves but nobody asks. |
| Route key absent or `false` | Value passes through unchanged; child errors on an unknown model. |
| `exposeCatalogInSystemPrompt` off | Routes still resolve at dispatch. Only the agent-facing menu is absent. |

Every direction produces silence or today's behavior. None produces an
instruction pointing at something absent.

## Testing Strategy

Colocated `node:test` files, no running Pi, no provider credentials.

**model-modes `config.test.ts`** — `defaultRoutes` and `modes[].routes` parse;
`false` parses; a key containing `/` is rejected; an unknown root key still
fails; both fields absent yields today's parsed shape.

**model-modes `routes.test.ts`** (new) — resolution order (mode target →
`defaultRoutes` → none); `false` overrides a default; `mode:custom` and
`mode:error` fall to `defaultRoutes`; redundancy suppression when the target
equals the live triple; `thinkingLevel: "off"` renders without a suffix.

**model-modes `catalog.test.ts`** — routes section renders only when routes
resolve; keys appear without resolved model strings; no dangling separator for a
route with no description.

**subagent `agents.test.ts`** — `promote: true` splits `## When to use` from the
child prompt; `promote: true` with no such section promotes nothing and leaves
the body intact; `promote` absent behaves as today; `model: oracle` parses as a
plain string.

**subagent route resolution** — the `globalThis` key is a clean test seam: set
`__piModelRouteResolvers` directly, with no mocking machinery. Covers: a value
containing `/` bypasses lookup; a bare value resolves; a miss passes through
unchanged; a throwing resolver is skipped; the first non-empty answer of several
resolvers wins; no publisher registered is a no-op.

**subagent `index.test.ts`** — promoted sections append under one heading; no
promoted personas appends nothing.

## Acceptance Criteria

- A `model-modes.json` with no `defaultRoutes` and no `modes[].routes` produces
  byte-identical behavior to today, including the catalog block.
- With `routes.oracle` configured, `subagent(agent: "oracle", task: "…")` and no
  `model` parameter spawns a child on the route's model, and the usage line shows
  the resolved model.
- Switching modes with `/mode` mid-session changes the next oracle dispatch's
  model without a reload.
- A session started with `--model` reports `mode:custom` and still routes
  `oracle` via `defaultRoutes`.
- A mode with `"routes": { "oracle": false }` does not route, and passes the bare
  value through.
- When the resolved target equals the live provider/model/thinkingLevel, no route
  resolves.
- With `subagent` installed and `model-modes` absent, an `oracle.md` carrying a
  literal `model:` dispatches normally.
- `npm run typecheck` and `npm test` pass.

## Alternatives Rejected

### A dedicated `oracle` extension with its own `oracle` tool

The strongest nudge, since a tool named `oracle` matches the agent's intent in a
way `subagent` does not. Rejected for now because the published pi `oracle`
extension shows the cost: 1,685 lines whose core is the same
`spawn(pi, ["--mode","json","-p","--no-session","--model",…,"--tools",…])` that
`subagent/index.ts:346` already runs. Building it here means extracting the runner
first or duplicating it. Recorded as the deferred follow-up if autonomous
escalation does not happen often enough in practice.

### subagent special-casing the persona name `oracle`

The smallest diff: hardcode the name, inject a second-opinion section. Rejected
because it teaches a persona-agnostic delegation extension a domain concept it
has no business knowing — worse than an import, since an import is at least
visible in a header — and the next special persona compounds it.

### A separate `modelRoute:` frontmatter field

The original sketch. Rejected because two frontmatter fields answering "which
model" is one concept too many, it adds a level to the precedence chain, and it
leaves the caller unable to name a route in the `model` parameter — so the mode
catalog keeps steering the agent toward overriding the route with a mode string.
Collapsing to one field with one vocabulary is strictly smaller.

### A `route:` prefix on route values

Unambiguous but redundant. `provider/model` always contains a slash and a route
key never does, so the discriminator already exists in the data.

### Resolving bare values against the model registry

Try the value as a model, fall back to a route. Rejected because it makes the
meaning of `model: "oracle"` depend on ambient state — which providers are
authenticated, which models loaded — so a provider shipping a model named
`oracle`, or a route named after a real model, silently flips meaning. It also
gives subagent a registry dependency it does not have; today it passes `--model`
through and lets the child fail.

### Publishing the resolved model string in the system prompt

Would remove Channel 1 entirely. Rejected because the prompt is built once per
turn while the active mode can change at any time, so the agent would pass
through a stale route, and because a resolved string in the prompt is one the
agent can mangle. The key is stable; the value is resolved late.

### Deriving the route by ranking available models

What the published pi `oracle` extension does. Rejected because model-modes'
documented stance is that every mode is user-defined, the extension supplies no
fallbacks and never writes the configuration file. A heuristic that guesses the
user's second opinion contradicts that, and Amp's own routing shows the target is
not always the stronger model anyway.

### Passing the conversation to the advisor (`rpiv-advisor` shape)

Zero-parameter escalation that serializes the live conversation branch, so the
advisor needs no context restated. Genuinely better ergonomics for debugging, and
not Amp's design. Rejected as out of scope: it requires access to the session
transcript and a different execution model from the child-process runner this
project already owns. Worth revisiting on its own merits.
