import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  THINKING_LEVELS,
  type ConfigError,
  type ConfigSnapshot,
  type ModeConfig,
  type ModeDefinition,
  type ThinkingLevel,
} from "./types.ts";

const RESERVED_IDS = new Set(["next", "previous", "doctor", "help", "init"]);
const SHORTCUT = /^(?:(?:ctrl|shift|alt)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2])|escape|enter|tab|space|backspace|delete|home|end|pageUp|pageDown|up|down|left|right)$/i;
const ROOT_KEYS = new Set(["version", "defaultMode", "cycleShortcut", "modes"]);
const MODE_KEYS = new Set(["id", "label", "provider", "model", "thinkingLevel", "description"]);

export interface ConfigPathOptions {
  envPath: string | undefined;
  startupCwd: string;
  agentDir: string;
}

export function resolveConfigPath(options: ConfigPathOptions): string {
  const selected = options.envPath?.trim();
  if (!selected) return join(options.agentDir, "model-modes.json");
  return isAbsolute(selected) ? selected : resolve(options.startupCwd, selected);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}: expected non-empty string`);
  }
  return value.trim();
}

function rejectUnknown(input: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown property`);
  }
}

function parseMode(value: unknown, index: number): ModeDefinition {
  const path = `root.modes[${index}]`;
  const input = record(value, path);
  rejectUnknown(input, MODE_KEYS, path);
  const id = requiredString(input.id, `${path}.id`);
  if (/\s/.test(id)) throw new Error(`${path}.id: whitespace is not allowed`);
  if (RESERVED_IDS.has(id)) throw new Error(`${path}.id: reserved mode id "${id}"`);
  const thinking = requiredString(input.thinkingLevel, `${path}.thinkingLevel`);
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`${path}.thinkingLevel: unsupported value "${thinking}"`);
  }
  const mode: ModeDefinition = {
    id,
    label: input.label === undefined ? id : requiredString(input.label, `${path}.label`),
    provider: requiredString(input.provider, `${path}.provider`),
    model: requiredString(input.model, `${path}.model`),
    thinkingLevel: thinking as ThinkingLevel,
  };
  if (input.description !== undefined) {
    mode.description = requiredString(input.description, `${path}.description`);
  }
  return mode;
}

export function parseModeConfig(value: unknown): ModeConfig {
  const input = record(value, "root");
  rejectUnknown(input, ROOT_KEYS, "root");
  if (input.version !== 1) throw new Error("root.version: expected 1");
  const defaultMode = requiredString(input.defaultMode, "root.defaultMode");
  if (!Array.isArray(input.modes) || input.modes.length === 0) {
    throw new Error("root.modes: expected non-empty array");
  }
  const modes = input.modes.map(parseMode);
  const ids = new Set<string>();
  for (const mode of modes) {
    if (ids.has(mode.id)) throw new Error(`root.modes: duplicate mode id "${mode.id}"`);
    ids.add(mode.id);
  }
  if (!ids.has(defaultMode)) throw new Error("root.defaultMode: must reference a configured mode");
  const cycleShortcut = input.cycleShortcut === undefined
    ? undefined
    : requiredString(input.cycleShortcut, "root.cycleShortcut");
  if (cycleShortcut !== undefined && !SHORTCUT.test(cycleShortcut)) {
    throw new Error("root.cycleShortcut: invalid Pi shortcut");
  }
  return { version: 1, defaultMode, ...(cycleShortcut ? { cycleShortcut } : {}), modes };
}

function error(_filePath: string, cause: unknown): ConfigError {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const parsed = /^(root(?:\.[^:]+)?):\s*(.*)$/.exec(raw);
  return parsed
    ? { path: parsed[1]!, message: parsed[2]! }
    : { path: "root", message: raw };
}

export class ModeConfigLoader {
  public readonly path: string;
  public readonly fromEnvironment: boolean;
  public current: ConfigSnapshot;

  public constructor(path: string, fromEnvironment: boolean) {
    this.path = path;
    this.fromEnvironment = fromEnvironment;
    this.current = {
      ok: false,
      path,
      fromEnvironment,
      fingerprint: "unread",
      reason: "missing",
      errors: [{ path: "root", message: "configuration has not been loaded" }],
    };
  }

  public async refresh(force = false): Promise<ConfigSnapshot> {
    let fingerprint = "missing";
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.path);
    } catch {
      this.current = {
        ok: false,
        path: this.path,
        fromEnvironment: this.fromEnvironment,
        fingerprint,
        reason: "missing",
        errors: [{ path: "root", message: `no configuration file found at "${this.path}"` }],
      };
      return this.current;
    }
    fingerprint = `${info.mtimeMs}:${info.size}`;
    if (!force && fingerprint === this.current.fingerprint) return this.current;
    try {
      const parsed = parseModeConfig(JSON.parse(await readFile(this.path, "utf8")));
      this.current = {
        ok: true,
        path: this.path,
        fromEnvironment: this.fromEnvironment,
        fingerprint,
        config: parsed,
      };
    } catch (cause) {
      this.current = {
        ok: false,
        path: this.path,
        fromEnvironment: this.fromEnvironment,
        fingerprint,
        reason: "invalid",
        errors: [error(this.path, cause)],
      };
    }
    return this.current;
  }
}
