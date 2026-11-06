# pstack

Runs [pstack](https://github.com/cursor/plugins/tree/main/pstack), poteto's engineering skills for Cursor, in pi. Type `/poteto-mode <task>`: the agent picks one of pstack's playbooks (bug fix, feature, investigation, and so on), copies its steps into a checklist, reads the principle skills that apply, and delegates code work to subagents on a model chosen per role.

## Pieces

| Piece | Where | Owned by |
| --- | --- | --- |
| The skills, the two upstream personas, the guide, the README | `pstack/` | Generated from upstream by `npm install`, not committed. Never edited by hand. |
| The adapter: what each Cursor name means in pi | [`pstack/docs/harness/pi.md`](pstack/docs/harness/pi.md) | This repo. |
| `pstack-general` and `pstack-readonly`, stand-ins for Cursor's `generalPurpose` | `pstack/docs/harness/agents/` | This repo. The generator copies them into `pstack/agents/`. |
| This extension | `pi/extensions/pstack/` | This repo. |

The package does not list `pstack/skills` in `pi.skills`, so pi registers none of the 57 skills: no `/skill:` commands, no catalog entries, and no collisions with your other skills. pstack does not need them registered. When one skill routes to another, the adapter has the agent read `<pstack>/skills/<name>/SKILL.md` by path. You run a skill with `/pstack <name>`.

## What the extension adds

- **`/poteto-mode <task>`**, **`/poteto-help <question>`**, and **`/setup-pstack`**, the same as `/pstack <name> …`. These three keep their own commands because upstream's docs name them and a newcomer needs them before knowing `/pstack`.
- **`/pstack <skill> [task]`** runs any pstack skill. It completes skill names, reads the skill's `SKILL.md`, and sends it the way pi's own `/skill:` expansion does.
- **The install path.** Every turn's system prompt says where `pstack/` is. The adapter and the personas call it `<pstack>`. The path comes from the extension's own location, so it stays right when the package moves or updates, and a subagent child, which loads the same package, sees it too.
- **Where the skills are.** The prompt also says that pstack's skills are absent from the skill list and where to read them, so a request like "set up pstack" still finds `setup-pstack`.

## Models

pstack sets a model on every subagent it spawns, chosen by role. Upstream keeps those choices in a Cursor rule, `pstack-models.mdc`. The pi port keeps none. The orchestrating agent picks a mode for each spawn from the [`agent-modes`](../agent-modes) list in its system prompt, judging by the role and the job, and uses the `oracle` route where pstack asks for a model family other than its own: one seat of each panel, the arena cross-judge, and show-me-your-work's reviewer. The adapter's Models section has the role table.

Nothing couples the extensions. pstack reads the mode list as text, and passes `oracle` to `subagent` as a route key, which `subagent` resolves through the contract `agent-modes` publishes. Without a mode list every subagent runs on the parent's model. Without an `oracle` route, panels stay on one family and the agent says so.

## Setup

Run `/setup-pstack` once. In pi it replaces upstream's model steps:

1. It checks that your modes can serve pstack's roles, and names the gaps: nothing cheap enough for code delegates, nothing strong enough for judgment, or only one model family. To change what a mode or route means, edit your agent-modes config. Without a mode list, it says how to turn one on (`"exposeCatalogInSystemPrompt": true`, or `/mode init` to draft a config).
2. It says when `oracle` is missing.
3. It copies the four personas (`poteto-agent`, `comment-sicko`, `pstack-general`, `pstack-readonly`) into `~/.pi/agent/agents/`, showing the diff before it overwrites one you changed.

It never writes agent-modes config. Run `/reload` afterwards so the subagent catalog lists the personas.

There is no reasoning budget. To spend less, run the main chat on a cheaper mode with `/mode`, keep only modes you are willing to pay for in the list, or ask for cheaper subagents in the task.

## Optional companions

pstack runs with none of these. Each makes a step better when it is active, and the adapter says what to do without it.

| Capability | Example | Without it |
| --- | --- | --- |
| Subagents with a persona and a model | [`subagent`](../subagent) | Steps run inline. |
| Structured questions | `@juicesharp/rpiv-ask-user-question` | Questions in plain text. |
| A todo list | `todo` from `mitsuhiko/agent-stuff` | The checklist lives in the reply. |
| Agent modes and the `oracle` route | [`agent-modes`](../agent-modes) | Subagents run on the parent's model. Panels stay on one family. |
| Past sessions | [`session-search`](../session-search) | The agent reads session JSONL directly. |

Cursor Automations, Bugbot, and cloud agents have no pi equivalent. Steps that need them print `Skipped in pi: <step>. <reason>.` and the run goes on.

## Updating from upstream

Only `pstack/UPSTREAM` and `pstack/docs/harness/` are committed. `npm install`, which pi runs when it installs or updates the package, generates the rest from the commit `UPSTREAM` pins. Installing therefore needs network access to GitHub. A local-path install (`pi install ./agent-stuff`) never runs npm, so run `npm install` in the checkout once.

```bash
npm run pstack                     # regenerate from the pinned commit
npm run pstack -- --ref main       # move the pin to upstream main
npm run pstack -- --ref <sha>      # move the pin to a specific commit
npm run pstack -- --check          # fail if pstack/ differs from what the pinned commit generates
```

The generator, `generate.mjs`, sparse-clones `cursor/plugins`, rewrites everything in `pstack/` except `docs/harness/`, and records the commit in `pstack/UPSTREAM`. For each skill it scans for Cursor names, using upstream's own term list plus the ones pi lacks, and puts one line under the skill's heading that points at the adapter and names the sections that apply. A relative link to a file the tree leaves out, such as `automations/`, becomes a GitHub link at the recorded commit. It refuses to write when a Cursor name has no row in the adapter or a link points at nothing. `--source <checkout>` uses a local clone instead of fetching.

To bump, run `npm run pstack -- --ref main`, review upstream's changes with `https://github.com/cursor/plugins/compare/<old>...<new>` (path `pstack/`), and commit `UPSTREAM` with any adapter changes. `npm test` checks the generated tree: no broken relative link, every skill that uses a Cursor name has the right pointer, and the adapter covers every term.
