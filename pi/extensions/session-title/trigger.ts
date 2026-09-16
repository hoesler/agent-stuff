export interface TriggerInput {
  hasUI: boolean;
  configured: boolean;
  enabled: boolean;
  titled: boolean;
}

/** The automatic-trigger predicate, kept pure so it is testable. */
export function shouldTitleOnSettle(input: TriggerInput): boolean {
  return input.hasUI && input.configured && input.enabled && !input.titled;
}

/**
 * The one method of pi's ModelRegistry this needs, structurally typed so tests
 * can pass a literal and this module stays free of pi imports.
 */
export interface ModelLookup<TModel = unknown> {
  find(provider: string, modelId: string): TModel | undefined;
}

/** Split "provider/modelId" and look it up. The model id may itself contain slashes. */
export function resolveTitlingModel<TModel>(
  registry: ModelLookup<TModel>,
  model: string,
): TModel | undefined {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return registry.find(model.slice(0, separator), model.slice(separator + 1));
}

/**
 * pi resolves a provider's endpoint from the credential, not from the catalog:
 * a GitHub Copilot business or enterprise token names its own host, and the
 * catalog entry carries only the individual-plan default. pi's own request path
 * rewrites the model this way before calling a provider, so a caller that
 * reaches for the provider directly has to do the same — the API client reads
 * the endpoint off the model and nowhere else.
 */
export function withResolvedEndpoint<TModel extends { baseUrl?: string }>(
  model: TModel,
  baseUrl: string | undefined,
): TModel {
  return baseUrl ? { ...model, baseUrl } : model;
}
