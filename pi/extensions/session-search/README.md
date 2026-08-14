# session-search

Find a past conversation again.

You remember that something was discussed with the agent, but not where: which
session, which project, or which fork of which session holds it. This extension
answers that one question — *where is that conversation* — and returns enough to
act on it: a session id to open by hand, and a snippet the calling agent can
read further from. You stay in the current session throughout.

It does not coordinate live sessions, and it does not name them. Titling lives
in [`session-title`](../session-title).

## How it works

A SQLite FTS5 index, kept at `~/.pi/agent/session-search/index.sqlite`, is
refreshed synchronously at the start of every query. There is no daemon, no
background writer, and no event hook: the extension follows *files*, because the
filesystem is the shared channel that in-process events are not — a session
written in another pi window, in another project, is picked up for free.

Session files are append-only, so a refresh reads only the tail past the byte
offset it last recorded. Unchanged files — nearly all of them — cost one `stat`.

The index stores nothing that is not reconstructible from the JSONL, so it is a
cache and not a second source of truth. Deleting it costs one rebuild.

## What gets indexed

Two surfaces, matching how a session is actually recalled.

**What was said** — the prose index: user and assistant text, compaction
summaries, branch summaries, session names, and labels.

Excluded: tool results, bash output, and base64 image data. Those dominate the
corpus by bytes, and indexing them would drown real dialogue — a search for
`auth.ts` would match every session that ever read a file mentioning it.
Assistant `thinking` is excluded too, and available behind `includeThinking`.

**What was done** — the evidence table: one row per tool call, recording the
tool, whether the target was read or written, and the target itself (a path for
file tools, the command string for bash, the pattern for glob and grep).

Two properties follow. Read and write are recorded separately, so "sessions
where I *modified* `auth.ts`" is far more selective than "sessions where that
file appeared". And commands are searchable while their output is not, so "the
session where I ran the migration" works without ingesting a megabyte of logs.

## Branches and forks

A session is a tree: a text match tells you which *file* holds the text, not
which *branch* — and the branch is usually what you are hunting.

Each hit is placed on the session's **main line** (the path from the
chronologically last entry back to the root — the branch a resume lands on) or
on a side branch, in which case the result reports where the branch diverged and
how far it ran. That distinguishes an abandoned false start from the branch
where the work actually happened. A branch is identified by its leaf entry id,
never an ordinal: ordinals renumber when a new branch diverges earlier.

Forking copies entries verbatim and preserves their ids, so the same id in five
files is one moment, not five hits. Results collapse on entry id, and the
canonical hit is the oldest file containing it — where the moment happened. The
descendants are listed alongside as continuations: the ancestor says what was
said, the descendants say where the work went next.

## Tools

### `session_search`

At least one of `query`, `touched`, or `command` is required; the rest narrow.

| Parameter | Meaning |
| --- | --- |
| `query` | FTS5 expression over prose: phrases, `AND`/`OR`/`NOT`, `prefix*` |
| `touched` | glob over a file path from tool evidence, e.g. `**/auth.ts` |
| `action` | narrows `touched` to `write`, `read`, or `any` |
| `command` | substring of a shell command that was run |
| `scope` | where to look; see below |
| `after`, `before` | ISO date, or relative shorthand such as `14d` |
| `role` | `user`, `assistant`, or `any` |
| `limit` | default 10 |

A result is deliberately terse:

```
1. "Ripgrep vs SQLite for session search"   ~/Develop/private/agent-stuff
   2026-07-14 (4 weeks ago) · session 8f2a1c · entry e7f3a2b1
   side branch, diverged 07-14, ran 40 more entries · also in 2 forks
   …convinced that ripgrep might be problematic because of JSON…
```

Worked examples:

- what was said — `{ "query": "\"session index\" AND sqlite" }`
- what was changed — `{ "touched": "**/auth.ts", "action": "write" }`
- what was run — `{ "command": "migrate", "after": "14d" }`
- where — `{ "query": "retry budget", "scope": "repo" }`

### Scopes

`scope` answers *where to look*, and defaults to everywhere. Searching every
project is the default because the question the extension exists for — *where
was that conversation* — is usually asked precisely when the project is what
you have forgotten.

| Scope | Means |
| --- | --- |
| `all` | every indexed session (the default) |
| `project` | the current working directory and everything below it |
| `repo` | that, across every worktree of the current repository |
| `lineage` | the running session's fork family, ancestors and descendants |
| anything else | a path glob over the working directory, e.g. `~/Develop/**` |

The four keywords are matched exactly, so any string with path or glob syntax
in it is unambiguously a glob. A directory named literally `repo` therefore
needs `**/repo` — which is what a working glob for it looks like anyway, since
a bare pattern is already prefix-matched.

`repo` resolves worktrees with `git worktree list` at query time, which is why
the index needs no git column and `--rebuild` stays lossless. The cost is that
a worktree git no longer knows about — one you deleted after merging — is no
longer connected to its repository. Its sessions stay indexed and `all` still
finds them, but `repo` sees them only if the worktree lived *inside* the
repository, as `<repo>/.worktrees/<name>` does: the repository root already
matches everything below it, deleted or not. Worktrees parked outside the
repository drop out of `repo` scope when they are removed.

A scope that cannot be honoured widens rather than narrows, and says so on the
result: `repo` outside a repository searches `project`, and `lineage` with no
running session searches everything. A scope that silently returned less would
read as an answer.

### `session_read`

Expands a hit without leaving the current session.

- `session` — id, unambiguous id prefix, or file path
- one of `entry` plus `around` (default 10 surrounding entries), `branch` with a
  leaf id for that whole path, or `last` for the final N entries
- `include_tools` (default off) adds tool names and targets, never their
  outputs — which is what keeps a 200-entry branch affordable to read
- output is capped at 8000 characters, `offset` pages through it, and truncation
  is stated

## `/session-index`

Reports files indexed, entries, prose and evidence rows, index size on disk,
last refresh, and the cumulative count of unparseable lines skipped.
`--rebuild` drops the index and reingests without a byte budget.

The first search after installing does not stall: inline refresh has a byte
budget (32 MB by default), ingests newest-first past it, and returns results
together with a note saying how many files remain.

## Configuration

Optional — the extension works with no config file at all. Sources, lowest
precedence first:

1. `~/.pi/agent/session-search.json` — global
2. `.pi/session-search.json` — project, merged per field, read only when the
   project is trusted
3. `PI_SESSION_SEARCH_CONFIG` — absolute, or resolved against the startup cwd;
   replaces both

| Field | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `~/.pi/agent/session-search/index.sqlite` | index location |
| `sessionsDir` | `~/.pi/agent/sessions` | what to index |
| `includeThinking` | `false` | index thinking blocks as prose |
| `refreshBudgetBytes` | `33554432` | inline refresh ceiling |
| `excludeCwd` | `[]` | globs of working directories to skip |
| `maxSnippetChars` | `240` | per-result snippet cap |

A broken config file is reported on the next result and otherwise ignored: a
typo must not take searching away, but it must not be silent either.

## Failure behavior

Every case degrades instead of throwing. An unparseable line is skipped,
counted, and the offset still advances — one bad line can never wedge a file. If
another pi process holds the write lock past the busy timeout, the search runs
against the index as it stands and says what it is not including. A schema
version mismatch after an upgrade rebuilds automatically. A missing sessions
directory reports that nothing is indexed.

## Measurements

Taken on a synthetic corpus shaped like a real one — 541 files, 162k entries,
249 MB, mostly tool-result bytes — on an M-series Mac with Node 26:

| | |
| --- | --- |
| Full backfill | 5.0 s (≈49 MB/s), so ≈7 s for a 353 MB corpus |
| Steady-state refresh, unchanged corpus | 7 ms |
| Prose | 2.6% of corpus bytes |
| Index on disk | 33% of corpus bytes |

Full backfill being seconds rather than minutes is why the byte budget is a
safety net rather than the normal path: at this rate the 32 MB default is under
a second. Steady-state refresh is imperceptible inside a tool call.

Take the numbers for your own corpus with:

```bash
pi -e pi/extensions/session-search/index.ts
# /session-index --rebuild   → full backfill time
# /session-index             → steady-state refresh time
du -sh ~/.pi/agent/sessions ~/.pi/agent/session-search/index.sqlite
```

## Attribution

[`thurstonsand/pi-sessions`](https://github.com/thurstonsand/pi-sessions) is the
prior art for keeping a SQLite index of pi sessions. This extension keeps the
index and drops the rest — handoff, inter-session messaging, the session picker,
and titling are out of scope. It also diverges on how the index stays current:
`pi-sessions` writes rows from the running session, while this one follows files.
