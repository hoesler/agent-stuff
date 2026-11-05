# inovex AI gateway provider

## Intent

Use the inovex AI gateway (`https://gateway.inovex.ai`) from pi as a full route, beside Copilot and the rest: listed in `/model`, usable from agent modes, `oracle` and session titles. The gateway is the governed, inovex-paid way to reach Anthropic, Google and the Nebul-hosted open models, and the only route allowed for confidential project data (Gemini through the gateway key).

The gateway keeps a curated model list at `GET /v1/models`. pi should follow that list instead of a hand-kept one.

## Goals

- An `inovex-gateway` extension that registers an `inovex` provider whose models come from the gateway's `/v1/models`.
- Model IDs used exactly as the gateway lists them (`anthropic/claude-opus-5-5`); the prefix is what routes.
- Claude models over `anthropic-messages`, everything else over `openai-completions`.
- Context window, output limit, reasoning, input types and cost filled from pi's built-in catalog, since the gateway reports none of them.
- Startup that does not wait on the network, and that still has the models when offline.

## Non-goals

- Obtaining or renewing the key. It is read from `GATEWAY_API_TOKEN`; the sandbox (nono, running `synapse auth default`) injects it and handles the 8-hour expiry.
- Routing your own Claude or Copilot subscription through the gateway.
- Enforcing the data-classification rules (which data may go to which model).
- Its own config file. Per-model corrections go through pi's `modelOverrides` in `models.json`.

## Anti-goals

- A model list that silently falls back to stale or empty without saying so.
- Any request that sends the key only as `x-api-key`; the gateway rejects it.
- Logging the key or provider payloads.

## Constraints (from the gateway docs and pi 1.1 source)

- Auth is `Authorization: Bearer sk-aigw-…` only. OpenAI-compatible base `https://gateway.inovex.ai/v1`, Anthropic base `https://gateway.inovex.ai`.
- The Anthropic API is not translated: Gemini is reachable only through `/v1/chat/completions`.
- gzip-compressed request bodies are misrouted. pi's chat and messages clients do not compress (only the Codex responses client does), so nothing to do.
- `/v1/models` entries carry `id`, `display_name` and `owned_by` (`anthropic`, `google`, `nebul`), and nothing else useful.
- pi's legacy `ProviderConfig.refreshModels` returns the full model list and does not persist it. Most refresh passes are cache-only (`allowNetwork: false`), and pi rebuilds the provider at the top of each, so a cache-only pass must hand back the last known list. Only interactive startup fires a network pass on its own (see `copilot-model-limits`).
- pi's `anthropic-messages` client sends a plain API key as `x-api-key`. `authHeader: true` on the provider adds `Authorization: Bearer <key>` on every request.

## Approaches

1. **`registerProvider` with `refreshModels`, modelled on `copilot-model-limits` (picked).** One provider, per-model `api` and `baseUrl`, a snapshot on disk for startup, a network refresh asked for on each session start. Reuses patterns this repo already proved.
2. **A complete pi-ai `Provider` publishing its own model state.** Native, with built-in persistence, but no precedent in this repo and much more code for the same result.
3. **Everything over `openai-completions`.** Least code, but Claude would go through the gateway's protocol translation, likely losing prompt caching and thinking fidelity.

## Design

**Registration.** `pi.registerProvider("inovex", { name: "inovex AI Gateway", baseUrl: "https://gateway.inovex.ai/v1", api: "openai-completions", apiKey: "$GATEWAY_API_TOKEN", authHeader: true, models: <snapshot>, refreshModels })`. Anthropic-owned models set `api: "anthropic-messages"` and `baseUrl: "https://gateway.inovex.ai"`.

**Snapshot.** The last good `/v1/models` answer (raw entries, not enriched models) lives at `<agentDir>/inovex-gateway/models.json`. The factory reads this local file at load and registers its models, so startup and `pi --list-models` have them without a round trip. No snapshot yet → no models until the first network refresh. Enrichment runs on every pass, so a pi upgrade's newer catalog applies without refetching.

**Refresh.** Cache-only pass → return the current list. Network pass → `GET /v1/models` with the bearer key and the pass's signal; on success write the snapshot and return the new list; on failure report and throw (the current list stays). `session_start` asks for a network refresh without awaiting it, skipping when `PI_OFFLINE` is set, as `copilot-model-limits` does. No key in the environment → quiet, nothing fetched.

**Enrichment** (pure function, catalog injected). For each gateway entry, in order:
1. `owned_by` `anthropic` or `google`: that built-in provider's model with the bare ID (prefix stripped).
2. Otherwise a case-insensitive exact match on the full ID across built-in providers in a fixed preference order (OpenRouter first, then the other aggregators).
3. Otherwise a match after dropping precision suffixes (`-FP8`, `-BF16`) and lower-casing.
4. No match: `input: ["text"]`, `contextWindow: 128000`, `maxTokens: 8192`, `reasoning: false`, zero cost.

From a match take `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `input`, `cost` and `promptCache` (Anthropic only). `name` is the gateway's `display_name`. Limits from another host are a guess at what Nebul serves; `modelOverrides` corrects them.

**Failures.** Held and shown once per reason through `ctx.ui.notify` on the next `session_start`, like `copilot-model-limits`: an HTTP error (401 means the key expired), an unreachable gateway, an empty or unreadable list. An aborted pass stays quiet.

**Files.** `pi/extensions/inovex-gateway/`: `index.ts` (pi surface), `gateway.ts` (fetch + parse), `enrich.ts` (catalog matching), `snapshot.ts`, colocated tests, `README.md`. Root `README.md` table row and `package.json` test glob.

## Left to the builder

- The exact catalog preference order after OpenRouter.
- Snapshot file format details.

## To verify against the live gateway before relying on them

- `anthropic-messages` with the prefixed ID and a Bearer header (plus the SDK's own `x-api-key`) succeeds.
- A Gemini model and a Nebul model answer over `openai-completions`, including a tool call.
- Thinking on a Claude model over `anthropic-messages`.
