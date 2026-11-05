/**
 * Gateway models as pi models.
 *
 * The gateway names its models and nothing more, but pi needs a context window,
 * an output limit, a reasoning flag, input types and a price for every one. pi's
 * own catalog already knows most of these models under some provider, so the
 * numbers are borrowed from there. Split from the extension so the matching can
 * be tested against a hand-built catalog.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GATEWAY_ORIGIN, type GatewayModel } from "./gateway.ts";

export type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

/** The part of a pi-ai catalog model read here. */
export type CatalogModel = Pick<ChatModelConfig, "id" | "input" | "reasoning" | "contextWindow" | "maxTokens" | "cost"> &
  Partial<Pick<ChatModelConfig, "thinkingLevelMap" | "promptCache" | "compat">>;

export interface Catalog {
  providers: readonly string[];
  models(provider: string): readonly CatalogModel[];
}

/**
 * Where an open model's numbers are looked for first. OpenRouter lists most of
 * them under the same `vendor/model` ids Nebul uses; the rest are hosts that
 * also do. None of them is Nebul, so their limits are a guess at what Nebul
 * serves — `modelOverrides` in models.json is the way to correct one.
 */
const PREFERRED = ["openrouter", "huggingface", "baseten", "fireworks", "nvidia", "groq"];

/** Providers whose own catalog entry is the model, under the id without its prefix. */
const OWN_PROVIDERS = new Set(["anthropic", "google"]);

const UNKNOWN: CatalogModel = {
  id: "",
  input: ["text"],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * An id reduced to what hosts agree on: the model's own name, without the
 * vendor repeated in it and without the precision a host serves it at.
 * `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16` → `nemotron-3-super-120b-a12b`.
 */
export function normalize(id: string): string {
  const lower = id.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const vendor = slash > 0 ? lower.slice(0, lower.indexOf("/")) : "";
  let name = lower.slice(slash + 1).replace(/-(fp8|bf16|fp16|int4|int8)$/, "");
  if (vendor && name.startsWith(`${vendor}-`)) name = name.slice(vendor.length + 1);
  return name;
}

function searchOrder(catalog: Catalog): string[] {
  const preferred = PREFERRED.filter((provider) => catalog.providers.includes(provider));
  return [...preferred, ...catalog.providers.filter((provider) => !preferred.includes(provider))];
}

function find(catalog: Catalog, order: readonly string[], matches: (id: string) => boolean): CatalogModel | undefined {
  for (const provider of order) {
    const found = catalog.models(provider).find((candidate) => matches(candidate.id));
    if (found) return found;
  }
  return undefined;
}

/**
 * pi takes the gateway for OpenAI's own API and hands a reasoning model its
 * instructions in the `developer` role. Kimi's chat template at Nebul rejects
 * that role outright; `system` is understood by every backend behind the
 * gateway, and the gateway translates it for Gemini.
 */
const OPENAI_COMPAT = { supportsDeveloperRole: false } as CatalogModel["compat"];

/** The model's own provider's entry, when there is one. */
function ownEntry(entry: GatewayModel, catalog: Catalog): CatalogModel | undefined {
  if (!OWN_PROVIDERS.has(entry.ownedBy) || !catalog.providers.includes(entry.ownedBy)) return undefined;
  const bare = entry.id.slice(entry.id.indexOf("/") + 1);
  return catalog.models(entry.ownedBy).find((candidate) => candidate.id === bare);
}

function borrowed(entry: GatewayModel, catalog: Catalog, order: readonly string[]): CatalogModel | undefined {
  const lower = entry.id.toLowerCase();
  const exact = find(catalog, order, (id) => id.toLowerCase() === lower);
  if (exact) return exact;
  const normalized = normalize(entry.id);
  return find(catalog, order, (id) => normalize(id) === normalized);
}

/**
 * How Anthropic's own entry says to talk to the model. Current Claude models
 * accept only adaptive thinking and no temperature, and the gateway forwards
 * the request untranslated, so without this pi would send budget thinking and
 * be refused. The fallback models name pi's `anthropic` provider and a beta
 * only Anthropic's own API serves.
 */
function anthropicCompat(compat: CatalogModel["compat"]): CatalogModel["compat"] | undefined {
  if (!compat) return undefined;
  const { allowedFallbackModels: _fallbacks, ...rest } = compat as Record<string, unknown>;
  return rest as CatalogModel["compat"];
}

export function toProviderModels(entries: readonly GatewayModel[], catalog: Catalog): ChatModelConfig[] {
  const order = searchOrder(catalog);
  return entries.map((entry) => {
    const anthropic = entry.ownedBy === "anthropic";
    const own = ownEntry(entry, catalog);
    const source = own ?? borrowed(entry, catalog, order) ?? UNKNOWN;
    const compat = anthropic ? (own ? anthropicCompat(own.compat) : undefined) : OPENAI_COMPAT;
    return {
      id: entry.id,
      name: entry.name,
      // The gateway does not translate the Anthropic API, but Claude spoken
      // natively keeps prompt caching and thinking blocks intact. Everything
      // else, Gemini included, goes through the OpenAI API on /v1.
      ...(anthropic ? { api: "anthropic-messages" as const, baseUrl: GATEWAY_ORIGIN } : {}),
      input: [...source.input],
      reasoning: source.reasoning,
      ...(source.thinkingLevelMap ? { thinkingLevelMap: source.thinkingLevelMap } : {}),
      contextWindow: source.contextWindow,
      maxTokens: source.maxTokens,
      cost: { ...source.cost },
      ...(compat ? { compat } : {}),
      // A cache lifetime is the serving host's promise. Only Anthropic's own
      // entry describes the host the gateway actually forwards Claude to.
      ...(anthropic && own?.promptCache ? { promptCache: own.promptCache } : {}),
    };
  });
}
