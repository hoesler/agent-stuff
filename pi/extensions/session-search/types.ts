/**
 * A fully resolved configuration. Every field has a value: the extension works
 * with no config file at all, so parsing never produces a partial config that
 * the rest of the code has to defend against.
 */
export interface SessionSearchConfig {
  version: 1;
  /** SQLite index location. */
  dbPath: string;
  /** Root of pi's per-project session directories. */
  sessionsDir: string;
  /** Index assistant `thinking` blocks as prose. */
  includeThinking: boolean;
  /** Ceiling on bytes read by one inline refresh. */
  refreshBudgetBytes: number;
  /** Globs of session working directories to skip. */
  excludeCwd: string[];
  /** Per-result snippet cap, in characters. */
  maxSnippetChars: number;
}

export const DEFAULTS = {
  includeThinking: false,
  refreshBudgetBytes: 33554432,
  maxSnippetChars: 240,
} as const;

export interface ConfigError {
  path: string;
  message: string;
}

/**
 * A snapshot always carries a usable config. Errors are reported alongside it
 * rather than swallowed or thrown: a typo in one field must not take searching
 * away, but it must not be silent either.
 */
export interface ConfigSnapshot {
  config: SessionSearchConfig;
  paths: string[];
  fingerprint: string;
  errors: ConfigError[];
}
