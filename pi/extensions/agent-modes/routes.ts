import type { ActualSelection } from "./mode-state.ts";
import type { ActiveMode, ModeConfig, RouteTarget } from "./types.ts";

/** A route key that currently has a target, and the model string it points at. */
export interface ResolvedRoute {
  key: string;
  model: string;
  description?: string;
}

/**
 * Why a configured key does or does not resolve right now.
 *
 * `off` and `unset` differ in intent — one mode said no, the other never said
 * anything — and a consumer that only sees "no route" cannot tell them apart.
 * Only the doctor needs the distinction; publishing keeps using `active` alone.
 */
export type RouteState = "active" | "off" | "redundant" | "unset";

/** One configured key, judged against the active mode and the live selection. */
export interface RouteStatus {
  key: string;
  state: RouteState;
  /** The target's model string. Present for `active` and `redundant`. */
  model?: string;
  description?: string;
}

/** Same rendering as a mode's model string, so `:off` never appears. */
export function routeModelString(target: RouteTarget): string {
  const base = `${target.provider}/${target.model}`;
  return target.thinkingLevel === "off" ? base : `${base}:${target.thinkingLevel}`;
}

/**
 * Judge every configured route key against the active mode and the live
 * selection, keeping the ones that do not resolve and saying why.
 *
 * `mode:custom` and `mode:error` carry no mode entry, so they fall through to
 * `defaultRoutes` — which is the point of that field: a session pinned with
 * `--model` still has a second opinion available.
 *
 * A target equal to the live provider/model/thinkingLevel triple resolves to
 * nothing: a second opinion from the model already running is not one.
 *
 * The key universe is every key named anywhere in the config, not just the ones
 * reaching the active mode. A key configured only in some *other* mode is the
 * likeliest reason a route the user believes they set is missing, and reporting
 * it as `unset` is the only way the doctor can say so. Keys are sorted, so both
 * the catalog and the report are stable across turns.
 */
export function describeRoutes(
  config: ModeConfig,
  active: ActiveMode,
  effective: ActualSelection,
): RouteStatus[] {
  const modeRoutes = active.kind === "named" ? active.mode.routes : undefined;
  const keys = new Set([
    ...Object.keys(config.defaultRoutes ?? {}),
    ...config.modes.flatMap((mode) => Object.keys(mode.routes ?? {})),
  ]);
  const statuses: RouteStatus[] = [];
  for (const key of [...keys].sort()) {
    // `??` and not `||`: `false` is not nullish, so an explicit opt-out in the
    // active mode short-circuits the default rather than inheriting it.
    const entry = modeRoutes?.[key] ?? config.defaultRoutes?.[key];
    if (entry === undefined) {
      statuses.push({ key, state: "unset" });
      continue;
    }
    if (entry === false) {
      statuses.push({ key, state: "off" });
      continue;
    }
    const redundant =
      entry.provider === effective.provider &&
      entry.model === effective.model &&
      entry.thinkingLevel === effective.thinkingLevel;
    statuses.push({
      key,
      state: redundant ? "redundant" : "active",
      model: routeModelString(entry),
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return statuses;
}

/**
 * The keys that currently resolve, in the shape publishers and the catalog use.
 *
 * The narrowing lives here rather than in a second resolution pass, so what the
 * doctor reports and what a consumer is handed cannot drift apart.
 */
export function activeRoutes(statuses: RouteStatus[]): ResolvedRoute[] {
  return statuses
    .filter((status) => status.state === "active")
    .map((status) => ({
      key: status.key,
      model: status.model!,
      ...(status.description ? { description: status.description } : {}),
    }));
}
