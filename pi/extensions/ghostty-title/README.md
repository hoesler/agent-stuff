# ghostty-title

Ghostty window title and progress bar for pi. The title shows the project, the
session name and the model:

```
π · agent-stuff · palette · claude-sonnet
```

While the agent works, a braille spinner runs in front of it and the running
tool replaces the model (`⠙ π · agent-stuff · bash`), and Ghostty's native
progress bar pulses. When the turn ends, the bar flashes complete and goes away.

Forked from [pi-ghostty](https://github.com/HazAT/pi-ghostty) by HazAT (MIT,
see `LICENSE`).

## What changed from pi-ghostty

**The spinner pauses while a prompt waits on you.** Upstream rewrote the title
every 80 ms from the first step of a turn to the last. A question from an ask
tool happens inside a tool call, so the spinner kept going the whole time pi was
waiting for an answer, which says "busy" when the opposite is true.

It also erased anything else that marks the terminal through its title.
agentdash appends `● needs you` to the
title of an agent waiting on you, so Ghostty's command palette (⌘⇧P, type
`need`) can jump to it. Rewritten every 80 ms, that suffix was visible for a
fraction of a second per poll and the palette almost never found it.

Now, on pi's `ui_prompt_start` during a turn, the spinner stops and the title
holds still on the running tool (`π · agent-stuff · ask_user`). On
`ui_prompt_end` it resumes. A prompt raised while idle, such as a menu you open
yourself, changes nothing.

Smaller changes: imports moved to `@earendil-works/pi-coding-agent`, the logic
moved into `title.ts` with tests, and a spinner frame that fires after a session
replacement no longer throws on the stale context.

## Install

Remove pi-ghostty first, from the packages in `~/.pi/agent/settings.json` or
through `pi config`: two extensions animating one title fight each other. Then
enable this one for the `hoesler` package:

```
+pi/extensions/ghostty-title/index.ts
```

in `~/.pi/agent/settings.json`, or through `pi config`. Requires pi ≥ 0.84.4 for
the `ui_prompt_*` events.
