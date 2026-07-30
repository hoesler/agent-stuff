/** pi-ai's ModelThinkingLevel: "off" plus the real levels. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ModelThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SessionTitleConfig {
  version: 1;
  /** "provider/modelId" — the titling model. */
  model: string;
  thinkingLevel: ModelThinkingLevel;
  enabled: boolean;
  /** Character cap on the title; 0 means unlimited. */
  maxLength: number;
  debug: boolean;
}

export const DEFAULTS = {
  thinkingLevel: "off",
  enabled: true,
  maxLength: 50,
  debug: false,
} as const satisfies Omit<SessionTitleConfig, "version" | "model">;

export interface ConfigError {
  path: string;
  message: string;
}

export type ConfigSnapshot =
  | { ok: true; paths: string[]; fingerprint: string; config: SessionTitleConfig }
  | {
      ok: false;
      paths: string[];
      fingerprint: string;
      reason: "missing" | "invalid";
      errors: ConfigError[];
    };

/** Persisted naming state, written as a "session-title-state" custom entry. */
export type TitleMarker =
  | { kind: "generated"; name: string; timestamp: number }
  | { kind: "user"; name: string; timestamp: number };
