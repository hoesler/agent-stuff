# Hunk: open the window in a Rex tab

## Intent

When pi runs inside [Rex](https://rex.dev), `/hunk` should open Hunk in a new Rex tab of the session pi lives in, rather than splitting a Ghostty terminal outside it.

## Goals

- A `rex` spawn mode that opens `hunk <target>` in a new, focused Rex tab named `Hunk`, with the repository as its working directory.
- `auto` uses Rex when pi is inside a Rex session.
- A `rexBin` config key (default `rex`) for installs outside PATH.

## Non-goals

- Splitting beside pi's pane in Rex. A tab was asked for.
- Driving a Rex session from outside it, or picking a session other than pi's own.

## Anti-goals

- An explicit `spawn: "rex"` that silently opens Ghostty or herdr when Rex is unavailable.
- A Rex failure that loses the "print the command" fallback.

## Approaches

1. **New tab via `rex window new` (picked).** `rex window new -s "$REX_SESSION" Hunk -c <repo> --json -- <hunkBin> <target...>`. One call, the tab is named, the command is passed as words so no shell quoting is needed. It goes through the login shell's environment (Rex's default), so PATH matches an interactive shell.
2. **Split beside pi via `rex split -b "$REX_BLOCK"`.** Mirrors the Ghostty and herdr behaviour, but the user asked for a tab.
3. **`rex run`.** Also opens a new window, but labels the pane rather than naming the tab.

## Design

- `rex.ts`: `insideRex(env)` is true when `REX_SESSION` is a non-empty string. `windowArgs(session, cwd, hunkBin, target)` builds the argv. `spawnTab(deps, options)` refuses outside Rex without calling anything, runs the command with a 10s timeout, checks `killed` before `code` (pi's `exec` resolves a kill as `code ?? 0`), and passes Rex's own stderr/stdout through on failure.
- `types.ts`: `SpawnMode` and `SPAWN_MODES` gain `rex`; `HunkConfig` and `DEFAULTS` gain `rexBin`.
- `config.ts`: accepts and validates `rexBin` like `herdrBin`.
- `spawn.ts`: `auto` resolves herdr → rex → ghostty. herdr goes first because a herdr pane inside Rex is the layout the user is looking at. An explicit mode is honoured even where it cannot work.
- Tests mirror `herdr.test.ts`, `spawn.test.ts` and `config.test.ts`.
- README: spawn-mode table, config table, a short Rex section, requirements.

## Left to the builder

- Exact wording of messages and doc comments, following the herdr module's style.
