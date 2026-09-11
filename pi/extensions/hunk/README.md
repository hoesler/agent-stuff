# hunk

`/hunk` reviews a changeset in a live [Hunk](https://www.hunk.dev) window, leaving findings as inline notes. Run `/hunk fix` to address the notes you left, replying on each line to mark them handled. The agent adopts Hunk's own skill at startup, so its CLI knowledge tracks the installed binary.

## Forms

| Command | Meaning |
| --- | --- |
| `/hunk` | Auto mode: try to address pending notes in an open Hunk window, or if none, prompt to pick a changeset and review it. |
| `/hunk <target>` | Review mode with a specific target: same as `/hunk review <target>`. |
| `/hunk review` | Review mode: pick a changeset and review it, opening or reloading a Hunk window. |
| `/hunk review <target>` | Review mode with a specific target: `diff`, `diff --staged`, `diff <branch>...HEAD`, `show <commit>`, or any other Hunk argument. |
| `/hunk fix` | Fix mode: collect notes left in the Hunk window and address each one. |
| `--session <id>` | Use a specific Hunk session instead of matching by repository. Append to any command form. |

## What it does

The extension runs Hunk in your own terminal. When you run `/hunk review`, it reuses a live Hunk window if one is open for this repository and reloads it with the target, or opens one beside you (one terminal per repository): a [herdr](https://herdr.dev) pane when pi is running inside herdr, otherwise a Ghostty right-split on macOS. If you open a window yourself with `hunk diff`, running `/hunk` finds it automatically.

You review the changeset, leaving notes on code that needs attention. Notes are never removed by the extension — only marked as handled when the agent replies on the same file, side, and line with `comment add`, using `--author <noteAuthor>` to sign the reply.

The addressed set lives in the session only. Closing and relaunching Hunk makes every note read as new again, so you can re-review one diff multiple times.

## Auto mode behavior

Bare `/hunk` (with no arguments at all) runs in auto mode:

1. It tries to collect pending notes from the live Hunk window and address them.
2. If there are no pending notes, or if there is no window open, it proceeds to review mode and prompts you to pick a changeset.

This means `/hunk` can mean either "fix the notes I left" or "review a changeset" depending on what is live — the agent decides by trying fix first. Providing a target (e.g., `/hunk <target>`) skips auto mode and goes straight to review mode.

## Configuration

Configuration lives in `~/.pi/agent/hunk.json` (user-scoped) or `.pi/hunk.json` (project-scoped, trusted projects only), or in a custom path via `PI_HUNK_CONFIG`. The project file takes precedence over the user file. An empty config is valid — the extension ships working defaults for every key.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `hunkBin` | string | `hunk` | Path to the Hunk binary. Use this if your install is outside PATH. |
| `herdrBin` | string | `herdr` | Path to the herdr binary, for the same reason. |
| `spawn` | `auto` \| `herdr` \| `ghostty` \| `never` | `auto` | Where to open a window when none is live. |
| `noteAuthor` | string | `pi` | Author name stamped on notes the agent writes (`--author <noteAuthor>`). |

### Spawn modes

| Mode | What it opens |
| --- | --- |
| `auto` | A herdr pane when pi is running inside herdr, otherwise a Ghostty split. |
| `herdr` | Always a herdr pane. Fails, rather than falling back, when pi is not inside one. |
| `ghostty` | Always a Ghostty split, even inside herdr. |
| `never` | Nothing — prints the command for you to run. |

Whatever the mode, a failure to open a window is never fatal: the extension prints `hunk <target>` for you to run yourself, and `/hunk` picks the window up from there.

Example config:

```json
{
  "hunkBin": "/usr/local/bin/hunk",
  "spawn": "never",
  "noteAuthor": "claude"
}
```

### herdr

In herdr mode the extension splits *your own* pane, so the diff lands in the layout you are looking at:

```bash
herdr pane split --current --direction right --cwd <repo> --focus
herdr pane run <new-pane-id> 'hunk diff'
```

Both calls go through the `herdr` binary, which speaks the [socket API](https://herdr.dev/docs/socket-api/). `pane run` is what sends the command text and Enter as one submission, honoring the pane's live bracketed-paste mode.

herdr sets `HERDR_ENV=1` in every pane it manages, and that is how the extension knows it is inside one. Driving a herdr session from outside it is not supported, so a missing `HERDR_ENV` is reported rather than worked around.

## What it leaves alone

- **User notes**: The extension never removes notes, even when fixing them. Only replies mark them addressed.
- **Other sessions**: Each Hunk session is independent. The extension only looks for sessions in the current repository.
- **Manual notes**: Notes left with the TUI are never touched; only agent-written replies are matched to confirm handling.
- **The Hunk window**: After spawning, the extension hands the terminal to you. You type commands, edit files, and open the diff just as you would without the agent.

## Requirements

- **Hunk 0.18.2** or later.
- To open a window: either **herdr** with pi running inside one of its panes, or **Ghostty** on **macOS**. With neither, `/hunk` prints the command for you to run by hand.

## Attribution

The Ghostty split logic (`ghostty.ts`) is adapted from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)'s `split-fork.ts`.
