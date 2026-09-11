# hunk

`/hunk` opens a changeset in a live [Hunk](https://www.hunk.dev) window — for the agent to review, leaving findings as inline notes, or for you to read yourself. Run `/hunk fix` to address the notes you left, replying on each line to mark them handled. The agent adopts Hunk's own skill at startup, so its CLI knowledge tracks the installed binary.

## Forms

| Command | Meaning |
| --- | --- |
| `/hunk` | The menu: what to look at, and whether the agent reviews it or you do. |
| `/hunk <target>` | Review a specific target: same as `/hunk review <target>`. |
| `/hunk review` | Pick a changeset and review it, opening or reloading a Hunk window. |
| `/hunk review <target>` | Review a specific target: `diff`, `diff --staged`, `diff <branch>...HEAD`, `show <commit>`, or any other Hunk argument. |
| `/hunk open` | Pick a changeset and open it in Hunk, with no agent review. |
| `/hunk open <target>` | Open a specific target in Hunk. |
| `/hunk fix` | Collect the notes left in the Hunk window and address each one. |
| `--session <id>` | Use a specific Hunk session instead of matching by repository. Append to any command form. |

## What it does

The extension runs Hunk in your own terminal. When you run `/hunk review`, it reuses a live Hunk window if one is open for this repository and reloads it with the target, or opens one beside you (one terminal per repository): a [herdr](https://herdr.dev) pane when pi is running inside herdr, otherwise a Ghostty right-split on macOS. If you open a window yourself with `hunk diff`, running `/hunk` finds it automatically.

You review the changeset, leaving notes on code that needs attention. Notes are never removed by the extension — only marked as handled when the agent replies on the same file, side, and line with `comment add`, using `--author <noteAuthor>` to sign the reply.

The addressed set lives in the session only. Closing and relaunching Hunk makes every note read as new again, so you can re-review one diff multiple times.

## The menu

Bare `/hunk` asks rather than decides:

```
┌─ Hunk ─────────────────────────────────────────────────────────────┐
│ → 3 notes you left in Hunk        reply to each, mark them handled │
│   Uncommitted changes             7 files · hunk diff              │
│   Staged changes only             2 files · hunk diff --staged     │
│   This branch vs main             12 files · hunk diff main...HEAD │
│   A commit…                       choose from the last 15          │
│   Another branch…                 choose what to compare against   │
│ enter to review with the agent · o to open it yourself · esc       │
└────────────────────────────────────────────────────────────────────┘
```

`enter` hands the changeset to the agent; `o` opens it in Hunk and leaves it to you. On the notes row `enter` addresses them and `o` means nothing, so the footer follows the cursor and names only the verbs the highlighted row has.

Rows appear only when they have something in them. A clean working tree has no `Uncommitted changes` row, a branch level with its base has no comparison row, and the notes row is there only while a live window holds notes you have not had answered yet. Whatever is missing is explained in a muted line under the rows — `no Hunk window open for this repository`, `no new notes in wB:p2`, `nothing uncommitted or staged` — and if nothing at all can be offered, the menu does not open.

The base branch behind `This branch vs …` is read from `origin/HEAD`, falling back to a local `main` or `master`. The branch you are on is never offered as its own base; `Another branch…` is there to compare against anything else.

Counts come from `git status --porcelain -b`, `git diff --cached --name-only` and one `git diff --name-only <base>...HEAD`, all read before the menu opens. A git call that fails costs its own row and nothing more.

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
