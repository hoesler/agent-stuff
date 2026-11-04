# program-status-blocked

Reports pi as **blocked** to the terminal while
[@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
waits on an answer, instead of leaving it on "working".

pi reports its own state with the
[Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status),
which [Rex](https://www.superlogical.com/rex) shows in its tab headers and session
picker. pi marks its own `select`, `confirm`, `input` and `editor` dialogs as
blocked. It does not mark `ctx.ui.custom`, and rpiv draws its questionnaire with
`ctx.ui.custom`. So pi reports "working" for the whole time the questionnaire is
open.

## What it does

rpiv announces the wait on pi's event bus as `rpiv:ask-user:blocked`, the same
event [`herdr-blocked`](../herdr-blocked) forwards to herdr. This extension turns
it into a terminal report:

| rpiv event | reported |
| --- | --- |
| `rpiv:ask-user:blocked` `{ active: true }` | `state=blocked:kind=question`, with the first question's header as the message |
| `rpiv:ask-user:blocked` `{ active: false }` | whatever pi last reported |

The label comes from the same code as herdr's: see `../herdr-blocked/rpiv.ts`.

## How it reaches the terminal

Extensions get no handle on pi's status reporter, so this works around it in two
ways:

- **Finding the terminal.** A widget factory receives the TUI. At session start
  the extension mounts an empty widget to pick up `tui.terminal` and removes it
  before it renders.
- **Restoring pi's status.** pi skips a report that matches its last one. After
  the questionnaire closes pi's state has not changed, so pi reports nothing and
  a plain `blocked` write would stay on the terminal. Instead the extension wraps
  `terminal.setProgramStatus` (`status.ts`). While blocked it holds pi's reports
  back and remembers the latest one. On release it writes that report again, so
  the terminal ends up where pi would have put it.

Both rely on pi internals: that `tui.terminal` is the terminal pi reports through,
and that pi reports through `setProgramStatus`. If pi adds a way for extensions to
report a block, or marks `ctx.ui.custom` itself, delete this extension.

pi's support detection still applies. The wrapper calls pi's own
`setProgramStatus`, so a terminal that does not answer the OSC 7501 query gets
nothing, and `PI_PROGRAM_STATUS=0|1` works as documented.

## Install

Enable it for the `hoesler` package:

```
+pi/extensions/program-status-blocked/index.ts
```

in `~/.pi/agent/settings.json`, or through `pi config`. It is independent of
`herdr-blocked`. Enable both if you use herdr and an OSC 7501 terminal.
