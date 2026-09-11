# herdr-blocked

Reports a pi pane as **blocked** in [herdr](https://herdr.dev) while the agent is
waiting on you, instead of leaving it on "working" until you notice.

herdr's own integration already reports the rest. `herdr integration install pi`
writes `~/.pi/agent/extensions/herdr-agent-state.ts`, which derives "working"
and "idle" from `agent_start` and `agent_settled`, and takes the third state
from an event on pi's bus:

```ts
pi.events.on("herdr:blocked", (data) => { /* data.active, data.label */ })
```

Nothing emits it. `herdr:blocked` is herdr's own name, so only an extension
written against herdr would send it, and the extension here that actually blocks
— [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
— publishes its equivalent under its own namespace as `rpiv:ask-user:blocked`,
per its documented stability policy. The two never meet, so a questionnaire
waiting on an answer reads as "working" in herdr for as long as it is open.

## What it does

Joins the two, by name:

| rpiv event | emitted as |
| --- | --- |
| `rpiv:ask-user:prompt` | *(held — it carries the questionnaire, and the label comes out of it)* |
| `rpiv:ask-user:blocked` `{ active: true }` | `herdr:blocked` `{ active: true, label }` |
| `rpiv:ask-user:blocked` `{ active: false }` | `herdr:blocked` `{ active: false }` |

Every blocking source is named on purpose. Prompts this package raises itself go
through `whileBlocked` at the point they are raised — currently the `subagent`
tool's project-agent trust confirmation, which stops a run until a human answers.

## Why not pi's own prompt events

An earlier version of this extension translated pi's `ui_prompt_start` and
`ui_prompt_end` (0.84.4+), which fire around every `ctx.ui.select`, `confirm`,
`input`, `editor` and `custom` call. It covered any extension that blocks,
without a private agreement with each author. It was the wrong signal.

Those events say a modal is up. They do not say the agent is waiting on one, and
nothing in the payload distinguishes the two: a prompt carries its `kind`, an
optional `title`, and a constant `reason: "ui_prompt"` — never who opened it. So
`/hunk`, `/mode`, `/tools` and `/review` all reported the pane as blocked, which
is the opposite of useful: a state that means "come back to me" is worth nothing
if opening a menu sets it.

Gating those events on agent activity — only count a prompt raised while the
agent loop runs, or while a tool executes — narrows the window without closing
it. A tool execution is minutes long, and those minutes are exactly when you
wander off and open a menu.

Two claims in the earlier version's reasoning were also simply wrong:

- **"An extension emitting its own pair can strand herdr on blocked."** rpiv
  emits `{ active: false }` from a `finally` on both of its paths
  (`ask-user-question.ts`), which is the same guarantee pi's extension runner
  gives. Its pairs are balanced, so nothing here tracks depth.
- **"pi's events cover the questionnaire everywhere."** On RPC hosts — Zed, the
  VS Code pendant — rpiv cannot render its overlay and walks the questions
  through `ui.select`/`ui.input` one at a time. pi fires a separate prompt span
  per question, so the pane flickered blocked→unblocked between the questions of
  a single questionnaire. rpiv's own event brackets the whole thing once.

What the change gives up: an extension that blocks through `ctx.ui.*` without
announcing it reads as "working". That is the trade — a bridge that cries
blocked every time you open a menu is worse than one that misses a third
extension until someone adds it.

## Labels

herdr shows the label beside the blocked pane. It comes from the questionnaire
itself: the first question's `header`, rpiv's own short chip, authored to be read
at a glance. The question text is the fallback, cut to fit a pane, and a payload
with no question in it at all still says `waiting for an answer`. See `rpiv.ts`.

## Adding another blocking source

For a prompt this package owns, wrap it — the clear runs from a `finally`, so a
prompt that throws cannot stand the pane on "blocked" for the rest of the
session:

```ts
import { whileBlocked } from "../herdr-blocked/blocked.ts";

const ok = await whileBlocked(deps.events, "Run project-local agents?", () =>
  ctx.ui.confirm(title, body),
);
```

`events` is `pi.events`, which pi hands to extensions but not to tools: pass it
in at registration. It is optional, so a tool built without one prompts as usual
and reports nothing.

For an extension someone else owns, the equivalent is a channel of their own to
listen for here, the way rpiv's is listened for.

## Install

This file is deliberately separate from herdr's managed extension:
`herdr integration install` overwrites `herdr-agent-state.ts` on every update,
and its own header says to add hooks beside it rather than edit it.

Enable it for the `hoesler` package:

```
+pi/extensions/herdr-blocked/index.ts
```

in `~/.pi/agent/settings.json`, or through `pi config`.

## If nothing changes

This feeds the same socket that carries every other herdr report, so it is
silent whenever that socket is. Under [nono](https://github.com/always-further/nono),
check that the profile pi runs under passes the handshake variables through and
grants the herdr socket — without both, `herdr-agent-state.ts` disables itself at
load and no state is reported at all:

```json
"environment": { "allow_vars": ["…", "HERDR_*"] },
"filesystem": { "unix_socket_dir": ["$HOME/.config/herdr"] }
```

Verify from inside a herdr pane with
`nono run --profile pi -- node -e 'console.log(process.env.HERDR_SOCKET_PATH)'`.

The questionnaire must also be the one doing the asking: this reports what rpiv
and this package's own prompts announce, so a block raised anywhere else stays
invisible by design.
