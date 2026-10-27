# pstack for pi

## Goal

Make [pstack](https://github.com/cursor/plugins/tree/main/pstack) usable in pi,
starting with typing `/poteto-mode <task>`.

pstack is poteto's set of engineering skills for Cursor. `/poteto-mode` reads a
request, picks one of twenty-three playbooks (bug fix, feature, investigation,
and so on), copies its steps into a checklist, reads the principle skills that
apply, and delegates code work to subagents on models chosen per role.

The port tracks upstream. When poteto changes pstack, re-running one script
brings the change in. Nothing upstream is edited by hand. Everything
pi-specific lives in an adapter document and a small extension, both owned by
this repo.

## What pstack is

pstack is almost entirely Markdown:

- `skills/`: 57 skills. 56 set `disable-model-invocation: true`; only
  `setup-pstack` is model-visible. Skills link each other relatively
  (`../<name>/SKILL.md`), and `poteto-mode` carries `playbooks/`,
  `references/`, and `scripts/`.
- `agents/`: two personas, `poteto-agent` (the delegate for every code-writing
  spawn inside a playbook) and `comment-sicko`.
- `docs/guide/`, `README.md`, `LICENSE`, plugin manifests.
- `automations/benny/`: Cursor Automations. Out of scope.

Upstream already ports pstack to Claude Code without touching the skills.
`scripts/generate-pstack-harness-trees.mjs` in `cursor/plugins` copies the
skills, agents, guide, and README into `harness/pstack/claude-code/`, scans each
skill for Cursor-specific terms (a fixed regex list: `Task`, `AskQuestion`,
`todolist`, `generalPurpose`, `readonly: true`, model slugs,
`pstack-models.mdc`, `.cursor/...` paths, Bugbot and cloud agents, and bare
references to sibling skills), and prepends a short pointer to an adapter doc,
`pstack/docs/harness/claude-code.md`, to every skill that uses one. The adapter
doc is a set of mapping tables: "Cursor term → what to do here". This port is
the same move for pi, and the builder should read both files before starting.

## Principle: name the capability, not the extension

The adapter describes what a step needs and how to recognise a tool that
provides it. It never makes pstack depend on a specific third-party extension.
Where a tool is absent, there is a stated fallback that still works.

| Cursor term | pi adapter says |
| --- | --- |
| `AskQuestion` | Use a structured-question tool if one is active (for example `ask_user_question` from `@juicesharp/rpiv-ask-user-question`: 1–4 questions, 2–4 options each, free-text answer). Otherwise ask in plain text with the same options listed. |
| todolist | Use a todo tool if one is active (for example `todo` from `mitsuhiko/agent-stuff`). Otherwise keep the checklist in the reply and update it as steps finish. |
| `Task` / subagent fields | Use a subagent tool that takes a persona and a model, such as this repo's `subagent`. Map `readonly`, `environment`, `run_in_background`, `resume`, `file_attachments` the way the Claude Code adapter does, adjusted to what pi's tool offers. With no subagent tool, run the step inline and say so. |
| `subagent_type: poteto-agent` / `comment-sicko` / `generalPurpose` | The persona of that name. `generalPurpose` maps to `pstack-general`, and `generalPurpose` with `readonly: true` maps to `pstack-readonly` (see Personas). `subagent` requires a persona on every call and takes a tool allowlist only from persona frontmatter, so both are needed. |
| Model slugs, `inherit-parent`, `auto` | The role's configured value (see Models). `inherit-parent`/`auto` mean omit `model`. |
| `pstack-models.mdc` | The pi role file (see Models). |
| `.cursor/skills`, `.cursor/rules`, plugin paths | pi's equivalents: `.pi/skills`, `AGENTS.md`, the installed package path. |
| Cursor transcripts | pi session JSONL under `~/.pi/agent/sessions/`. A session-search tool may be used where present. |
| Bugbot, Automations, cloud agents, built-in PR tool | Same rule as the Claude Code adapter: one line `Skipped in pi: <step>. <reason>.`, then continue. PR steps use `gh`. |
| Routing to another pstack skill | Read `<pstack>/skills/<name>/SKILL.md` and follow it. Tell the user `/skill:<name>`. |

The builder should derive the full term list from upstream's generator and
check every term against pi rather than copying the Claude Code answers.

## Models

pstack assigns a model per **role**: one line per role, 17 in total, in the
shape `setup-pstack` step 5 shows (`feature, refactoring: …`,
`judgment and prose: …`, `swarm workers: …`, panel roles with lists, and so on).
A role is not a prompt; it only picks the model for one kind of spawn. Upstream
skills read these lines by name, so the port keeps the role names unchanged and
only changes where the lines live and what a value may be.

- **Where.** A plain Markdown file, `~/.pi/agent/pstack-models.md`, same body as
  upstream's rule minus the frontmatter. The extension appends it to the system
  prompt each turn when it exists, which is what Cursor's always-applied rule
  does.
- **Values.** Anything the subagent tool's `model` accepts: a
  `provider/model[:thinkingLevel]` reference or a route key, plus
  `inherit-parent`/`auto`. Effort adjustment ("raise one step for the hardest
  work") becomes changing the `:thinkingLevel` suffix.
- **Setup.** `/setup-pstack` follows upstream's steps with the adapter's
  changes: detect models from what pi can list; if `agent-modes` is installed,
  offer the configured modes as choices and write each chosen mode's model
  string into the line. Mode ids are never written, so the file does not depend
  on `agent-modes`.
- **Starting table** (my call). Upstream's defaults use two families: a strong
  judgment model (`claude-opus-*`) and a fast code model (`grok-*`). Setup in pi
  asks for those two picks first, a judgment model and a code model, preferring
  different families, from the detected models (or agent-modes modes). It then
  fills every role from upstream's default table, putting the judgment pick
  where upstream has opus and the code pick where it has grok. Panels get one
  entry each. The budget step then changes the `:thinkingLevel` of these real
  values as upstream changes effort. After that the user can change individual
  roles, as upstream allows.
- **No role file.** The adapter tells the agent to use `inherit-parent` for
  every role and to say so once, rather than guess a provider string.

Panels (arena, architect, interrogate) exist to compare model families. The
adapter keeps upstream's instruction to keep panels diverse. Setup warns when
every entry in a panel line is the same family. **Family** means the model id
with the provider and the version or size removed, for example `claude`, `gpt`,
`gemini`, or `grok`. So `anthropic/claude-opus-5-5` and
`github-copilot/claude-sonnet-5` count as the same family (my call).

## Personas

`poteto-agent` and `comment-sicko` need to exist as pi subagent personas. The
`subagent` extension discovers personas only from `~/.pi/agent/agents/` and
trusted `.pi/agents/`, and its README is explicit that every persona is a file
the user owns.

My call: `/setup-pstack` gains a pi step that writes four personas into
`~/.pi/agent/agents/`. If a file changed locally, setup shows the diff before
overwriting it on a re-run.

- `poteto-agent` and `comment-sicko` are the generated, adapted copies of
  upstream's `agents/*.md`. Their frontmatter is translated to the subagent
  format: `name` and `description`, with no `model`.
- `pstack-general` stands in for Cursor's `generalPurpose`. It is a short,
  neutral body with no tool allowlist.
- `pstack-readonly` stands in for `generalPurpose` with `readonly: true`. It has
  the same body and a `tools:` allowlist without `edit` or `write`.

The `pstack-` prefix avoids clashing with personas the user already has. These
two do not fall back to `poteto-agent`, because upstream warns that its
preamble causes drift outside playbook delegation. Neither persona sets a
model, since the role lines decide that per call.

Personas do not contain the install path. Upstream's `poteto-agent` searches
`~/.cursor/plugins/` for `poteto-mode/SKILL.md`. The pi copy instead reads the
path that the extension adds to every prompt (see Extension). A child `pi`
loads the same package, so it gets that line too. This stays correct when the
package moves or updates.

All of this needs no change to `subagent` and no new contract.

## Layout and generator

```
scripts/generate-pstack.mjs        # the generator, run by hand
pi/pstack/
  UPSTREAM                         # source repo, commit SHA, date
  README.md, LICENSE, docs/guide/  # copied
  docs/harness/pi.md               # the adapter doc, hand-written, NOT generated
  skills/<57 skills>               # copied, with the pi pointer prepended where needed
  agents/poteto-agent.md, comment-sicko.md
pi/extensions/pstack/              # the extension (below)
```

The adapter doc lives outside the generated paths, or the generator explicitly
preserves it; either is fine as long as a regeneration cannot delete it.

The generator:

1. Fetches `cursor/plugins` at a ref (default `main`, overridable) with a sparse
   clone of `pstack/` into a temp directory, and records the resolved SHA in
   `UPSTREAM`.
2. Deletes and rewrites the generated parts of `pi/pstack/`.
3. For each skill, scans for Cursor terms (same idea as upstream's `TERMS`
   list, extended where pi differs) and prepends a short note pointing at
   `docs/harness/pi.md` and naming which sections apply, the way upstream's
   Claude Code tree does.
4. Rewrites relative links that point at files the tree leaves out to GitHub
   URLs at the recorded SHA.
5. Is idempotent: running it twice at the same SHA produces no diff.

The generated tree is committed, so installing the package needs no network.

`package.json` adds `./pi/pstack/skills` to `pi.skills`. The cost per session is
one catalog entry (`setup-pstack`), because the rest are hidden.

## Extension: `pi/extensions/pstack`

Kept small. It:

- registers `/poteto-mode <task>` as a command equivalent to
  `/skill:poteto-mode <task>`, since that is what the user wants to type.
  Whether pi expands `/skill:` in a message sent by an extension is unverified;
  if not, the command loads the SKILL.md and sends it the way pi's own skill
  expansion does;
- appends `~/.pi/agent/pstack-models.md` to the system prompt when it exists;
- adds one line to the system prompt with the absolute path of the installed
  `pi/pstack/`, resolved from the extension's own location at load time. The
  adapter's `<pstack>` and the personas use it. The package installs through
  `pi install git:…` or a local path, and both keep the extension and the tree
  side by side, so the path is never stored.

It imports only from its own directory, like every other extension here.

## Non-goals

- Editing upstream skill text. All differences go in the adapter doc or the
  prepended note.
- Benny and anything else needing Cursor Automations, Bugbot, or cloud agents.
- Making the Cursor-heavy playbooks (autopilot, orchestrate, babysit with
  Bugbot) fully work. They ship and degrade via the skip rule.
- Requiring `agent-modes`, `rpiv-ask-user-question`, mitsuhiko's `todos`, or
  even `subagent`. Each improves the experience when present.

## Anti-goals

- A hard dependency on any one extension, including this repo's.
- A fork that drifts: if re-running the generator against new upstream needs
  manual merging, the design has failed.
- Writing files into the user's repos (for example `.pi/todos`) because pstack
  ran, unless a tool the user installed does that by its own choice.

## Verification

- Generator: running it twice is a no-op; every skill that matches a Cursor term
  has the pointer; no relative link in the tree is broken (a small check script,
  run in `npm test`).
- Extension: unit tests for the command and prompt injection, in the repo's
  `node:test` style with pi behind injected functions.
- End to end: in pi, `/setup-pstack` writes the role file and personas;
  `/poteto-mode <small real task>` picks a playbook, keeps a checklist, reads a
  principle skill, and dispatches a `poteto-agent` subagent on the configured
  code model.

## Left to the builder

- The exact wording of the adapter doc and the prepended note.
- Whether the generator is `.mjs` or `.ts` run by node.
- How setup detects available models in pi.
- Whether skill-name collisions with other installed packages (pstack ships
  `tdd`, `technical-writing`, and others) need handling beyond what pi already
  reports.
