# herdr-blocked

Reports a pi pane as **blocked** in [herdr](https://herdr.dev) while pi is
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

Translates pi's own prompt lifecycle into the event herdr listens for:

| pi event | emitted as |
| --- | --- |
| `ui_prompt_start` | `herdr:blocked` `{ active: true, label }` |
| `ui_prompt_end` | `herdr:blocked` `{ active: false }` |

`ui_prompt_start`/`ui_prompt_end` (pi 0.84.4+) fire around every
`ctx.ui.select`, `confirm`, `input`, `editor` and `custom` call — which is what
"pi is blocked on a human" means — so this covers any extension that blocks, not
only the questionnaire it started with.

## Why pi's events, not rpiv's

Subscribing to `rpiv:ask-user:blocked` directly would fix the one case. pi's own
events are the better source three times over:

- **They cover everything.** Any extension blocking through `ctx.ui.*` is
  reported, with no private agreement needed with each extension's author.
- **The unblock cannot be lost.** pi emits `ui_prompt_end` from a `finally` in
  its extension runner, so an extension that throws mid-prompt still clears the
  state. An extension emitting its own pair can strand herdr on "blocked".
- **The count stays balanced.** pi coalesces nested and overlapping prompts into
  a single outer span, so herdr's blocked counter needs no depth tracking here.

## Labels

herdr shows the label beside the blocked pane. A prompt's own title is used when
it has one. `custom` never does — pi's runner wraps that call as
`withUIPrompt("custom", undefined, ...)`, passing no title — and `custom` is how
the questionnaire blocks, so each kind has a phrase to fall back on
(`waiting for an answer`, `waiting for a choice`, …). See `label.ts`.

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
