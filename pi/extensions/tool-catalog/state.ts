/**
 * What you asked for, kept apart from what is actually active.
 *
 * pi separates registered tools from active ones: an extension registers its
 * tools once and switches them in and out of the model's schema as it goes.
 * `setActiveTools` replaces the whole active list, so anything that writes a
 * remembered list back over it deactivates whatever another extension turned on
 * meanwhile. This module therefore stores only overrides — the tools you pinned
 * on or off — and every write is computed from the live list.
 *
 * Overrides are appended as custom session entries rather than written to a
 * config file, so forking or walking the session tree carries the intent that
 * was live on that branch. Pure, so the rules are testable without a session.
 */

import type { ToolOverride } from "./catalog.ts";

export const OVERRIDES_ENTRY = "tool-catalog-overrides";

export interface OverridesState {
	overrides: Record<string, ToolOverride>;
}

/** The slice of a session entry this module reads. */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

function isOverride(value: unknown): value is ToolOverride {
	return value === "on" || value === "off";
}

export function restoreOverrides(entries: BranchEntry[]): Map<string, ToolOverride> {
	let latest: Record<string, unknown> | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== OVERRIDES_ENTRY) continue;
		const data = entry.data as OverridesState | undefined;
		// A later malformed entry must not discard an earlier good one.
		if (data?.overrides && typeof data.overrides === "object") latest = data.overrides;
	}
	const overrides = new Map<string, ToolOverride>();
	for (const [name, intent] of Object.entries(latest ?? {})) {
		if (isOverride(intent)) overrides.set(name, intent);
	}
	return overrides;
}

/**
 * The active list your overrides imply, or `undefined` when it already matches.
 *
 * Derived from the live list rather than assembled from scratch: everything not
 * pinned stays exactly where the session left it, which is what makes `auto`
 * mean "not my business". `undefined` keeps the caller from rewriting a list
 * that needs no change.
 */
export function nextActiveTools(
	live: string[],
	overrides: ReadonlyMap<string, ToolOverride>,
	registered: ReadonlySet<string>,
): string[] | undefined {
	const pinned = (intent: ToolOverride) =>
		[...overrides].filter(([name, value]) => value === intent && registered.has(name)).map(([name]) => name);

	const off = new Set(pinned("off"));
	const kept = live.filter((name) => !off.has(name));
	const added = pinned("on").filter((name) => !kept.includes(name));
	const next = [...kept, ...added];

	const unchanged = next.length === live.length && next.every((name, index) => name === live[index]);
	return unchanged ? undefined : next;
}
