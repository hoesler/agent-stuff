import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULTS,
  THINKING_LEVELS,
  type ConfigError,
  type ConfigSnapshot,
  type ModelThinkingLevel,
  type SessionTitleConfig,
} from "./types.ts";

const ROOT_KEYS = new Set([
  "version",
  "model",
  "thinkingLevel",
  "enabled",
  "maxLength",
  "debug",
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
  const paths = [join(options.agentDir, "session-title.json")];
  if (options.projectTrusted) {
    paths.push(join(options.startupCwd, ".pi", "session-title.json"));
  }
  return paths;
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

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
  return value;
}

function modelString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path}: expected "provider/modelId" string`);
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(`${path}: expected "provider/modelId" string`);
  }
  return trimmed;
}

function thinkingLevel(value: unknown, path: string, fallback: ModelThinkingLevel): ModelThinkingLevel {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ModelThinkingLevel)) {
    throw new Error(`${path}: expected one of ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ModelThinkingLevel;
}

function maxLength(value: unknown, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path}: expected a non-negative integer`);
  }
  return value;
}

/** Strict parse of a complete (global or env) config file. Throws on any problem. */
export function parseConfig(value: unknown): SessionTitleConfig {
  const input = record(value, "root");
  rejectUnknown(input, "root");
  if (input.version !== 1) throw new Error("root.version: expected 1");
  return {
    version: 1,
    model: modelString(input.model, "root.model"),
    thinkingLevel: thinkingLevel(input.thinkingLevel, "root.thinkingLevel", DEFAULTS.thinkingLevel),
    enabled: optionalBoolean(input.enabled, "root.enabled", DEFAULTS.enabled),
    maxLength: maxLength(input.maxLength, "root.maxLength", DEFAULTS.maxLength),
    debug: optionalBoolean(input.debug, "root.debug", DEFAULTS.debug),
  };
}

/**
 * Strict parse of an override layer: every field is optional, including
 * `version` and `model`, so a project file can adjust one field only.
 */
export function parseOverride(value: unknown): Partial<SessionTitleConfig> {
  const input = record(value, "root");
  rejectUnknown(input, "root");
  if (input.version !== undefined && input.version !== 1) {
    throw new Error("root.version: expected 1");
  }
  const result: Partial<SessionTitleConfig> = {};
  if (input.model !== undefined) result.model = modelString(input.model, "root.model");
  if (input.thinkingLevel !== undefined) {
    result.thinkingLevel = thinkingLevel(input.thinkingLevel, "root.thinkingLevel", DEFAULTS.thinkingLevel);
  }
  if (input.enabled !== undefined) {
    result.enabled = optionalBoolean(input.enabled, "root.enabled", DEFAULTS.enabled);
  }
  if (input.maxLength !== undefined) {
    result.maxLength = maxLength(input.maxLength, "root.maxLength", DEFAULTS.maxLength);
  }
  if (input.debug !== undefined) {
    result.debug = optionalBoolean(input.debug, "root.debug", DEFAULTS.debug);
  }
  return result;
}

/** Project layer wins per field. */
export function mergeConfig(
  base: SessionTitleConfig,
  override: Partial<SessionTitleConfig>,
): SessionTitleConfig {
  return { ...base, ...override, version: 1 };
}

interface FileRead {
  path: string;
  raw: unknown;
}

/**
 * Reads the configured paths, caching by a `mtime:size` fingerprint per path so
 * an edit takes effect without restarting pi, and an unchanged set of files
 * returns the identical snapshot object.
 */
export class SessionTitleConfigLoader {
  public readonly paths: string[];
  public current: ConfigSnapshot;

  public constructor(paths: string[]) {
    this.paths = paths;
    this.current = {
      ok: false,
      paths,
      fingerprint: "unread",
      reason: "missing",
      errors: [{ path: "root", message: "configuration has not been loaded" }],
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
        errors.push({
          path,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    const fingerprint = fingerprints.join("|");
    if (!force && fingerprint === this.current.fingerprint) return this.current;

    if (errors.length > 0) {
      this.current = { ok: false, paths: this.paths, fingerprint, reason: "invalid", errors };
      return this.current;
    }
    if (reads.length === 0) {
      this.current = {
        ok: false,
        paths: this.paths,
        fingerprint,
        reason: "missing",
        errors: [{ path: this.paths.join(", "), message: "no configuration file found" }],
      };
      return this.current;
    }

    try {
      const [first, ...rest] = reads;
      let config = parseConfig(first.raw);
      for (const layer of rest) config = mergeConfig(config, parseOverride(layer.raw));
      this.current = { ok: true, paths: this.paths, fingerprint, config };
    } catch (cause) {
      this.current = {
        ok: false,
        paths: this.paths,
        fingerprint,
        reason: "invalid",
        errors: [{ path: "root", message: cause instanceof Error ? cause.message : String(cause) }],
      };
    }
    return this.current;
  }
}
