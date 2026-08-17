# Hunk Review Extension

## Goal

Close the loop between a review the user reads and the work the agent does about
it.

[Hunk](https://www.hunk.dev) is a terminal diff viewer built for reviewing
agent-authored changesets. It holds two channels the agent cannot otherwise
reach. Outbound, the agent can anchor a note to a file and line in the window the
user is looking at, instead of writing findings into chat where they float free of
the code. Inbound, the user can leave inline notes of their own, and
`hunk session comment list --type user` hands them back as structured data.

Nothing in this package consumes either channel today. `/review` produces
prioritized findings as prose in the session, and when the user reviews the
agent's work themselves, their reaction reaches the agent only as retyped prose.

One command, `/hunk`, serves both directions. It starts a review of a target in
the user's Hunk window, or it collects the notes the user left there and
addresses them.

## What Hunk already provides

Hunk 0.18.2 ships everything this extension needs, and the extension is thin
because of it.

The TUI registers with a local daemon, and `hunk session <subcommand>` reaches a
live session non-interactively: `list`, `get`, `context`, `review`, `navigate`,
`reload`, and the `comment` family (`add`, `apply`, `list`, `rm`, `clear`).
`review --json` returns file and hunk structure without the patch text, so an
agent can see the shape of a changeset before deciding what to read.

Hunk also ships its own agent-facing manual. `hunk skill path` prints
`…/libexec/skills/hunk-review/SKILL.md` — 185 lines covering every subcommand,
its flags, and its error messages.

Two facts about that CLI shape the design:

- The TUI is the user's. It needs a terminal, and pi's `ExtensionAPI` offers only
  `exec`, with no way to suspend the TUI and hand over the terminal. The
  extension therefore never runs `hunk diff` in pi's own terminal.
- `hunk session list --json` exits 0 and returns `{"sessions": []}` when nothing
  is live. Every other session command exits 1 and writes `hunk: <message>` to
  stderr. So `list` is the liveness probe, and every other failure carries a
  message worth showing the user verbatim.

## Why a separate extension

The obvious alternative is folding this into `code-review`, which already owns
`/review` and `/end-review`. Three reasons not to.

**`code-review` is a fork.** It tracks
[pi-review](https://github.com/earendil-works/pi-review) upstream. It is also the
least integrated extension in this package: 1928 lines in one file, no
`tsconfig.json`, no tests, absent from the `test` script. New work landing inside
it inherits all of that and makes every future rebase worse.

**The shapes differ.** `code-review` is a prompt-and-rubric workflow whose product
is prose. This extension is a transport with an external binary, a daemon, and a
window that may not exist. Its failure modes are nothing like a rubric's.

**Hunk's value does not depend on a review session.** Whenever the user has a
Hunk window open, the agent should be able to read what they wrote in it. That
should not require entering `/review` first.

### Why no shared target module

Extracting target parsing, the preset picker, and PR checkout from
`code-review/index.ts` into a module both extensions import would give one picker
everywhere. Rejected: upstream keeps changing that file, so carving a module out
of it converts a one-time merge conflict into a recurring one. The extension also
needs only four targets — working tree, staged, base branch, commit — not the
GitHub, Azure DevOps, and folder-snapshot paths, and the folder snapshot has no
meaning for a diff viewer at all.

What the extension does copy is the `ctx.ui.custom` plus `SelectList` idiom, which
`code-review` and `model-modes` already use. Copying a UI idiom that appears twice
is consistency with the package, not duplicated logic.

## Why the mechanics are not documented here

On `resources_discover`, the extension runs `hunk skill path` and returns that
skill's directory in `skillPaths`. The agent then learns the CLI from the
installed binary's own manual.

The alternative — typed tools wrapping each subcommand, or a cheatsheet embedded
in the prompt — means owning a mirror of a surface someone else versions. It
would drift silently on every Hunk release, and the drift would show up as an
agent confidently passing a flag that no longer exists.

So the extension's prompts carry workflow only: what to review, what to do about
a note. They name commands as intent — "leave your findings as one
`comment apply` batch" — never as flag-level syntax.

If `hunk` is missing from `PATH`, or the printed path does not exist, the handler
returns nothing and the extension registers its command anyway — the command then
reports that Hunk is not installed.

## The command

```
/hunk                    pending notes? address them. otherwise review.
/hunk <target>           review that target
/hunk review [target]    force review; no target opens the picker
/hunk fix                force addressing; nothing pending reports that and stops
/hunk … --session <id>   disambiguate when several windows show this repository
```

### Dispatch

Bare `/hunk` with no arguments resolves what to do from live state:

1. Probe for a live session matching the repository with
   `hunk session list --json`.
2. With a live session, read `comment list --type user --json` and subtract the
   notes already addressed on this session branch. Anything left means **fix
   mode**.
3. Otherwise — no live session, or none of its notes are pending — **review
   mode**.

A target argument implies review, because a target says which changeset to look
at and addressing notes never needs one. The explicit subcommands exist so a
correct guess is never the only way to get the other mode: `/hunk review` starts
a fresh review while notes are still pending, and `/hunk fix` says out loud that
nothing is pending rather than silently reviewing instead.

`--session <id>` is accepted by both modes and overrides repository matching. It
is the answer to the several-windows case, and otherwise never needed.

### Target selection

`/hunk review` with no target opens a picker built the same way `code-review`
builds its preset list: `ctx.ui.custom` around a `SelectList`, with a preselected
smart default.

| Entry | Resolves to |
| --- | --- |
| Working tree | `diff` |
| Staged changes | `diff --staged` |
| Against a base branch… | `diff <merge-base>...HEAD`, after a branch sub-picker |
| A commit… | `show <sha>`, after a recent-commit sub-picker |

The smart default is the working tree when it is dirty, and the base branch
otherwise — the same reasoning `code-review` applies.

A target passed on the command line skips the picker and is forwarded to Hunk
verbatim, including pathspecs: `/hunk main...HEAD -- src/ui`. Hunk owns that
grammar, and the extension does not parse it. An invalid target therefore fails
in Hunk, with Hunk's own message.

Absent from the picker: GitHub and Azure DevOps pull requests, and folder
snapshots. Pull requests compose by sequence instead — `/review gh 123` checks the
branch out locally, and `/hunk main...HEAD` then diffs what is on disk. Buying PR
support that way costs nothing and keeps `gh` and the ADO REST API out of this
extension.

## Session lifecycle

`ensureSession(cwd, target)` returns the id of a live session showing the target,
or an explanation of why there is none.

1. **Probe.** `hunk session list --json`, matching each session's `repoRoot`
   against `git rev-parse --show-toplevel`. Both sides go through `realpath`
   first: Hunk reports resolved paths, and on macOS a repository under `/tmp`
   reaches pi as `/tmp/…` and Hunk as `/private/tmp/…`.
2. **One match.** Reload it onto the target with
   `hunk session reload --repo <root> -- diff …` when a target was given. Without
   a target, use it as it stands.
3. **No match.** Spawn a Hunk window on the target, then poll `list` until a
   matching session appears — 200 ms between polls, 5 s ceiling. Called without a
   target, as fix mode calls it, there is nothing to spawn and this reports no
   session instead.
4. **Several matches.** Report the ids and ask for `--session <id>`. Guessing
   which window the user meant is worse than asking.

### Why reload before spawn

The user keeps one Hunk window open beside pi. Spawning a second on every
`/hunk` would bury the first and scatter their notes across windows the extension
then has to disambiguate. Reloading keeps one window as the review surface, which
is also how Hunk's own workflow reads.

The cost is that review mode replaces what the user was looking at. Two things
make that acceptable. Fix mode never reloads, so the loop the user runs most —
review in the window, then `/hunk` — leaves their view alone. And review mode
always names its target, either because the user typed it or because they chose it
from the picker, so a reload is never a surprise.

### Spawning a window

Adapted from
`mitsuhiko/agent-stuff`'s `split-fork.ts`: `osascript` drives Ghostty's
`new surface configuration`, setting the initial working directory and initial
input, and splits the focused terminal to the right — falling back to a new
window when none is open.

The initial input is `hunk diff <target>\n`.

Guarded twice: `process.platform === "darwin"`, and a successful `osascript`
exit. When either fails, the extension prints the exact command for the user to
run in their own terminal and stops. Nothing about the design assumes Ghostty
beyond this one module; a session the user opened by hand is
indistinguishable to every other part of the extension.

## The two workflows

Both hand the agent a prompt through `pi.sendUserMessage`, the way
`code-review` does.

### Review mode

The prompt asks the agent to read structure first with
`session review --repo . --json`, pull patch text only for the files it must
actually read, leave its findings as one `comment apply` batch, navigate to the
first note, and summarize in chat. It also carries `REVIEW_GUIDELINES.md` from
the project root when that file exists, so guidelines the user already wrote for
`/review` apply here too.

The emphasis worth keeping in the prompt is restraint: a note per hunk turns the
window into noise, and the value is in the notes the user would not have written
themselves.

### Fix mode

The prompt carries the pending notes as a work list — file, line, summary,
rationale — and asks the agent to address each one, then reply on the same line
with `comment add --author pi`, saying what changed.

The reply is the point. A fix reported only in chat leaves the window showing an
unanswered note, and the user has to hold both halves in their head to see what
happened.

### Why the user's notes stay standing

The extension never removes a user note. `comment rm` would make the remaining
`--type user` list exactly the open queue, which is tempting, but it deletes what
the user asked for as soon as the agent believes it complied. The user clears
their own notes when satisfied.

Classification comes from Hunk's own `--type` filter, never from author strings.
`--type user` is what the user typed in the TUI; anything the extension writes
arrives as an agent note.

### The addressed set

Because notes stay standing, "pending" cannot mean "any user note" — every later
bare `/hunk` would dispatch to fix mode forever. Pending means *user notes whose
comment ids are not in the addressed set*.

The set is appended to the session as a custom entry and restored by scanning the
branch, exactly as `tool-catalog/state.ts` restores tool overrides: filter for
`type === "custom"` with this extension's `customType`, take the last valid one,
and let a malformed later entry never discard a good earlier one. Forking a
session therefore carries the addressed set along the branch that earned it.

Keying on Hunk's `noteId` has one consequence worth stating: relaunching the Hunk
window mints new ids, so every note reads as new again. That is the right default.
A fresh window is a fresh review, and re-answering a note is cheap while silently
skipping one is not. Reloading a window is not a relaunch — ids survive it, as
measured below.

This is also what makes `/hunk fix` re-runnable. Asking it twice in a row answers
"anything new for me?" honestly, rather than redoing the same work.

## Combining with `/review`

One additive change to `code-review`, and no shared code.

When `/review` builds its prompt, it probes for a live Hunk session matching the
repository. If one exists, the prompt gains a paragraph asking the agent to also
leave each finding as an inline note in that window. Findings then land where the
code is, and `/end-review`'s existing "Return and fix findings" path keeps
working unchanged.

The probe is one `hunk session list --json` call, so `/review` behaves exactly as
it does today when Hunk is not installed or no window is open.

Deliberately not built: `/end-review` draining user notes. The `/hunk fix` path
already does that, from inside or outside a review.

## Configuration

Its own config file, following the `model-modes` and `session-title` precedent —
`resolveConfigPath`, strict parsing, and a snapshot that carries errors rather
than swallowing them. The extension works with no config file at all.

| Field | Default | Meaning |
| --- | --- | --- |
| `hunkBin` | `hunk` | path to the binary, for installs outside `PATH` |
| `spawn` | `ghostty` | `ghostty` or `never`; `never` always prints the command instead |
| `noteAuthor` | `pi` | `--author` on notes the extension writes |

## Modules

Pi's API is touched in one file, and the logic sits behind injected functions, as
in the other extensions here.

| Module | Responsibility |
| --- | --- |
| `index.ts` | pi surface only: `registerCommand`, the `resources_discover` handler, the widget |
| `config.ts` | config schema, parsing, defaults |
| `cli.ts` | Hunk invocations over an injected `exec`; JSON parsing; `hunk: …` error extraction |
| `session.ts` | `ensureSession`: repo-root matching, reload, spawn, the poll loop |
| `ghostty.ts` | the AppleScript split, over injected `exec` and platform |
| `targets.ts` | picker entries, smart default, branch and commit sub-pickers, target to Hunk argv |
| `pending.ts` | the addressed set: restore from branch entries, subtract from a note list |
| `prompts.ts` | the review and fix prompts, and rendering a note list into a work list |

`pending.ts` and `targets.ts` hold the logic worth testing and are pure functions
over plain object literals, so neither imports pi — the approach
`session-title/transcript.ts` and `tool-catalog/state.ts` already take.

## Failure behavior

Every case degrades into a message that names the next move.

- **`hunk` not on `PATH`** — the command reports it once, with the install
  hint. `resources_discover` contributes no skill path.
- **No live session and no window spawned** — print the exact `hunk diff <target>`
  command to run, and stop. Never start a turn the agent cannot complete.
- **`/hunk fix` with no live session** — report that no Hunk window is open, so
  there are no notes to collect. Fix mode never spawns a window: a window opened
  now would be empty of the notes it exists to read.
- **Spawn succeeded, poll timed out** — say the window opened but did not register
  within 5 s, and suggest re-running `/hunk`. Do not start a turn.
- **Several sessions match the repository** — list the ids, ask for
  `--session <id>`.
- **Any other non-zero Hunk exit** — surface Hunk's own stderr message verbatim.
  Hunk's skill documents each one, including that "No active Hunk sessions" can
  mean the agent's sandbox blocked localhost rather than that no window is open.
  Rewording those messages would break that mapping.
- **Not a git repository** — report it. Repo-root matching has nothing to match
  against.
- **`comment add` fails after a fix** — report which notes went unanswered, and
  leave their ids out of the addressed set. A silent failure here would mark work
  as answered in a window that shows no answer.

## Testing

Colocated `*.test.ts` using `node:test` and `node:assert/strict`, added to the
`test` script, with a `tsconfig.json` so `npm run typecheck` covers the
extension.

Behaviors to pin:

1. `session list --json` with an empty array resolves to "no live session",
   without consulting exit codes.
2. A non-zero exit with `hunk: <message>` on stderr surfaces that message
   verbatim.
3. Each of the four resolution branches — one match, one match with a target, no
   match, several matches — against a fake `exec`.
4. The poll loop stops at the first matching session, and gives up at the
   ceiling without hanging.
5. Bare `/hunk` dispatches to fix mode with a pending note and to review mode
   without one.
6. A target argument dispatches to review mode even when notes are pending.
7. Notes already in the addressed set are not pending; a note added afterwards
   is.
8. A malformed addressed-set entry appended after a good one leaves the good one
   in force.
9. Each picker entry produces the right Hunk argv, and a command-line target is
   forwarded unparsed, pathspec included.
10. `ghostty.ts` refuses a non-darwin platform without invoking `osascript`.

## Verified against a live session

Measured against Hunk 0.18.2, driving a real session through a pty. The JSON
shapes below are what the implementation parses.

`session list --json` returns `{"sessions": [...]}`, each entry carrying
`sessionId`, `pid`, `cwd`, `repoRoot`, `title`, `fileCount`, `files[]`, and a
`snapshot.state` block. **`repoRoot` is the field to match on**, and it arrives
fully resolved — `/private/tmp/…`, not `/tmp/…` — so matching must compare real
paths, not the string pi was started with.

`comment list --json` returns `{"comments": [...]}` with `noteId`, `source`,
`filePath`, `hunkIndex`, `newRange`/`oldRange`, `body`, `author`, `createdAt`, and
`editable`. `comment add --json` returns the same identifier under a different
name — `result.commentId`. `summary` and `rationale` arrive merged into `body`,
separated by a blank line.

Type separation works as assumed: a note added through the CLI reads as
`source: "agent"` and is absent from `--type user`.

Two findings settle open questions:

**Comment ids are stable across a reload, and notes survive it.** The addressed
set can therefore key on `noteId` even when the window is reloaded. Only
relaunching Hunk mints new ids.

**Anchors do not follow the code.** After shifting every line in a file down by
one and reloading, the note still reported `newRange: [2, 2]` — the old line
number, now pointing at different content. This settles reload-after-fix as
something to leave out rather than defer: reloading after a fix would leave every
note pointing at whatever moved into its old position. Fix mode not reloading is
the feature, not a limitation.

### Still to verify

One thing remains, and it needs a running pi rather than a running Hunk:
**whether `skillPaths` wants the skill directory or its parent.** `hunk skill
path` prints a path to `SKILL.md`; pi's own layout is `skills/<name>/SKILL.md`.

## Not included

- Reloading the window after a fix. Anchors keep their old line numbers, so a
  reload would point every note at whatever moved into its place.
- STML rich markup notes. They need `--experimental` on the user's own launch,
  and plain summaries carry the workflow.
- Typed tools wrapping the Hunk CLI. The adopted skill covers the surface.
- `/end-review` draining user notes.
- Any Hunk target the picker omits: pull requests via `gh` or ADO, folder
  snapshots, stashes, patch files, `difftool` pairs.
