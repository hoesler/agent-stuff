/**
 * Lifting the Copilot request headers from pi's models onto the provider.
 *
 * The Copilot API refuses a request that arrives without an `Editor-Version`:
 * `400 bad request: missing Editor-Version header for IDE auth`. pi carries
 * that header, and three others, on each Copilot model in its catalog — but it
 * strips them from every model an extension hands back. `applyExtension` in
 * pi's provider composer rebuilds each returned model with `headers: undefined`,
 * so a `refreshModels` that touches only the token limits still silences them.
 *
 * A provider-level `headers` survives that, and pi merges it into the resolved
 * auth for every request. Reading the values off pi's own catalog rather than
 * writing them down here keeps them the running pi's, so a release that bumps
 * the editor version is followed rather than overridden.
 */

/** The headers part of a model, all this needs to know about one. */
interface HeaderedModel {
  headers?: Record<string, string>;
}

/**
 * The headers every one of these models carries, or undefined if there is no
 * such header.
 *
 * Provider headers go on every request the provider makes, so only a header the
 * whole catalog agrees on can be lifted; one the models disagree about would be
 * a guess imposed on the rest. pi's Copilot models have carried one identical
 * set for as long as the endpoint has needed it, so in practice this is that
 * set.
 */
export function sharedModelHeaders(models: readonly HeaderedModel[]): Record<string, string> | undefined {
  const [first, ...rest] = models;
  if (!first?.headers) return undefined;

  const shared: Record<string, string> = { ...first.headers };
  for (const model of rest) {
    for (const [name, value] of Object.entries(shared)) {
      if (model.headers?.[name] !== value) delete shared[name];
    }
  }
  return Object.keys(shared).length > 0 ? shared : undefined;
}
