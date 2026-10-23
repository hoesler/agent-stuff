# pstack

Runs [pstack](https://github.com/cursor/plugins/tree/main/pstack), poteto's engineering skills for Cursor, in pi. Type `/poteto-mode <task>`: the agent picks one of pstack's playbooks (bug fix, feature, investigation, and so on), copies its steps into a checklist, reads the principle skills that apply, and delegates code work to subagents on a model chosen per role.

## Pieces

| Piece | Where | Owned by |
| --- | --- | --- |
| The skills, the two upstream personas, the guide, the README | `pi/pstack/` | Generated from upstream. Never edited by hand. |
| The adapter: what each Cursor name means in pi | [`pi/pstack/docs/harness/pi.md`](../../pstack/docs/harness/pi.md) | This repo. |
| `pstack-general` and `pstack-readonly`, stand-ins for Cursor's `generalPurpose` | `pi/pstack/docs/harness/agents/` | This repo. The generator copies them into `pi/pstack/agents/`. |
| This extension | `pi/extensions/pstack/` | This repo. |

The package does not list `pi/pstack/skills` in `pi.skills`, so pi registers none of the 57 skills: no `/skill:` commands, no catalog entries, and no collisions with your other skills. pstack does not need them registered. When one skill routes to another, the adapter has the agent read `<pstack>/skills/<name>/SKILL.md` by path. You run a skill with `/pstack <name>`.

## What the extension adds

- **`/poteto-mode <task>`**, **`/poteto-help <question>`**, and **`/setup-pstack`**, the same as `/pstack <name> …`. These three keep their own commands because upstream's docs name them and a newcomer needs them before knowing `/pstack`.
- **`/pstack <skill> [task]`** runs any pstack skill. It completes skill names, reads the skill's `SKILL.md`, and sends it the way pi's own `/skill:` expansion does.
- **The install path.** Every turn's system prompt says where `pi/pstack/` is. The adapter and the personas call it `<pstack>`. The path comes from the extension's own location, so it stays right when the package moves or updates, and a subagent child, which loads the same package, sees it too.
- **The role lines.** When `~/.pi/agent/pstack-models.md` exists, it is appended to every turn's system prompt, the way Cursor always applies `pstack-models.mdc`. Without it, the prompt says every role runs on the parent's model. The prompt also says that pstack's skills are absent from the skill list and where to read them, so a request like "configure pstack models" still finds `setup-pstack`.

## Setup

Run `/setup-pstack` once. It follows upstream's steps with the adapter's changes:

1. It detects models with `pi --list-models`. With [`agent-modes`](../agent-modes) configured, it also offers each mode, and writes the mode's `provider/model:thinkingLevel`, never its id.
2. With no role file yet, it asks for a judgment model and a code model and fills upstream's default table with them: the judgment pick where upstream has Claude Opus, the code pick where it has Grok.
3. The budget sets each value's `:thinkingLevel`. It warns when a panel (arena, architect, interrogate) has only one model family.
4. It writes `~/.pi/agent/pstack-models.md` and copies the four personas (`poteto-agent`, `comment-sicko`, `pstack-general`, `pstack-readonly`) into `~/.pi/agent/agents/`, showing the diff before it overwrites one you changed.

Run `/reload` afterwards so the subagent catalog lists the personas.

## Optional companions

pstack runs with none of these. Each makes a step better when it is active, and the adapter says what to do without it.

| Capability | Example | Without it |
| --- | --- | --- |
| Subagents with a persona and a model | [`subagent`](../subagent) | Steps run inline. |
| Structured questions | `@juicesharp/rpiv-ask-user-question` | Questions in plain text. |
| A todo list | `todo` from `mitsuhiko/agent-stuff` | The checklist lives in the reply. |
| Named models | [`agent-modes`](../agent-modes) | Setup offers `pi --list-models` only. |
| Past sessions | [`session-search`](../session-search) | The agent reads session JSONL directly. |

Cursor Automations, Bugbot, and cloud agents have no pi equivalent. Steps that need them print `Skipped in pi: <step>. <reason>.` and the run goes on.

## Updating from upstream

```bash
npm run pstack                     # main
npm run pstack -- --ref <sha>      # a specific commit
npm run pstack -- --check          # fail if pi/pstack differs from what main generates
```

The generator sparse-clones `cursor/plugins`, rewrites everything in `pi/pstack/` except `docs/harness/`, and records the commit in `pi/pstack/UPSTREAM`. For each skill it scans for Cursor names, using upstream's own term list plus the ones pi lacks, and puts one line under the skill's heading that points at the adapter and names the sections that apply. A relative link to a file the tree leaves out, such as `automations/`, becomes a GitHub link at the recorded commit. It refuses to write when a Cursor name has no row in the adapter or a link points at nothing. `--source <checkout>` uses a local clone instead of fetching.

Commit the result. `npm test` checks the committed tree offline: no broken relative link, every skill that uses a Cursor name has the right pointer, and the adapter covers every term.
