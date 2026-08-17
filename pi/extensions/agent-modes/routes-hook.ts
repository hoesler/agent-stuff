/**
 * Optional, dependency-free contract that lets a delegation extension (e.g.
 * `subagent`) turn a bare model *key* into a concrete
 * `provider/model[:thinkingLevel]` string at dispatch time, without either
 * extension depending on the other.
 *
 * Contract (documented so any third-party extension can opt in on either side):
 * - A shared `Set` of resolver functions is stored on
 *   `globalThis.__piModelRouteResolvers`.
 * - Each function takes a route key and returns a
 *   `provider/model[:thinkingLevel]` string, or `undefined` to decline.
 * - Consumers call every registered function at the moment they need a model,
 *   ignore thrown errors, and take the first non-empty answer.
 * - Resolution is pull, not push: load order does not matter, nothing is
 *   broadcast on registration, and a mid-session mode change needs no
 *   invalidation because the next call re-reads the live answer.
 * - Only the key travels through the model's context; the resolved value is
 *   read here, in code, so a prompt built earlier in the session cannot hand
 *   the agent a stale route.
 * - This module never imports from, or requires the presence of, the consuming
 *   extension; it only touches a well-known global key.
 */

export type ModelRouteResolver = (key: string) => string | undefined;

function resolvers(): Set<ModelRouteResolver> {
  const g = globalThis as typeof globalThis & { __piModelRouteResolvers?: Set<ModelRouteResolver> };
  if (!g.__piModelRouteResolvers) g.__piModelRouteResolvers = new Set();
  return g.__piModelRouteResolvers;
}

/** Register a resolver. Returns an unregister function. */
export function registerModelRouteResolver(fn: ModelRouteResolver): () => void {
  const set = resolvers();
  set.add(fn);
  return () => set.delete(fn);
}
