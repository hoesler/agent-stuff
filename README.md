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
| [`model-modes`](pi/extensions/model-modes) | Bundles a provider, model, and thinking level into one named mode. `/mode` selects one, a shortcut cycles them, and a configured default applies at startup. |
| [`subagent`](pi/extensions/subagent) | Delegates a task to a subagent running in its own `pi` process and context window. Single, parallel, and chained modes, with personas discovered from `agents/` directories. |
| [`session-title`](pi/extensions/session-title) | Names a session from its first exchange using a cheap, explicitly configured model. `/title` re-titles on demand. |
| [`code-review`](pi/extensions/code-review) | A review workflow over uncommitted, committed, or branch changes, via `/review` and `/end-review`. Forked from [pi-review](https://github.com/earendil-works/pi-review). |
| [`copilot-usage`](pi/extensions/copilot-usage) | Reports remaining GitHub Copilot premium requests through `/copilot-usage`, reusing pi's own Copilot OAuth token. |
| [`copilot-model-limits`](pi/extensions/copilot-model-limits) | Corrects the context-window and max-output limits pi ships for Copilot models by reading them from the Copilot API at startup. A stopgap until [pi#2527](https://github.com/earendil-works/pi/pull/2527) ships. |

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
