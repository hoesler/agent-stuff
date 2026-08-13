import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULTS,
  type ConfigError,
  type ConfigSnapshot,
  type SessionSearchConfig,
} from "./types.ts";

const ROOT_KEYS = new Set([
  "version",
  "dbPath",
  "sessionsDir",
  "includeThinking",
  "refreshBudgetBytes",
  "excludeCwd",
  "maxSnippetChars",
]);

export interface ConfigPathOptions {
  envPath: string | undefined;
  startupCwd: string;
  agentDir: string;
  projectTrusted: boolean;
}

/**
 * Config sources, lowest precedence first. An env path replaces both files;
 * the project file is only consulted for a trusted project, matching how pi
 * gates `.pi/settings.json`.
 */
export function resolveConfigPaths(options: ConfigPathOptions): string[] {
  const selected = options.envPath?.trim();
  if (selected) {
    return [isAbsolute(selected) ? selected : resolve(options.startupCwd, selected)];
  }
  const paths = [join(options.agentDir, "session-search.json")];
  if (options.projectTrusted) {
    paths.push(join(options.startupCwd, ".pi", "session-search.json"));
  }
  return paths;
}

/** Everything the extension needs, derived from the agent dir alone. */
export function defaultConfig(agentDir: string): SessionSearchConfig {
  return {
    version: 1,
    dbPath: join(agentDir, "session-search", "index.sqlite"),
    sessionsDir: join(agentDir, "sessions"),
    ...DEFAULTS,
    excludeCwd: [],
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) throw new Error(`${path}.${key}: unknown property`);
  }
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path}: expected a positive integer`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path}: expected an array of strings`);
  }
  return value as string[];
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path}: expected a path string`);
  return value.trim();
}

/**
 * Strict parse of one layer. Every field is optional — including `version` —
 * so a project file can adjust a single setting, and an absent file is simply
 * an absent layer rather than a broken configuration.
 */
export function parseOverride(value: unknown): Partial<SessionSearchConfig> {
  const input = record(value, "root");
  rejectUnknown(input, "root");
  if (input.version !== undefined && input.version !== 1) {
    throw new Error("root.version: expected 1");
  }
  const result: Partial<SessionSearchConfig> = {};
  if (input.dbPath !== undefined) result.dbPath = nonEmptyString(input.dbPath, "root.dbPath");
  if (input.sessionsDir !== undefined) {
    result.sessionsDir = nonEmptyString(input.sessionsDir, "root.sessionsDir");
  }
  if (input.includeThinking !== undefined) {
    result.includeThinking = booleanValue(input.includeThinking, "root.includeThinking");
  }
  if (input.refreshBudgetBytes !== undefined) {
    result.refreshBudgetBytes = positiveInteger(input.refreshBudgetBytes, "root.refreshBudgetBytes");
  }
  if (input.excludeCwd !== undefined) {
    result.excludeCwd = stringArray(input.excludeCwd, "root.excludeCwd");
  }
  if (input.maxSnippetChars !== undefined) {
    result.maxSnippetChars = positiveInteger(input.maxSnippetChars, "root.maxSnippetChars");
  }
  return result;
}

interface FileRead {
  path: string;
  raw: unknown;
}

/**
 * Reads the configured paths, caching by a `mtime:size` fingerprint per path so
 * an edit takes effect without restarting pi.
 *
 * A broken layer is collected into `errors` and skipped rather than thrown: a
 * typo in the project file must not take searching away, but it must not be
 * silent either.
 */
export class SessionSearchConfigLoader {
  public readonly paths: string[];
  public readonly agentDir: string;
  public current: ConfigSnapshot;

  public constructor(paths: string[], agentDir: string) {
    this.paths = paths;
    this.agentDir = agentDir;
    this.current = {
      config: defaultConfig(agentDir),
      paths,
      fingerprint: "unread",
      errors: [],
    };
  }

  public async refresh(force = false): Promise<ConfigSnapshot> {
    const reads: FileRead[] = [];
    const fingerprints: string[] = [];
    const errors: ConfigError[] = [];

    for (const path of this.paths) {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        fingerprints.push(`${path}:missing`);
        continue;
      }
      fingerprints.push(`${path}:${info.mtimeMs}:${info.size}`);
      try {
        reads.push({ path, raw: JSON.parse(await readFile(path, "utf8")) });
      } catch (cause) {
        errors.push({ path, message: cause instanceof Error ? cause.message : String(cause) });
      }
    }

    const fingerprint = fingerprints.join("|");
    if (!force && fingerprint === this.current.fingerprint) return this.current;

    let config = defaultConfig(this.agentDir);
    for (const layer of reads) {
      try {
        config = { ...config, ...parseOverride(layer.raw), version: 1 };
      } catch (cause) {
        errors.push({
          path: layer.path,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    this.current = { config, paths: this.paths, fingerprint, errors };
    return this.current;
  }
}
