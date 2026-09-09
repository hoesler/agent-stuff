/** Where a window may be spawned from, when none is live. */
export type SpawnMode = "ghostty" | "never";

export const SPAWN_MODES: readonly SpawnMode[] = ["ghostty", "never"];

/**
 * A fully resolved configuration. Every field has a value: the extension works
 * with no config file at all, so parsing never produces a partial config the
 * rest of the code has to defend against.
 */
export interface HunkConfig {
  version: 1;
  /** Path to the binary, for installs outside PATH. */
  hunkBin: string;
  /** `never` always prints the command instead of opening a window. */
  spawn: SpawnMode;
  /** `--author` on notes the agent is told to write. */
  noteAuthor: string;
}

export const DEFAULTS = {
  hunkBin: "hunk",
  spawn: "ghostty" as SpawnMode,
  noteAuthor: "pi",
} as const;

export interface ConfigError {
  path: string;
  message: string;
}

/**
 * A snapshot always carries a usable config. Errors ride alongside it rather
 * than being thrown or swallowed: a typo in one field must not take `/hunk`
 * away, but it must not be silent either.
 */
export interface ConfigSnapshot {
  config: HunkConfig;
  paths: string[];
  errors: ConfigError[];
}

/** A live session, as `hunk session list --json` reports it. */
export interface HunkSession {
  sessionId: string;
  /** The field repository matching keys on. Absent for non-VCS inputs. */
  repoRoot: string | undefined;
  title: string | undefined;
  fileCount: number | undefined;
}

/** One note, as `hunk session comment list --json` reports it. */
export interface HunkNote {
  noteId: string;
  /** `user` for notes typed in the TUI, `agent` for notes added over the CLI. */
  source: string;
  filePath: string;
  /** First line of whichever range the note carries. */
  line: number | undefined;
  side: "new" | "old";
  body: string;
  author: string | undefined;
  createdAt: string | undefined;
}

/**
 * Why a Hunk call failed. `missing-binary` is the only kind the caller words
 * itself; `hunk-error` carries Hunk's own message, which must reach the user
 * unchanged so its bundled skill still maps it to a cause.
 */
export interface HunkFailure {
  kind: "missing-binary" | "hunk-error";
  message: string;
}

export type HunkResult<T> = { ok: true; value: T } | ({ ok: false } & HunkFailure);
