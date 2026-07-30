# session-title

Names pi sessions with a cheap, explicitly configured model, after the first
user↔assistant exchange settles.

## Configuration

No titling model configured means the extension does nothing — automatic titling
is opt-in and never spends tokens on your working model. Sources, lowest
precedence first:

1. `~/.pi/agent/session-title.json` (or `$PI_AGENT_DIR/session-title.json`)
2. `.pi/session-title.json` in a trusted project — merged over the global file
   per field
3. `$PI_SESSION_TITLE_CONFIG` — replaces both

```json
{
  "version": 1,
  "model": "copilot/gpt-5-mini",
  "thinkingLevel": "off",
  "enabled": true,
  "maxLength": 50,
  "debug": false
}
```

| field | default | meaning |
| --- | --- | --- |
| `version` | required | config format version; must be `1` |
| `model` | required | `provider/modelId` of the titling model |
| `thinkingLevel` | `"off"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `enabled` | `true` | automatic titling; `/title` works either way |
| `maxLength` | `50` | character cap; `0` means unlimited |
| `debug` | `false` | log titling decisions to stderr |

Unknown properties are rejected, so a typo fails loudly. Files are re-read when
they change — no restart needed.

## Commands

| command | effect |
| --- | --- |
| `/title` | generate a name from the current conversation; overrides a manual name |
| `/title status` | model, whether it resolves, enabled state, current name and its source |
| `/title doctor` | config paths, parse errors, model resolution and authentication |
| `/title on` / `/title off` | toggle automatic titling for this session only |

## Behavior

Automatic titling fires on `agent_settled` — after the first exchange has fully
settled, including any retry or compaction — so the title reflects both the ask
and the agent's reading of it, and lands while you are still reading the reply.
It runs at most once per session.

A name set with `/name`, or present when a session is resumed, is never
overwritten automatically; running `/title` is treated as an explicit override.
Naming state is persisted as `session-title-state` entries in the session, so the
distinction survives `/reload` and `/resume`.

There is no periodic re-titling, no model fallback chain, and no non-LLM fallback
name: a missing title is better than a misleading one.

## Attribution

Transcript extraction, the output quality gate, and the request-lifecycle
controller are ported in shape from
[pi-autoname](https://github.com/ssdiwu/pi-autoname) by ssdiwu (MIT).
