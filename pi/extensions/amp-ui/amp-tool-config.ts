/**
 * Configuration for amp-style tool rendering.
 *
 * Kept intentionally tiny and dependency-free: a single typed `getConfig()`
 * closure returning sensible defaults. No interactive config modal — the
 * defaults match Amp's compact look and can be tightened later if needed.
 */

/** Resolved configuration for the amp tool display extension. */
export interface AmpToolConfig {
  /** Number of output lines shown in the collapsed preview. */
  previewLines: number;
  /** Maximum lines shown when the result view is expanded. 0 means "show all". */
  expandedPreviewMaxLines: number;
}

const DEFAULT_CONFIG: AmpToolConfig = {
  previewLines: 8,
  expandedPreviewMaxLines: 4000,
};

/**
 * Return the resolved tool-display configuration.
 *
 * Currently always returns the defaults. Exposed as a function so callers
 * (renderers) never close over a mutable singleton and so a future config
 * source can be threaded in without changing call sites.
 */
export function getConfig(): AmpToolConfig {
  return { ...DEFAULT_CONFIG };
}
