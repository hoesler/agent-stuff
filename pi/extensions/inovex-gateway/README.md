# inovex-gateway

Adds the [inovex AI Gateway](https://gateway.inovex.ai/docs/) to pi as the
`inovex` provider. The models are the ones the gateway lists at `/v1/models`,
so pi follows the gateway's curated list instead of a hand-kept one.

## The key

The extension reads the gateway key from `INOVEX_GATEWAY_API_KEY`. A key lives
eight hours; `synapse auth default` mints a new one. `synapse launch` sets the
generic `GATEWAY_API_TOKEN` instead, so under it start pi as
`INOVEX_GATEWAY_API_KEY=$GATEWAY_API_TOKEN pi`. Getting the key into pi's
environment, and renewing it, is the sandbox's
job — for example a nono credential that runs `synapse auth default`. Without a
key pi counts the provider as unconfigured and hides its models from `/model`
and `pi --list-models` until one is set.

The key goes out only as `Authorization: Bearer`. The gateway refuses a key it
receives as `x-api-key` alone, which is how pi's Anthropic client sends a plain
API key, so the provider sets `authHeader: true`.

## Which API each model speaks

| Gateway owner | pi API | Base URL |
| --- | --- | --- |
| `anthropic` | `anthropic-messages` | `https://gateway.inovex.ai` |
| everything else (`google`, `nebul`) | `openai-completions` | `https://gateway.inovex.ai/v1` |

The gateway forwards the Anthropic API untranslated, so Claude keeps prompt
caching and thinking blocks. It does not translate the Anthropic API to Gemini,
so Gemini goes through the OpenAI API like the open models. Model IDs are sent
exactly as the gateway lists them (`anthropic/claude-opus-5-5`), since the
prefix is what routes; in pi you select one as `inovex/anthropic/claude-opus-5-5`.

## Limits and prices

`/v1/models` names a model and its owner, nothing else. The context window,
output limit, reasoning flag, input types and price come from pi's own catalog:

1. Claude and Gemini: the `anthropic` or `google` entry with the same ID, minus
   the prefix.
2. Open models: the same `vendor/model` ID at OpenRouter, then other hosts,
   case-insensitively.
3. Then the same name with the vendor and precision suffix dropped, so
   `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` finds
   `nvidia/nemotron-3-super-120b-a12b`.
4. Nothing found: text only, 128k context, 8k output, no reasoning, no price.

A Claude model found in step 1 also takes Anthropic's request `compat` — current
Claude models accept only adaptive thinking and no temperature, and the gateway
passes the request through untranslated. A Claude model found only at another
host takes neither that host's `compat` nor its cache lifetime.

The open models run at Nebul, and nobody publishes Nebul's limits; the numbers
are another host's. Correct one with `modelOverrides` in `models.json`:

```json
{
  "providers": {
    "inovex": {
      "modelOverrides": {
        "zai-org/GLM-5.3": { "contextWindow": 200000, "maxTokens": 32000 }
      }
    }
  }
}
```

Prices are list prices. inovex pays, so pi's cost readout is what the session
would have cost, not what you are charged.

## When it reads the list

The last list the gateway gave is kept at
`~/.pi/agent/inovex-gateway/models.json`, and the provider is registered from it
at load, so startup, `pi --list-models` and `pi -p` never wait on the gateway.
Every session start — startup, `/reload`, `/new`, a resume — asks for a fresh
list in the background, unless `PI_OFFLINE` is set. The first run has no list
until that answer arrives.

## When it speaks up

An expired or refused key, an unreachable or stalled gateway, an empty list, or a list that
could not be saved shows once as an error notification:

    inovex-gateway: the gateway refused the key (401); it has probably expired — renew it with synapse auth.

The list in use stays as it was. A cancelled refresh, and having no key at all,
stay quiet.
