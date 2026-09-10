# copilot-model-limits

Refreshes the token limits pi holds for GitHub Copilot models with the ones the
Copilot API reports for the signed-in account.

pi's Copilot catalog is generated from models.dev, so its `contextWindow` and
`maxTokens` are whatever that catalog said when the release was cut. The Copilot
`/models` endpoint reports the account's real numbers. This extension registers a
`refreshModels` on the built-in `github-copilot` provider and folds them in, so a
long session is measured against the window the account actually has.

## Which numbers

`maxTokens` comes from `max_output_tokens`, and `contextWindow` from
**`max_prompt_tokens`** — not from the `max_context_window_tokens` that reads
like the obvious match.

pi spends `contextWindow` as an input budget and nothing else: it measures the
conversation against it, and compacts once past `contextWindow - reserveTokens`
(16384 by default). Copilot reports `max_context_window_tokens` as the total it
will accept across prompt and output, and enforces `max_prompt_tokens` on the
prompt alone. Handing pi the total buys a band where pi believes a request fits
and Copilot refuses it, and where compaction never comes:

    gpt-5.6-sol   max_context_window_tokens 1050000
                  max_prompt_tokens          922000   <- the one Copilot enforces
                  max_output_tokens          128000

Given the total, pi would have compacted at 1033616 against a prompt ceiling of
922000. Given the prompt ceiling, it compacts at 905616 and stays inside it.

The total is usually the sum of the two parts, but not always — `gpt-5-mini`
reports 264000 against 128000 + 64000 — so neither is derived from the other,
and a model that does not report both of the two limits keeps pi's own pair.

Nothing to configure. It uses the Copilot credential pi already holds; if you are
not signed in to Copilot it does nothing.

## Scope

Limits only.

Which models the account may use is pi's own job as of 0.85 — the built-in
Copilot provider filters its catalog by the account's available model ids, taken
from this same endpoint when the OAuth token is refreshed. This extension leaves
every model in place and never prunes the list.

## When it reads them

On every session start — startup, `/reload`, `/new`, a resume, a fork — and
whenever pi refreshes the catalog over the network itself.

It has to ask, rather than wait to be asked. Only one pass in pi 0.85 reads
models over the network on its own: the one interactive mode fires after
startup. Everything else is a cache-only pass — `registerProvider`,
`unregisterProvider`, the session bootstrap, and the credential sync after a
logout or an api-key change all call `refresh({ allowNetwork: false })` — and pi
rebuilds the composed provider at the top of each one, so a cache-only pass
leaves the models at the numbers pi ships. A `/reload` is the plain case: it
re-runs extension loading, which re-registers this provider, and nothing reads
the limits again for the rest of that session. `pi -p` never gets a network pass
at all.

Nothing is cached. The limits are read from Copilot when they are needed and
never written down, so there is no stored copy to go stale or to reconcile
against the account. What it costs is one request per session start.

## When it speaks up

Two cases are expected and stay quiet: pi's cache-only passes, and having no
Copilot OAuth credential. So is a cancelled request — pi supersedes the previous
pass for a provider whenever a new one starts, so an abort is routine and pi's
own to report.

Anything else — a refused request, an endpoint that cannot be reached, a catalog
with no readable limits — is both thrown and said out loud:

    copilot-model-limits: Copilot /models answered 401 Unauthorized. pi's own
    catalog values are showing and may not match your Copilot account.

Throwing alone is not enough. pi turns a throw into
`Could not refresh github-copilot; showing cached models.` in the model picker,
but the pass that actually reads the limits ends in `.catch(() => {})` and never
reads `result.errors`, so a Copilot account that could not be read would
otherwise sit there showing pi's numbers as if they were its own. The reason is
held until there is a UI to say it in, and the same reason is said once — a good
read clears it, and trouble that comes back is said again.

## Notes for the next person

A `refreshModels` return value is pi's new model list, not a suggestion. The
composer assigns it (`refreshedExtensionModels = refreshed`), and `refresh()`
rebuilds the composed provider at the top of every pass, so handing pi its own
catalog back on a cache-only pass is not the no-op it reads as: it overwrites
limits an earlier network pass had read with the numbers pi ships. That is why
the limits are re-read on session start rather than left to whichever pass ran
last.

A `refreshModels` has to hand the Copilot request headers back. pi rebuilds
every model an extension returns with `headers: undefined`, and the Copilot API
answers a request that arrives without `Editor-Version` with
`400 bad request: missing Editor-Version header for IDE auth`. The extension
registers a provider-level `headers`, copied off pi's own catalog, which pi
merges into the resolved auth for every request. Refreshing the limits and
leaving the headers behind makes every model it touched unusable.

Reach pi-ai only through the specifiers pi aliases for extensions
(`@earendil-works/pi-ai`, `/compat`, `/oauth`, `/providers/all`). Locating the
package by path — `import.meta.resolve("@earendil-works/pi-ai")` — does not
survive pi's bundled builds, where pi-ai exists only as an in-bundle virtual
module: the specifier resolves either to nothing or to whatever stale copy
happens to sit in the extension's `node_modules`.
