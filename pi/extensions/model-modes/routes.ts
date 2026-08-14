import type { ActualSelection } from "./mode-state.ts";
import type { ActiveMode, ModeConfig, RouteTarget } from "./types.ts";

/** A route key that currently has a target, and the model string it points at. */
export interface ResolvedRoute {
  key: string;
  model: string;
  description?: string;
}

/** Same rendering as a mode's model string, so `:off` never appears. */
export function routeModelString(target: RouteTarget): string {
  const base = `${target.provider}/${target.model}`;
  return target.thinkingLevel === "off" ? base : `${base}:${target.thinkingLevel}`;
}

/**
 * Resolve every configured route key against the active mode and the live
 * selection.
 *
 * `mode:custom` and `mode:error` carry no mode entry, so they fall through to
 * `defaultRoutes` — which is the point of that field: a session pinned with
 * `--model` still has a second opinion available.
 *
 * A target equal to the live provider/model/thinkingLevel triple resolves to
 * nothing: a second opinion from the model already running is not one.
 */
export function resolveRoutes(
  config: ModeConfig,
  active: ActiveMode,
  effective: ActualSelection,
): ResolvedRoute[] {
  const modeRoutes = active.kind === "named" ? active.mode.routes : undefined;
  const keys = new Set([...Object.keys(config.defaultRoutes ?? {}), ...Object.keys(modeRoutes ?? {})]);
  const resolved: ResolvedRoute[] = [];
  for (const key of [...keys].sort()) {
    // `??` and not `||`: `false` is not nullish, so an explicit opt-out in the
    // active mode short-circuits the default and then fails the guard below.
    const entry = modeRoutes?.[key] ?? config.defaultRoutes?.[key];
    if (!entry) continue;
    if (
      entry.provider === effective.provider &&
      entry.model === effective.model &&
      entry.thinkingLevel === effective.thinkingLevel
    ) {
      continue;
    }
    resolved.push({
      key,
      model: routeModelString(entry),
      ...(entry.description ? { description: entry.description } : {}),
    });
  }
  return resolved;
}
