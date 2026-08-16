/**
 * Whether a tool is advertised at all.
 *
 * The tool-level equivalent of `subagent`'s route-gated promotion: no route and
 * no personas, no advertised capability. The agent never sees a tool it cannot
 * use, so it cannot pick one that dies on dispatch.
 *
 * Pure, and derived from the live list rather than assembled from scratch:
 * `setActiveTools` replaces the whole list, so a function that built its answer
 * from anywhere else would clobber whatever another extension had toggled.
 * `undefined` means "nothing to do", which keeps the per-turn call free.
 */

export function nextActiveTools(name: string, available: boolean, current: string[]): string[] | undefined {
	const present = current.includes(name);
	if (available === present) return undefined;
	return available ? [...current, name] : current.filter((tool) => tool !== name);
}
