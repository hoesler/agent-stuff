---
name: session-search
description: Find a past pi conversation across every project, session, and fork — by what was said, which files were read or changed, or which commands were run — and read it without leaving this session. Use when the user refers to something discussed or done in an earlier session ("we talked about…", "last week I…", "the session where we changed auth.ts"), or when earlier work would answer the question.
---

# session-search

Run `./cli.ts` (relative to this skill's directory) with `node`. It refreshes its index on every call, so results include sessions written a moment ago in another window.

## Search

```bash
node ./cli.ts search '"session index" AND sqlite'           # what was said
node ./cli.ts search --touched '**/auth.ts' --action write  # what was changed
node ./cli.ts search --command migrate --after 14d          # what was run
node ./cli.ts search 'retry budget' --scope repo            # where
```

- `QUERY` is FTS5 over user and assistant prose, session names, and summaries: `"quoted phrases"`, `AND`/`OR`/`NOT`, `prefix*`. Wrap it in single quotes. If it contains a single quote, pass `-` and send the query on stdin with a quoted heredoc.
- `--touched` globs a file path from tool calls; `--action read|write|any` narrows it.
- `--command` matches a substring of a shell command. Command output is never indexed, so search for the command, not for what it printed.
- `--scope`: `all` (default), `project` (this directory), `repo` (all its worktrees), `lineage` (this session's forks), or a path glob. A scope that cannot apply widens and says so.
- `--after`/`--before` take an ISO date or `14d`; `--role user|assistant`; `--limit` (default 10, max 50).

Give at least one of `QUERY`, `--touched`, or `--command`.

Each hit prints a full session id, an entry id, whether it sits on the main line or an abandoned side branch, and a snippet. Pass ids on in full; a shortened id matches every session started within hours of it.

## Read a hit

```bash
node ./cli.ts read <session-id> --entry <entry-id> --around 5
node ./cli.ts read <session-id> --branch <leaf-entry-id>
node ./cli.ts read <session-id> --last 30 --include-tools
```

`--include-tools` adds tool names and targets, never their output. Output is capped at 8000 characters; `--offset` pages on, and truncation is stated.

To hand a session to the user, give them `pi --resume <session-id>`.

## Errors

Exit 1 means the query failed — a malformed FTS5 expression, an unknown or ambiguous session — and stderr says why; fix it and run again. Exit 2 means the invocation was wrong and prints usage.
