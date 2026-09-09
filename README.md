# agent-stuff

Christoph's extensions, skills, and rules for [pi](https://github.com/earendil-works/pi).

Install the whole package:

```bash
pi install git:github.com/hoesler/agent-stuff
```

Pi loads everything the package declares. Use `pi config` to enable or disable individual resources.

## Extensions

| Extension | What it does |
| --- | --- |
| [`agent-modes`](pi/extensions/agent-modes) | Bundles a provider, model, and thinking level into one named mode. `/mode` selects one, a shortcut cycles them, and a configured default applies at startup. |
| [`subagent`](pi/extensions/subagent) | Two delegation tools over a child `pi` process. `subagent` delegates a task to a persona in its own context window (single, parallel, and chained modes; personas come from `~/.pi/agent/agents` and trusted `.pi/agents`, with the discovered catalog baked into the tool schema so the caller cannot name one that does not exist). `oracle` escalates a hard question to a deliberately different model — fresh context, read-only tools. Each is advertised only while it can do anything. |
| [`session-title`](pi/extensions/session-title) | Names a session from its first exchange using a cheap, explicitly configured model. `/title` re-titles on demand. |
| [`session-search`](pi/extensions/session-search) | Finds a past conversation across every project, session, and fork. A self-refreshing SQLite FTS5 index over the session JSONL backs `session_search` (what was said, plus which files and commands were touched) and `session_read` (expand a hit without leaving the session). `/session-index` reports coverage. |
| [`tool-catalog`](pi/extensions/tool-catalog) | `/tools` lists every registered tool, named by the extension that registered it — or `builtin`/`sdk` for pi's own — with its description, package, defining file, and whether it is in this turn's schema. Rows pin `on`/`off` or stay `auto`, so an extension that activates its own tools keeps doing so. Intent persists per session branch. |
| [`code-review`](pi/extensions/code-review) | A review workflow over uncommitted, committed, or branch changes, via `/review` and `/end-review`. Forked from [pi-review](https://github.com/earendil-works/pi-review). |
| [`hunk`](pi/extensions/hunk) | One `/hunk` command over a live [Hunk](https://www.hunk.dev) diff window: it reviews a changeset and leaves findings as inline notes, or collects the notes you left there and addresses them, replying on each line. Reuses the window you have open, and adopts Hunk's own agent skill so its CLI knowledge tracks the installed binary. |
| [`copilot-usage`](pi/extensions/copilot-usage) | Reports remaining GitHub Copilot premium requests through `/copilot-usage`, reusing pi's own Copilot OAuth token. |
| [`copilot-model-limits`](pi/extensions/copilot-model-limits) | Refreshes the context-window and max-output limits pi holds for Copilot models with the ones the Copilot API reports for your account. Limits only: which models you may use is pi's own job since 0.85. |

Each extension documents its own configuration in its README.

## Skills

`skills/` holds skills pi loads directly:

- `architectural-decision-records` — turn an architecture discussion into lightweight ADRs, and find the decisions nobody wrote down
- `creating-github-pull-requests` — open a pull request the way this repo expects
- `python-architecture-patterns` — patterns for designing, writing, and reviewing Python code

## Rules

`rules/` holds standards to point an agent at — `python-code-standards.md` and `python-tooling.md`. They are plain markdown, so any agent can read them.

## Development

Extensions are TypeScript, loaded by pi directly. Nothing compiles: `tsconfig.json` sets `noEmit`, and type checking is a separate step from running.

```bash
npm run typecheck    # tsc over every extension
npm test             # node --test over the colocated *.test.ts files
```

Tests use `node:test` and `node:assert/strict`, and live beside the code they cover. Extensions that talk to pi keep that surface in one entry module and put the logic behind injected functions, so the logic stays testable without a running pi.

Point pi at a single extension without installing it:

```bash
pi -e pi/extensions/session-title/index.ts
```
