import type { TitleMarker } from "./types.ts";

/** Custom session entry type used to persist naming state. */
export const STATE_ENTRY_TYPE = "session-title-state";

/**
 * Parse one marker payload. Unknown or corrupt shapes return undefined, so
 * entries written by an older version degrade to "no marker" rather than
 * throwing.
 */
export function parseMarker(data: unknown): TitleMarker | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name) return undefined;
  if (raw.kind !== "generated" && raw.kind !== "user") return undefined;
  return {
    kind: raw.kind,
    name: raw.name,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
  };
}

/** The most recent parseable marker on the branch, if any. */
export function latestMarker(branch: readonly unknown[]): TitleMarker | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as any;
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const marker = parseMarker(entry.data);
    if (marker) return marker;
  }
  return undefined;
}

/**
 * Whether automatic titling should stand down.
 *
 * A name with no marker was set outside this extension (resume from an older
 * version, `--name`, RPC) and is treated as user-owned. A name that disagrees
 * with the marker also counts as titled: something set it, and overwriting it
 * would be the one behavior this design rules out.
 */
export function alreadyTitled(existingName: string | undefined): boolean {
  return Boolean(existingName);
}
