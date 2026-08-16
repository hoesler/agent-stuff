# tool-catalog

`/tools` answers "what tools does this session actually have, and who gave them
to me" — then lets you switch one off without leaving the list.

```
Tool Catalog                                              15 tools · 14 enabled

  Search: ▏

  todo                pi-todo          [x]
  bash                pi-tool-display  [x]
  ls                  pi-tool-display  [x]
→ write               pi-tool-display  [x]
  web_search          pi-web           [ ]
  session_search      session-search   [x]
  subagent            subagent         [x]

  Writes a file to the local filesystem, overwriting if one exists.
  pi-tool-display · amp-themes · user
  ~/.pi/agent/git/github.com/hoesler/amp-themes/node_modules/pi-tool-display/index.ts

  Type to search · Enter/Space to change · Esc to cancel
```

The second column names the **extension** that registered the tool, not its
package: `sourceInfo.source` is a package spec (`git:github.com/owner/repo`) or
a checkout path, neither of which fits a column or reads as a name. The name
comes from the file that defines the tool — the directory for the usual
`<extension>/index.ts`, the filename for a single-file extension. pi's own tools
report `builtin`; SDK tools report `sdk`.

Selecting a row expands the tool's description, then its attribution —
`extension · package · scope` — then the whole path to the defining file, with
only the home prefix collapsed to `~`. Relative paths would save room but cost
the answer: `node_modules/pi-tool-display` names the extension and says nothing
about which package it was nested in.

Rows are ordered builtin first, then SDK, then by extension name, so the tools
from one extension stay together. Search filters on the whole label, so a query
matches either a tool name or an extension: type `subagent` to see just that
extension's tools.

Enter or Space toggles the checkbox on the selected row and applies it
immediately — there is no separate save step.

## Extensions that shadow pi's builtins

An extension registering a tool named `bash` or `ls` *replaces* pi's builtin of
that name — pi merges extension tools over `_baseToolDefinitions` by name, so
only one survives into the registry. The catalog reports whoever won, which is
why a package like `pi-tool-display`, which re-registers the core tools to
customize their rendering, appears as the source of `bash`, `edit`, `find`,
`grep`, `ls`, `read`, and `write`. Nothing is wrong; the shadowing is simply
visible now.

## Persistence

Selections are appended to the session as `tools-config` entries rather than
written to a config file, so a fork or a walk through the session tree restores
the selection that was live on that branch. A saved selection is filtered
against the tools that still exist, so removing an extension cannot resurrect
its tool name.

With no selection saved on the branch, the session's own active set is adopted
as-is and deliberately not rewritten — an extension that manages its own tool's
availability (as `subagent` does) keeps control of it.

## Limits

`/tools` needs the TUI; in other modes it reports an error rather than printing
a listing. The expanded row shows the tool's description but not its parameter
schema or prompt guidelines.
