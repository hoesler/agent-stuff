/**
 * Read half of the optional `globalThis.__piModelRouteResolvers` contract (see
 * `model-modes`'s `routes-hook.ts` for the publishing half and the full
 * contract). Inlined rather than imported: this extension must work with no
 * publisher installed, and must not gain a build dependency on one.
 */

type ModelRouteResolver = (key: string) => string | undefined;

/** First non-empty answer from any registered publisher, or `undefined`. */
export function resolveRoute(key: string): string | undefined {
	const g = globalThis as { __piModelRouteResolvers?: Set<ModelRouteResolver> };
	for (const fn of g.__piModelRouteResolvers ?? []) {
		try {
			const hit = fn(key);
			if (hit) return hit;
		} catch {
			// A misbehaving publisher must not break dispatch.
		}
	}
	return undefined;
}

/**
 * Turn whichever model value won the precedence chain into the string handed to
 * the child's `--model`. Not a new level in that chain: one resolution step
 * applied once to the winner, so a bare key works wherever a model string does.
 *
 * The discriminator is `/`: a model reference is `provider/model[:thinkingLevel]`
 * and always contains one, a route key never does. A bare value that resolves to
 * nothing passes through unchanged and the child errors on an unknown model, so
 * the worst case of the whole mechanism is the behavior before it existed.
 */
export function resolveModelReference(requested: string | undefined): string | undefined {
	if (!requested || requested.includes("/")) return requested;
	return resolveRoute(requested) ?? requested;
}
