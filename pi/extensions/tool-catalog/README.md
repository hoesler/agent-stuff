# tool-catalog

`/tools` answers "what tools does this session actually have, who gave them to
me, and which of them can the model call right now" — then lets you pin one on
or off from the same list.

```
Tool Catalog                                                    7 tools · 5 active
● = in this turn's tool schema

  Search: ▏

    init_experiment  pi-autoresearch  auto
  ● run_experiment   pi-autoresearch  auto
  ● bash             pi-tool-display  auto
  ● ls               pi-tool-display  on
→ ● read             pi-tool-display  auto
    web_search       pi-web           off
  ● subagent         subagent         auto

  Reads a file from the local filesystem.
  auto — active
  pi-tool-display · amp-themes · user
  ~/.pi/agent/git/github.com/hoesler/amp-themes/node_modules/pi-tool-display/index.ts

  Type to search · Enter/Space to change · Esc to cancel
```

## Registered is not active

pi keeps two sets. **Registered** tools are the ones it knows the schema and
implementation for; **active** tools are the subset in the model's tool schema
for this turn. Extensions register their tools once and then switch them in and
out — `pi-autoresearch` registers `init_experiment` and `run_experiment`
permanently but activates them only while an experiment is in play.

The list shows every registered tool. The `●` shows which are active right now,
read fresh from `getActiveTools()` each time the list renders. The right-hand
column is something else again: your intent.

| intent | meaning |
| --- | --- |
| `auto` | not your business — the tool stays wherever its extension left it |
| `on` | pinned into the schema |
| `off` | pinned out of it |

Enter or Space cycles the selected row through the three, applying immediately.
The two can disagree, and the catalog shows it rather than pretending a pin is a
guarantee: an extension is free to activate a tool you pinned `off`, in which
case the row carries both `●` and `off`.

## Why intent is stored, and not the tool list

`setActiveTools` **replaces** the active list. Anything that remembers a list
and writes it back later deactivates whatever another extension turned on in the
meantime — pin one tool, and `run_experiment` silently drops out of the schema.

So the catalog never writes a remembered list. It stores only your overrides,
and every write is computed from the live list: drop what you pinned `off`,
append what you pinned `on`, leave everything else untouched, and skip the call
entirely when that changes nothing. Setting a row back to `auto` releases it
without touching the current state — its extension takes over from there.

## Naming

The second column names the **extension** that registered the tool, not its
package: `sourceInfo.source` is a package spec (`git:github.com/owner/repo`) or
a checkout path, neither of which fits a column or reads as a name. The name
comes from the file that defines the tool — the directory for the usual
`<extension>/index.ts`, the filename for a single-file extension. pi's own tools
report `builtin`; SDK tools report `sdk`.

Selecting a row expands the tool's description, its state, then its attribution
— `extension · package · scope` — then the whole path to the defining file, with
only the home prefix collapsed to `~`. Relative paths would save room but cost
the answer: `node_modules/pi-tool-display` names the extension and says nothing
about which package it was nested in.

Rows are ordered builtin first, then SDK, then by extension name, so the tools
from one extension stay together. Search filters on the whole label, so a query
matches either a tool name or an extension: type `subagent` to see just that
extension's tools.

## Extensions that shadow pi's builtins

An extension registering a tool named `bash` or `ls` *replaces* pi's builtin of
that name — pi merges extension tools over `_baseToolDefinitions` by name, so
only one survives into the registry. The catalog reports whoever won, which is
why a package like `pi-tool-display`, which re-registers the core tools to
customize their rendering, appears as the source of `bash`, `edit`, `find`,
`grep`, `ls`, `read`, and `write`. Nothing is wrong; the shadowing is simply
visible now.

## Persistence

Overrides are appended to the session as `tool-catalog-overrides` entries rather
than written to a config file, so a fork or a walk through the session tree
restores the intent that was live on that branch. An override naming a tool that
is no longer registered is ignored, so removing an extension cannot resurrect
its tool name.

The earlier `tools-config` entries, which stored a snapshot of the whole active
list, are ignored rather than translated: as intent, that snapshot would read as
a pin on every tool in the session.

## Limits

`/tools` needs the TUI; in other modes it reports an error rather than printing
a listing. The expanded row shows the tool's description but not its parameter
schema or prompt guidelines. Pinning applies when you set it — nothing re-asserts
a pin later in the turn if an extension changes the active list afterwards.
