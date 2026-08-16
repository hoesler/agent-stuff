/**
 * Which tools are enabled, recovered from the session branch.
 *
 * Selections are appended as custom entries rather than written to a config
 * file, so forking or walking the session tree carries the tool selection that
 * was live on that branch. Pure, so the branch-walk rules are testable without
 * a session.
 */

/** Kept from the extension's earlier name so selections saved before survive. */
export const TOOLS_CONFIG_ENTRY = "tools-config";

export interface ToolsState {
	enabledTools: string[];
}

/** The slice of a session entry this module reads. */
export interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

function savedSelection(entries: BranchEntry[]): string[] | undefined {
	let selection: string[] | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TOOLS_CONFIG_ENTRY) continue;
		const data = entry.data as ToolsState | undefined;
		// A later malformed entry must not discard an earlier good one.
		if (Array.isArray(data?.enabledTools)) selection = data.enabledTools;
	}
	return selection;
}

export interface RestoredTools {
	enabled: Set<string>;
	/** False when the session's own active set was adopted and must not be rewritten. */
	restored: boolean;
}

export function restoreEnabled(
	entries: BranchEntry[],
	allToolNames: string[],
	activeTools: string[],
): RestoredTools {
	const selection = savedSelection(entries);
	// No selection on this branch means the session's own active set is the truth.
	if (!selection) return { enabled: new Set(activeTools), restored: false };
	const known = new Set(allToolNames);
	return { enabled: new Set(selection.filter((name) => known.has(name))), restored: true };
}
