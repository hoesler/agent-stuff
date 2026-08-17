export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * A route's target. Deliberately the same shape as a mode target so a route and
 * a mode read identically in the config file; `description` is used only by the
 * system-prompt catalog.
 */
export interface RouteTarget {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  description?: string;
}

/** A target, or `false` to opt a mode out of an inherited default route. */
export type RouteEntry = RouteTarget | false;

export interface ModeDefinition {
  id: string;
  label: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  description?: string;
  routes?: Record<string, RouteEntry>;
}

export interface ModeConfig {
  version: 1;
  defaultMode: string;
  cycleShortcut?: string;
  exposeCatalogInSystemPrompt?: boolean;
  defaultRoutes?: Record<string, RouteEntry>;
  modes: ModeDefinition[];
}

export interface ConfigError {
  path: string;
  message: string;
}

export type ConfigSnapshot =
  | {
      ok: true;
      path: string;
      fromEnvironment: boolean;
      fingerprint: string;
      config: ModeConfig;
    }
  | {
      ok: false;
      path: string;
      fromEnvironment: boolean;
      fingerprint: string;
      reason: "missing" | "invalid";
      errors: ConfigError[];
    };

export type ActiveMode = { kind: "named"; mode: ModeDefinition }
  | { kind: "custom" }
  | { kind: "error" };

export interface ModeModel {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export type ApplyFailureStage = "preflight" | "model" | "thinking" | "rollback";

export type ApplyResult =
  | { ok: true; mode: ModeDefinition }
  | {
      ok: false;
      mode: ModeDefinition;
      stage: ApplyFailureStage;
      message: string;
      stateChanged: boolean;
      rollbackSucceeded: boolean;
    };
