# ADR-001: Register a tool only when a CLI cannot do the job

**Status:** Accepted

## Context

Every active tool's name, description and parameter schema go out with every request, whether or not the agent ever calls it. A skill costs one line of the system prompt until it is read, and a CLI behind it costs nothing until it runs. Several extensions here registered tools by default, and one of them (`session-search`) had grown machinery to hide its second tool until it could be called, only to cut that resting cost.

## Decision

An extension gives the agent a capability as a skill plus a CLI it runs through `bash`, and registers a tool only when at least one of these holds:

1. **The agent must not be able to bypass it.** A confirmation or trust check that is not a parameter. Through `bash`, the agent can run anything with any arguments.
2. **The schema must constrain the call.** A closed enum turns an invented value into a validation failure instead of a runtime error.
3. **It needs the running pi process.** Model registry, `agent-modes` routes, the abort signal, streamed progress, UI confirmation or custom rendering.
4. **It must appear only while it can work.** Active-tool membership can follow state that changes within a session; a skill's description is always there.

Applied to the current tools:

| Tool | Holds | Outcome |
| --- | --- | --- |
| `subagent` | 1, 2, 3, 4 | Stays a tool |
| `oracle` | 3, 4 | Stays a tool |
| `session_search`, `session_read` | none | Become `session-search` CLI plus a skill |

## Consequences

**Positive:**
- Sessions that never use a capability pay nothing for it beyond one skill line.
- A CLI works from other harnesses and from your own shell, and tests without pi.
- No code to defer or re-activate tools to save context.

**Negative:**
- The agent has to quote arguments for the shell, which is error-prone for query languages such as FTS5.
- Discovery depends on a skill description being recalled at the right moment, rather than on a tool description that is always in view.
- A CLI sees only what pi passes to `bash` (`PI_SESSION_FILE`, `PI_SESSION_ID`, the working directory). Session-scoped state, such as a "trust for this session only" decision, is invisible to it.

**Risks:**
- The agent may forget a skill-backed capability exists. Watch for sessions where it should have searched past conversations and did not. If that keeps happening, sharpen the skill description before reverting to a tool.
- Sandboxes such as nono apply to the `bash` child. A CLI that writes state (an index, a cache) needs that path allowed.
