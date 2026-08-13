# Session Search Extension

## Goal

Find a past conversation again. The user remembers that something was discussed
with the agent, but not where: which session, which project, or which fork of
which session holds it. Pi stores 541 sessions across 43 project directories in
353 MB of JSONL, and nothing in pi searches them.

The extension answers one question — *where is that conversation* — and returns
enough to act on it: a session id to open by hand, and a snippet the calling
agent can read further from. The user stays in the current session throughout.

Two things it deliberately does not do: coordinate live sessions, or name them.
Titling already exists in the `session-title` extension.

## Prior art

`thurstonsand/pi-sessions` solves this and more: search, follow-up Q&A over old
sessions, deliberate handoffs into child sessions, messaging between live
sessions, a session picker bound to `Alt+O`, and automatic titles. It keeps a
SQLite index at `~/.pi/agent/pi-sessions/index.sqlite`, indexed as conversations
happen, with `/session-index` to backfill.

This design keeps the SQLite index and drops the rest. Handoff, messaging, and
titling are out of scope. It also diverges on how the index stays current:
`pi-sessions` writes rows from the running session, while this extension follows
files. See "Why files, not events".

## Why an index at all

The user's first instinct was ripgrep over the JSONL, on the grounds that a
second store of session data is a second source of truth to keep honest. Three
findings settled it.

**Ripgrep cannot answer the question.** Sessions are trees: entries carry `id`
and `parentId`, and forks are sibling branches under one parent. A line match
tells you which *file* contains the text, not which *branch* — and the branch is
what the user is looking for. Every ripgrep hit would still need the whole file
parsed to place it. Ripgrep also cannot filter by working directory, time, or
tool evidence, and it cannot rank.

**Scanning is too slow per query.** `SessionManager.list()` and `listAll()`
already read every session and concatenate `allMessagesText`, so a scan costs
O(353 MB) of parsing on every search. That is seconds per query, not
interactive.

**The append-only format makes an index cheap to keep current.** Session files
are only appended to. An index that records a byte offset per file reads just
the tail past that offset on refresh. Refresh then costs what was written since
the last search, not what exists in total.

That last point answers the original objection. The index stores nothing that is
not reconstructible from the JSONL, so it is a cache, not a second truth.
Deleting it costs one rebuild.

## Why not DuckDB

DuckDB was considered and rejected on its own documented limits.

Its FTS index does not maintain itself: "The FTS index will not update
automatically when the input table changes. A workaround of this limitation can
be recreating the index to refresh." Recreating the index means re-reading all
353 MB every time a message is appended, which destroys the one property this
design is built on.

Its concurrency model forbids the access pattern. One process may open a
database read-write, or many may open it read-only, but not both. Pi runs in
many windows across 43 project directories, and each refreshes the index at
query time. That is multi-process read-write.

Its FTS extension documents BM25 and conjunctive matching, but no prefix
matching, boolean operators, phrase queries, or snippet functions. SQLite FTS5
provides all of them, verified locally against `node:sqlite` on Node 26.

DuckDB is also a native addon needing per-platform prebuilds, in a package with
one runtime dependency and no build step.

DuckDB would win at analytics over the corpus — token spend per repository per
month, model usage over time — and `read_json_auto` can query the JSONL with no
ingestion at all. That is a different question, answerable with a shell one-liner
when it comes up. It is not this extension's job.

## Storage

One SQLite database, opened through Node's built-in `node:sqlite`, so the
extension adds no dependency. WAL mode, `busy_timeout` set, file mode `0600` —
the index aggregates content from every project the user has worked in.

Default path `getAgentDir()/session-search/index.sqlite`, so
`PI_CODING_AGENT_DIR` is respected, matching how `session-title` locates its
config.

### Schema

```sql
files    (path PK, session_id, cwd, parent_path, created,
          bytes_indexed, size, mtime_ms, last_activity)
entries  (rowid PK, path REFERENCES files, entry_id, parent_id,
          kind, role, ts, text, UNIQUE(path, entry_id))
prose    FTS5(text, content='entries', content_rowid='rowid',
              tokenize='porter unicode61')
evidence (entry_rowid REFERENCES entries, tool, action, target)
```

`prose` is an external-content FTS5 table: it reads text back out of `entries`
by rowid, so prose is stored once and `snippet()` still works. A contentless
table would store less but forbid snippets.

`parent_path` holds `header.parentSession` verbatim — the fork edge. `created`
is the header timestamp; `last_activity` is the newest entry timestamp in the
file, which orders newest-first ingest and answers `after` and `before` at the
session level before entry timestamps are consulted.

**Every entry gets a row in `entries`, including those with no prose.** `text`
is nullable, and only rows with text are inserted into `prose`. This is not
redundancy: branch resolution walks `parent_id` to the root, so a skipped tool
result or model change would break the chain and silently misplace a hit on the
wrong branch. The tree must be complete even where the prose index is sparse.
The cost is a narrow metadata row per entry — on the order of 10⁵ rows — against
an FTS index that stays limited to dialogue.

`entries.kind` records the entry type (`message`, `compaction`,
`branch_summary`, `label`, `session_info`, `model_change`, and so on) so queries
can filter on it and rendering can distinguish them.

`evidence` is queried with `GLOB` and `LIKE` on `target`. At the expected few
hundred thousand rows a scan costs milliseconds, so it needs no index of its
own.

A `schema_version` row drives rebuilds across extension upgrades.

## Refresh

Refresh runs synchronously at the start of every query. There is no daemon, no
background writer, and no event hook.

It walks the session directories with `stat` only — 43 directories, 541 files,
well under 100 ms — and compares each file against its stored `size` and
`mtime_ms`:

- **unchanged** — skip. This is ~540 of 541 files.
- **grown** — read from `bytes_indexed` to EOF, parse whole lines, and advance
  the offset only to the last newline. A partially written trailing line is left
  for the next pass, which is what makes it safe to index a session another pi
  process is writing right now.
- **new** — ingest from byte 0.
- **shrunk, or the stored offset does not land on a newline** — the file was
  rewritten. Drop its rows and re-ingest.

### Idempotency carries the correctness

`entries` is keyed `UNIQUE(path, entry_id)` and ingest uses `ON CONFLICT DO
NOTHING`. Any misjudged rewrite detection, interrupted ingest, or double read
therefore degrades to writing rows that already exist. Correctness never depends
on the offset arithmetic; only speed does.

### Why files, not events

An in-process writer hooked to message events sees only its own session. With 43
project directories and several pi windows open at once, every session written
elsewhere stays invisible until the user remembers to backfill. Following files
picks those up for free, because the filesystem is the shared channel that
events are not.

### The backlog rule

Inline refresh gets a byte budget, default 32 MB. The first search after
installing must not stall inside a tool call while 353 MB is parsed.

Past the budget, refresh ingests newest-first — recent sessions are what gets
searched — then returns results together with an explicit note that N files
remain and `/session-index` will finish them. Partial coverage that says it is
partial beats a hang or a silent omission.

## What gets indexed

Filtering decides both index size and precision. Tool results carry whole file
contents, `BashExecutionMessage` carries full `output`, and `ImageContent`
carries base64. Those dominate the 353 MB. Indexing them would bloat the index
and drown real dialogue: a search for `auth.ts` would match every session that
ever read a file mentioning it.

Two surfaces are indexed, matching how the user actually recalls a session.

### What was said — the prose index

| Source | Rationale |
| --- | --- |
| user text blocks | the user's own words, the strongest handle |
| assistant text blocks | the half-remembered reply |
| `compaction.summary` | for long sessions, the only surviving trace of content compacted away |
| `branch_summary.summary` | describes an abandoned branch — often exactly the fork being hunted |
| `session_info.name` | titles from `session-title`; ranked higher |
| `label` text | user bookmarks: sparse, near-perfect signal |

Excluded: tool results, bash output, base64 image data, and `thinking` blocks.
Thinking is the judgment call — a user may recall something the model reasoned
about, but thinking can outweigh dialogue several times over and costs
precision. Excluded by default, available behind `includeThinking`.

### What was done — the evidence table

Each `toolCall` yields a tool name, an action, and a target: `path` or
`file_path` for read, write, and edit tools; the `command` string for bash; the
pattern for glob and grep. `bashExecution` entries yield their command.

Two properties matter:

- **Read and write are recorded separately.** "Sessions where I modified
  `auth.ts`" is far more selective than "sessions where that file appeared".
- **Commands are searchable, their output is not.** "The session where I ran the
  migration" works without ingesting a megabyte of migration logs.

## Branches and fork families

This is what neither ripgrep nor a session-level index can do, and it is the
user's stated pain: the conversation is in *a fork* of a session, and the forks
look alike.

### Branch resolution

For each hit, load only that file's `(entry_id, parent_id, ts)` skeleton — one
indexed query — and build the tree in memory.

The **main line** is the path from the chronologically last entry back to the
root. That is the branch a resume lands on, which makes it the meaningful
default. A hit is on the main line or it is not; when it is not, the result
reports the divergence timestamp and how many entries the side branch ran past
it. That distinguishes an abandoned false start from the branch where the work
actually happened.

**Branch identity is the leaf entry id**, not an ordinal. Ordinals renumber when
a new branch diverges earlier, and an identifier that changes between being read
and being used is worse than none. Ordinals may still be shown as display sugar.

### Fork families

`files.parent_path` forms a forest. A `WITH RECURSIVE` CTE walks it to a root
file, and results group by that root. Two behaviors follow.

**Exact dedup.** Both fork paths in `SessionManager` — `forkFrom` and
`createBranchedSession` — copy entries verbatim and preserve `entry_id`
(verified in `session-manager.js`). The same `entry_id` in five files is one
moment, not five hits. Collapsing on `entry_id` is an equality check: no
similarity scoring, no threshold to tune.

**Origin over continuations.** The canonical hit is the oldest file containing
the entry, where the moment happened. Descendant sessions are listed alongside
as continuations. The ancestor says what was said; the descendants say where the
work went next; the user picks which to open.

A result therefore reads: *session `8f2a1c`, entry `e7f3`, on a side branch that
diverged 2026-07-14 and ran 40 more entries, originating here and continued in 2
forked sessions.*

## Tools and commands

Two tools and one command. Both tools are written against an agent's context
budget, since every result competes with the user's actual work for room.

### `session_search`

All parameters are optional, but at least one of `query`, `touched`, or
`command` is required.

| Parameter | Meaning |
| --- | --- |
| `query` | FTS5 expression over prose: phrases, `AND`/`OR`/`NOT`, `prefix*` |
| `touched` | glob over a file path from tool evidence, e.g. `**/auth.ts` |
| `action` | narrows `touched` to `write`, `read`, or `any` |
| `command` | substring of a shell command that was run |
| `cwd` | glob over the session's working directory |
| `after`, `before` | ISO date, or relative shorthand such as `14d` |
| `role` | `user`, `assistant`, or `any` |
| `limit` | default 10 |

One result, deliberately terse:

```
1. "Ripgrep vs SQLite for session search"   ~/Develop/private/agent-stuff
   2026-07-14 (4 weeks ago) · session 8f2a1c… · entry e7f3
   side branch, diverged 07-14, ran 40 more entries · also in 2 forks
   …convinced that [ripgrep] might be problematic because of [JSON]…
```

That yields both an id to open by hand and a snippet the agent can decide from.

### `session_read`

Expands a hit without leaving the current session.

- `session` — id or path
- one of `entry` plus `around` (default 10 surrounding entries), `branch` with a
  leaf id for that whole path, or `last` for the final N entries
- `include_tools`, default off, adds tool names and targets, never their
  outputs. This is what keeps a read affordable: a 200-entry branch renders as
  dialogue, not as the megabytes of file contents the dialogue was about.
- output is capped, `offset` pages through it, and truncation is stated

### `/session-index`

Status — files indexed, entries, prose size, index size on disk, refresh
timing, skipped-line count — and `--rebuild`.

### Not included

No `/session-search` command and no TUI picker. The user works from the current
session and asks the agent, which already returns the id. Adding a picker now
would rebuild the part of `pi-sessions` the user called overkill. It stays a
small addition if browsing turns out to be a real want.

The tool descriptions must teach both surfaces — prose for what was said,
`touched` and `command` for what was done. A vague description leaves the model
reaching only for `query`, and the evidence table goes unused.

## Configuration

Its own config file, following the `model-modes` and `session-title` precedent:
`resolveConfigPath`, strict parsing, and a snapshot that carries errors rather
than swallowing them.

Sources, lowest precedence first:

1. `~/.pi/agent/session-search.json` — global, located via `getAgentDir()`
2. `.pi/session-search.json` — project, shallow-merged per top-level field, read
   only when `ctx.isProjectTrusted()` returns true
3. `PI_SESSION_SEARCH_CONFIG` — absolute, or resolved against the startup cwd;
   replaces both

| Field | Default | Meaning |
| --- | --- | --- |
| `dbPath` | `getAgentDir()/session-search/index.sqlite` | index location |
| `sessionsDir` | pi's default sessions directory | what to index |
| `includeThinking` | `false` | index thinking blocks as prose |
| `refreshBudgetBytes` | `33554432` | inline refresh ceiling |
| `excludeCwd` | `[]` | globs of working directories to skip |
| `maxSnippetChars` | `240` | per-result snippet cap |

The extension works with no config file at all.

## Modules

Pi's API is touched in one file; the logic sits behind pure functions, as in the
other extensions here.

| Module | Responsibility |
| --- | --- |
| `index.ts` | pi surface only: two `registerTool` calls, the slash command, config load |
| `config.ts` | config schema, parsing, defaults |
| `db.ts` | DDL, `schema_version`, WAL, file mode |
| `scan.ts` | directory walk, stat comparison, tail read to the last newline |
| `extract.ts` | one entry to a prose row plus evidence rows |
| `ingest.ts` | transactional idempotent apply, offset advance |
| `tree.ts` | main line, divergence, leaf identity |
| `lineage.ts` | fork family walk, entry-id dedup, origin and continuations |
| `search.ts` | query construction, filters, grouping, ranking |
| `render.ts` | result and transcript formatting, caps, paging |

`extract.ts` and `tree.ts` hold the real complexity, and both are pure functions
over plain object literals. Entries are read structurally rather than through
pi's session types, so those modules stay free of pi imports and testable with
literals — the approach `session-title/transcript.ts` already takes.

## Failure behavior

Every case degrades instead of throwing.

- **Unparseable line** — skip it, count it, and still advance the offset. One bad
  line must never wedge a file permanently. The count surfaces in
  `/session-index`.
- **Database write-locked by another pi process** — wait out `busy_timeout`, then
  query the index without refreshing and say so: "not including sessions written
  since 14:02". A search must never fail because another window is indexing.
- **Schema version mismatch** after an upgrade — rebuild automatically.
- **Missing sessions directory** — report that nothing is indexed.

## Testing

Pure modules are tested with literals. For the stateful half, `node:sqlite`
makes real databases cheap in tests, so nothing is mocked: a fixture generator
writes actual JSONL into a temporary directory.

Behaviors that must be pinned:

1. Ingesting twice yields the same row count.
2. Appending to a file and refreshing reads only the new entries.
3. A file ending mid-line leaves the partial line for the next pass.
4. A rewritten file is detected and re-ingested.
5. A fork sharing entry ids produces one result, not two.
6. A branched session classifies main line and side branch correctly, with the
   right divergence point.
7. Prose excludes tool results, bash output, and thinking; evidence captures
   paths and commands with the right action.
8. A refresh over the byte budget returns results plus a backlog note.
9. A branch whose path runs through non-prose entries — tool results, model
   changes — still resolves to the correct root, since the skeleton is complete.

Tests are colocated as `*.test.ts` and added to the `test` script in
`package.json`. `npm run typecheck` covers the new extension through its own
`tsconfig.json`.

## Measurements to take during implementation

Three numbers are asserted nowhere in this design and should be reported rather
than assumed:

1. Full backfill time over 353 MB, which decides whether newest-first ingest is
   a fallback or the default.
2. Prose bytes as a fraction of total bytes, which predicts index size.
3. Steady-state refresh time on an unchanged corpus, which must stay
   imperceptible inside a tool call.
