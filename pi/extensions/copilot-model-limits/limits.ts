/**
 * Reading the Copilot /models catalog, and folding what it says about token
 * limits into pi's own model list.
 *
 * Kept free of pi and of the network so the awkward parts — the token format,
 * a catalog that omits a limit, a model pi does not ship — are directly testable.
 */

export interface ModelLimits {
  contextWindow: number;
  maxTokens: number;
}

/** The date suffix Copilot appends to some ids, e.g. `gpt-4.1-2025-04-14`. */
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

const INDIVIDUAL_API = "https://api.individual.githubcopilot.com";

/**
 * Which host serves this account's Copilot API.
 *
 * A Copilot token carries the account's own proxy host as `proxy-ep=<host>`,
 * and the API lives at the same host with `proxy.` swapped for `api.`. That
 * beats any configured domain, because it is the endpoint the token was minted
 * for. An enterprise domain is the fallback for tokens that carry no proxy-ep.
 */
export function copilotApiBaseUrl(token: string | undefined, enterpriseUrl?: string): string {
  const proxyHost = token?.match(/proxy-ep=([^;]+)/)?.[1];
  if (proxyHost) return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
  if (enterpriseUrl) return `https://copilot-api.${enterpriseUrl}`;
  return INDIVIDUAL_API;
}

/**
 * The bare hostname of a configured enterprise, however it was written down.
 *
 * pi stores `enterpriseUrl` as the user typed it, so it may be a full URL, and
 * pasting one into `copilot-api.<domain>` would produce nonsense.
 */
export function enterpriseDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** A limit is only worth overriding pi's own value with if it is a real token count. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Index a /models response by model id.
 *
 * Models are also indexed under their base name so a dated id in the catalog
 * still answers for the undated id pi ships. A model that reports only one of
 * the two limits is skipped entirely: pi's pair is at least self-consistent,
 * and half an override is worse than none.
 */
export function parseCopilotLimits(payload: unknown): Map<string, ModelLimits> {
  const limits = new Map<string, ModelLimits>();
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return limits;

  const baseNames: Array<[string, ModelLimits]> = [];
  for (const entry of data) {
    const model = asRecord(entry);
    const id = model?.id;
    if (typeof id !== "string" || !id) continue;

    const reported = asRecord(asRecord(model.capabilities)?.limits);
    const contextWindow = tokenCount(reported?.max_context_window_tokens);
    const maxTokens = tokenCount(reported?.max_output_tokens);
    if (contextWindow === undefined || maxTokens === undefined) continue;

    limits.set(id, { contextWindow, maxTokens });
    const base = id.replace(DATE_SUFFIX, "");
    if (base !== id) baseNames.push([base, { contextWindow, maxTokens }]);
  }

  // Second pass, so a base name never displaces a model the catalog listed under
  // exactly that id.
  for (const [base, entry] of baseNames) {
    if (!limits.has(base)) limits.set(base, entry);
  }
  return limits;
}

/**
 * pi's models with the reported limits folded in.
 *
 * Every model survives. Which of them the account may actually use is pi's own
 * business: since 0.85 the built-in Copilot provider filters the catalog by the
 * account's available model ids, and a second opinion from here would only
 * fight it.
 */
export function applyCopilotLimits<T extends { id: string; contextWindow: number; maxTokens: number }>(
  models: readonly T[],
  limits: ReadonlyMap<string, ModelLimits>,
): T[] {
  return models.map((model) => ({ ...model, ...limits.get(model.id) }));
}
