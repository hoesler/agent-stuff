import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULTS,
  SPAWN_MODES,
  type ConfigError,
  type ConfigSnapshot,
  type HunkConfig,
  type SpawnMode,
} from "./types.ts";

const ROOT_KEYS = new Set(["version", "hunkBin", "herdrBin", "spawn", "noteAuthor"]);

export interface ConfigPathOptions {
  envPath: string | undefined;
  startupCwd: string;
  agentDir: string;
  projectTrusted: boolean;
}

/**
 * Config sources, lowest precedence first. An env path replaces both files; the
 * project file is only consulted for a trusted project, matching how pi gates
 * `.pi/settings.json` and how `session-title` resolves its own config.
 */
export function resolveConfigPaths(options: ConfigPathOptions): string[] {
  const selected = options.envPath?.trim();
  if (selected) {
    return [isAbsolute(selected) ? selected : resolve(options.startupCwd, selected)];
  }
  const paths = [join(options.agentDir, "hunk.json")];
  if (options.projectTrusted) {
    paths.push(join(options.startupCwd, ".pi", "hunk.json"));
  }
  return paths;
}

export function defaultConfig(): HunkConfig {
  return {
    version: 1,
    hunkBin: DEFAULTS.hunkBin,
    herdrBin: DEFAULTS.herdrBin,
    spawn: DEFAULTS.spawn,
    noteAuthor: DEFAULTS.noteAuthor,
  };
}

function nonEmptyString(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}: expected a non-empty string`);
  }
  return value.trim();
}

function spawnMode(value: unknown, path: string, fallback: SpawnMode): SpawnMode {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !SPAWN_MODES.includes(value as SpawnMode)) {
    throw new Error(`${path}: expected one of ${SPAWN_MODES.join(", ")}`);
  }
  return value as SpawnMode;
}

/** Throws on the first problem, naming the exact key. Callers collect. */
export function parseConfig(raw: unknown, path: string, base: HunkConfig = defaultConfig()): HunkConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected object`);
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) throw new Error(`${path}.${key}: unknown property`);
  }
  return {
    version: 1,
    hunkBin: nonEmptyString(input.hunkBin, `${path}.hunkBin`, base.hunkBin),
    herdrBin: nonEmptyString(input.herdrBin, `${path}.herdrBin`, base.herdrBin),
    spawn: spawnMode(input.spawn, `${path}.spawn`, base.spawn),
    noteAuthor: nonEmptyString(input.noteAuthor, `${path}.noteAuthor`, base.noteAuthor),
  };
}

/**
 * Later paths shallow-override earlier ones. A file that fails to read is not an
 * error — it is absent. A file that fails to parse is an error that still leaves
 * the previous config standing.
 */
export async function loadConfig(options: ConfigPathOptions): Promise<ConfigSnapshot> {
  const paths = resolveConfigPaths(options);
  const errors: ConfigError[] = [];
  let config = defaultConfig();
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    try {
      config = parseConfig(JSON.parse(text) as unknown, path, config);
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { config, paths, errors };
}
