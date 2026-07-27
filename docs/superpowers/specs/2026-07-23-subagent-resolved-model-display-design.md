# Subagent Resolved-Model Display

## Goal

Make the subagent TUI usage statistics show the model actually resolved and used by the spawned Pi process, rather than displaying only the requested model argument (for example, `ultra`). Also show the source of the model selection compactly.

## Current behavior

`pi/extensions/subagent/index.ts` launches a child Pi process and initializes `SingleResult.model` from `modelOverride ?? agent.model`. The usage formatter appends that value verbatim. Consequently, aliases or mode-like values passed as overrides can appear as though they were the actual model.

The child assistant message contains the resolved provider and model, with an optional `responseModel` for the provider-reported response model. The extension currently uses only `msg.model` as a fallback, and only when the result did not already have a model.

## Design

### Model metadata

Track two concepts independently:

- **Selection source**: how the requested model was selected:
  - `agent` — the *calling* agent explicitly set it, either as a per-task/per-chain-step override or as a top-level `subagent.model` (whole-call) override. Both forms share this label because in either case it's the orchestrating agent, not the persona config, that made the explicit choice.
  - `frontmatter` — model came from the subagent persona's own `model:` frontmatter field
  - `pi-default` — no explicit selection anywhere; the child Pi process chose its own default
- **Resolved model**: populated from the child assistant message as `provider/responseModel` when `responseModel` exists, otherwise `provider/model`.

The requested model remains available as a fallback only when the child exits before producing an assistant message. The fallback is explicitly marked as unresolved rather than being presented as the actual model.

> Revision note: an earlier draft of this design used four distinct labels
> (`task`, `global`, `agent`, `default`). Review feedback pointed out that
> `[agent]` was ambiguous — it read as "the agent persona's own default"
> when it was meant to mean "the model from agent frontmatter", easily
> confused with "the calling agent explicitly chose this". The label set
> was revised to `agent` / `frontmatter` / `pi-default`, collapsing the
> former `task` and `global` distinction into a single `agent` label (both
> mean the calling agent explicitly picked the model) and freeing up a
> dedicated `frontmatter` label for the persona-config case.

### Precedence and source propagation

The existing precedence remains unchanged:

1. per-task/per-step `model`
2. top-level `subagent.model`
3. agent frontmatter `model`
4. child Pi default

`runSingleAgent` will receive the already-resolved requested model and its source, so single, chain, and parallel execution paths share the same behavior.

### TUI format

Per-agent usage lines will append a compact source label:

```text
7 turns ↑14 ↓1.4k R92k W16k $0.0736 ctx:18k github-copilot/claude-sonnet-5 [agent]
```

Source labels are `[agent]`, `[frontmatter]`, and `[pi-default]`.

For chain and parallel modes, expanded per-step/per-task lines show the resolved model and source. Aggregate totals remain model-neutral because they combine potentially different models.

### Requested thinking level

> Revision note: the original design tracked only the model, which silently
> dropped the `:<level>` effort suffix that the model-modes catalog puts on
> requested model strings. Assistant messages expose `provider`, `model`, and
> `responseModel` but no thinking level, so the level is unrecoverable from the
> child and must be carried over from the requested string. The level is split
> off using Pi's own rule — last colon only, and only when the suffix names a
> valid level — and re-attached to the resolved model.
>
> This is only truthful because an explicit CLI model selection now outranks
> the model-modes `defaultMode`; previously the child ignored both the
> requested model and its level, so echoing the level would have misreported
> what actually ran.

### Error and partial-result behavior

If no assistant message is received, the display uses the requested model when one was explicitly supplied, or an unavailable/default marker when no explicit model was supplied. It must not claim that an alias is the resolved model after a child assistant message has reported the actual model.

## Testing

Add focused unit tests for the model metadata/display helper or equivalent extension logic covering:

1. per-task override takes precedence and displays `[agent]`;
2. whole-call override displays `[agent]`;
3. agent frontmatter displays `[frontmatter]`;
4. no explicit model displays `[pi-default]`;
5. a requested alias such as `ultra` is replaced by the child message's canonical `provider/model`;
6. `responseModel` takes precedence over `msg.model` when present;
7. fallback behavior when the child produces no assistant message.

Run the focused tests, the repository test suite, and TypeScript typechecking before completion.
