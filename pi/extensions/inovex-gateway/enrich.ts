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
  Partial<Pick<ChatModelConfig, "thinkingLevelMap" | "promptCache">>;

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

function match(entry: GatewayModel, catalog: Catalog, order: readonly string[]): CatalogModel | undefined {
  if (OWN_PROVIDERS.has(entry.ownedBy) && catalog.providers.includes(entry.ownedBy)) {
    const bare = entry.id.slice(entry.id.indexOf("/") + 1);
    const own = catalog.models(entry.ownedBy).find((candidate) => candidate.id === bare);
    if (own) return own;
  }
  const lower = entry.id.toLowerCase();
  const exact = find(catalog, order, (id) => id.toLowerCase() === lower);
  if (exact) return exact;
  const normalized = normalize(entry.id);
  return find(catalog, order, (id) => normalize(id) === normalized);
}

export function toProviderModels(entries: readonly GatewayModel[], catalog: Catalog): ChatModelConfig[] {
  const order = searchOrder(catalog);
  return entries.map((entry) => {
    const anthropic = entry.ownedBy === "anthropic";
    const source = match(entry, catalog, order) ?? UNKNOWN;
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
      // A cache lifetime is the serving host's promise. Only Anthropic's own
      // entry describes the host the gateway actually forwards Claude to.
      ...(anthropic && source.promptCache ? { promptCache: source.promptCache } : {}),
    };
  });
}
