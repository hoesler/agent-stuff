# pstack in pi

pstack skills use Cursor names. In pi, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds `skills/` and `docs/`. The pstack section of your system prompt gives its absolute path. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

This file names capabilities, not extensions. Where a row says "a todo tool" or "a subagent tool", use whichever active tool does that job, and use the fallback when none does. The tool names given as examples are ones known to fit.

## Tools

| Cursor | pi |
| --- | --- |
| `AskQuestion` | A structured-question tool if one is active, such as `ask_user_question` from `@juicesharp/rpiv-ask-user-question` (1 to 4 questions, 2 to 4 options each, free-text answer always allowed). Otherwise ask in plain text, list the same options, and stop for the answer. |
| Open a todolist | A todo tool if one is active, such as `todo` from `mitsuhiko/agent-stuff`. Otherwise keep the checklist in your reply, as a Markdown task list, and repeat it with updated marks whenever a step finishes. Never write a todo file into the user's repo yourself. |
| Run another pstack skill (`/name` or "the **name** skill") | `read` `<pstack>/skills/<name>/SKILL.md` and follow it. Relative paths inside it resolve against its own folder. pi does not load pstack's skills, so none of them is in the skill list and a missing catalog entry does not mean the skill is absent. When you tell the user to type it, write `/pstack <name>`, or `/poteto-mode`, `/poteto-help`, or `/setup-pstack` for those three. |
| `Grep`, `Glob`, `Read` | `grep`, `find`, and `read` when the session offers them. Otherwise `bash` with `rg`, `fd` or `find`, and `cat`/`sed -n`. |
| `Shell` | `bash`. |

## Subagents

pstack's `Task` spawns map to a subagent tool that takes a persona and a model, such as `subagent` from this package. With no subagent tool, do the step inline, say so in one line, and keep going.

`subagent` runs each persona as a child `pi` process. It requires `agent` on every call, takes `task` and an optional `model`, and runs up to 8 tasks per call through `tasks` (parallel) or `chain` (sequential). It takes a tool allowlist only from the persona's frontmatter, which is why `readonly` maps to a persona below. `/setup-pstack` installs the four personas this table names.

| Cursor | pi |
| --- | --- |
| `Task` | `subagent`. One spawn is `{ agent, task, model }`. Several independent spawns go in one call as `tasks: [...]`. |
| `subagent_type: "poteto-agent"`, `poteto-agent` | `agent: "poteto-agent"`. Put `<pstack>/skills/poteto-mode/SKILL.md`, as an absolute path, in the task. |
| `comment-sicko` | `agent: "comment-sicko"`. |
| `subagent_type: generalPurpose` | `agent: "pstack-general"`. |
| `generalPurpose` with `readonly: true` | `agent: "pstack-readonly"`. Its persona has no `edit` or `write` tool. It keeps `bash`, so check `git status` afterward. |
| `readonly: true` on `poteto-agent` or another persona | Keep the persona, add "do not edit files" to the task, and check `git status` afterward. |
| `readonly: false` | Omit. |
| `environment: "cloud"` | Create a git worktree (`git worktree add`), name the branch or commit it checks out, and pass its path as `cwd`. |
| `environment: "local"` | Omit. |
| `cloud_base_branch: <b>` | Create the worktree from `<b>`. |
| `run_in_background: true` | Omit. A `subagent` call returns when its children finish. To run spawns side by side, put them in one `tasks` call. |
| `resume` | Spawn a fresh agent and paste the earlier result, branch, and worktree path into its task. |
| `file_attachments` | List the absolute paths in the task. |
| A persona the catalog does not list | `/setup-pstack` has not installed it. Run the step on `pstack-general` if that exists, else inline, and say so. |

## Models

pstack picks a model per role, such as `feature, refactoring` or `judgment and prose`. The role lines live in `~/.pi/agent/pstack-models.md`, the pi replacement for `pstack-models.mdc`. The pstack extension appends that file to the system prompt each turn, so its role lines are already in context. If they are not, read the file.

| Cursor | pi |
| --- | --- |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc` | `~/.pi/agent/pstack-models.md`. Plain Markdown, no frontmatter, same role lines. |
| A role value | Pass it as `model` unchanged. It is a `provider/model[:thinkingLevel]` reference or a route key. |
| `inherit-parent` or `auto` | Omit `model`, so the child runs on pi's default model. |
| A default slug in a skill (`claude-` or `grok-` or `gpt-` followed by a version) | Use the role's line. With no role file, or no line for that role, omit `model` for every role and say so once. Never turn a Cursor slug into a provider string by guessing. |
| Raise or lower the effort | Change the `:thinkingLevel` suffix on the ladder `off` < `minimal` < `low` < `medium` < `high` < `xhigh` < `max`. Add the suffix when the value has none. pi clamps a level the model does not support. A route key has no suffix to change, so keep it as it is. |
| `-fast` | Drop it. pi has no speed variant. |
| A diverse panel (arena runners, architect runners, interrogate reviewers, arena cross-judge pool) | One spawn per entry, each with that entry as `model`. The family of a model is its id without the provider and without the version or size, so `anthropic/claude-opus-5-5` and `github-copilot/claude-sonnet-5` are both `claude`. Keep panels diverse by family. |

## setup-pstack

Follow the skill's steps with these changes.

- **Detect.** Run `pi --list-models` with `bash` and take each `provider/model` pair it prints. A model whose `thinking` column says `yes` takes a `:thinkingLevel` suffix. If `~/.pi/agent/agent-modes.json` exists (or the file `PI_AGENT_MODES_CONFIG` names), read its `modes` and offer each one as a choice labelled with its `id`, whose value is `<provider>/<model>:<thinkingLevel>`. Never write a mode id into the role file. If nothing can be detected, ask the user to paste the models they use.
- **Starting table.** With no role file, ask for two picks first: a judgment model and a code model, preferably from different families. Fill every role from step 5's shape, putting the judgment pick where it shows `claude-opus-5-5-xhigh` and the code pick where it shows `grok-4.7-xhigh-fast`. A panel line gets one entry for each. Then apply the budget.
- **Budget.** The budget sets each real value's `:thinkingLevel`: `unlimited` is `max`, `large` is `xhigh`, `medium` is `high`, `small` is `medium`. A model without thinking gets no suffix. Route keys, `inherit-parent`, and `auto` do not change.
- **Confirm.** When every entry in a panel line has the same family, say so and offer to change one entry.
- **Validate.** Every `provider/model` written must be one that step 1 detected. A route key passes when the user typed it.
- **Write.** Write `~/.pi/agent/pstack-models.md` with no frontmatter: the comment lines, the `# budget` line, and one line per role from step 5. Overwrite the whole file. Never put the role lines in `AGENTS.md`. The file applies from the next turn, not only to new sessions.
- **Personas.** After the role file, copy every file in `<pstack>/agents/` to `~/.pi/agent/agents/`. When a file of that name already exists and differs, show the diff and ask before overwriting it. Skip files that are already identical. Then tell the user to run `/reload`, or start a new session, so the subagent catalog lists them.

## Paths

| Cursor | pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/`, `~/.pi/agent/skills/`. pi also reads `.agents/skills/` and `~/.agents/skills/`. |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | `<pstack>`, the installed package path from the system prompt. Never search for pstack on disk. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` in the repo, or `~/.pi/agent/AGENTS.md` for every project. pi never reads `.mdc` files. The model rule is the exception. See Models. |
| `.cursor/worktrees/` | Any worktree folder the repo already uses. Otherwise a sibling of the repo. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. The package ships the skills, `docs/guide/`, and `README.md`. Read the local copy and never fetch it. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | pi sessions are `<timestamp>_<session-id>.jsonl` files under `~/.pi/agent/sessions/--<path>--/`, one folder per working directory. `<path>` is the workspace path without its leading `/`, with each `/` changed to `-`, so `/Users/you/proj` is `--Users-you-proj--`. The newest file in this workspace's folder is the current session. Subagent children run with `--no-session` and leave no transcript. A session-search tool, such as `session_search` and `session_read`, finds and reads past sessions without opening the files. Read only this workspace's sessions unless the user asks. |

## Skills outside pstack

Some steps name skills that ship with Cursor or another Cursor plugin. Use a pi skill or tool with the same job when one is active. Otherwise put one line in your reply, `Skipped in pi: <step>. <reason>.`, and go on.

| Cursor | pi |
| --- | --- |
| `cursor-team-kit`: `deslop`, `control-cli`, `control-ui` | Use an installed skill of that name. Otherwise, for `deslop`, review your own diff with the **unslop** and **no-comments** skills. For `control-cli` and `control-ui`, drive the CLI with `bash` (or a terminal tool such as tmux) and the UI with a browser tool if one is active, and skip with the line if not. |
| `create-skill` | Follow pi's `docs/skills.md` from the pi documentation the system prompt names, plus the Authoring a skill playbook. |
| `/loop` | pi has no built-in loop. Keep working in this turn toward the predicate. When a step arms `/loop` for later ticks, use a scheduling or loop tool if one is active. Otherwise skip with the line and tell the user the predicate to re-run by hand. |

## Cursor-only features

pi has no Cursor Automations, Bugbot, Cursor cloud agents, or built-in PR tool. When a step needs one, put one line in your reply, `Skipped in pi: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, such as a URL or a key, leave a placeholder and name it in the line.

| Cursor | pi |
| --- | --- |
| Cursor Automations: routines, `update_state` routine calls, `api2.cursor.sh/automations` webhooks, routine wakes, and `SendToUser` secret requests | Skip with the line. |
| Bugbot | Bugbot comments on a GitHub PR are ordinary review threads, so triage them with the forge command that the step gives. Skip a step that starts, waits for, or configures Bugbot when the PR has no Bugbot check or comment. |
| Cursor cloud agents | `environment: "cloud"` maps to a worktree, as in Subagents. Skip a step that needs the cloud agent itself, such as its dashboard status or its own machine. |
| A built-in PR tool | Use the forge command that the step gives, such as `gh pr create`. That is not a skip, so write no line. |
| A Cursor restart | A pi restart or `/reload`. |
