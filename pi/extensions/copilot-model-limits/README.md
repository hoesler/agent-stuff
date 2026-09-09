# copilot-model-limits

Refreshes the token limits pi holds for GitHub Copilot models with the ones the
Copilot API reports for the signed-in account.

pi's Copilot catalog is generated from models.dev, so its `contextWindow` and
`maxTokens` are whatever that catalog said when the release was cut. The Copilot
`/models` endpoint reports the account's real numbers. This extension registers a
`refreshModels` on the built-in `github-copilot` provider and folds them in, so a
long session is measured against the window the account actually has.

Nothing to configure. It uses the Copilot credential pi already holds; if you are
not signed in to Copilot it does nothing.

## Scope

Limits only.

Which models the account may use is pi's own job as of 0.85 — the built-in
Copilot provider filters its catalog by the account's available model ids, taken
from this same endpoint when the OAuth token is refreshed. This extension leaves
every model in place and never prunes the list.

## When it speaks up

Two cases are expected and stay quiet: pi's offline startup pass, and having no
Copilot OAuth credential. Both hand pi its own catalog back unchanged.

Anything else — a refused request, a catalog with no readable limits — is
reported. pi shows it in the model picker as
`Could not refresh github-copilot; showing cached models.` Limits that could not
be read should not look read.

## Notes for the next person

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
