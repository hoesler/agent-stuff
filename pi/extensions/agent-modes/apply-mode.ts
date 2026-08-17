import type {
  ApplyResult,
  ModeDefinition,
  ModeModel,
  ThinkingLevel,
} from "./types.ts";

export interface ApplyRuntime {
  findModel(provider: string, id: string): ModeModel | undefined;
  getCurrentModel(): ModeModel | undefined;
  getThinkingLevel(): ThinkingLevel;
  setModel(model: ModeModel): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
}

export function preflightMode(runtime: ApplyRuntime, mode: ModeDefinition): string | undefined {
  const model = runtime.findModel(mode.provider, mode.model);
  if (!model) return `model not found: ${mode.provider}/${mode.model}`;
  if (!model.reasoning && mode.thinkingLevel !== "off") {
    return `${mode.provider}/${mode.model} does not support reasoning`;
  }
  if (model.thinkingLevelMap?.[mode.thinkingLevel] === null) {
    return `${mode.provider}/${mode.model} does not support thinking level ${mode.thinkingLevel}`;
  }
  return undefined;
}

export async function applyMode(runtime: ApplyRuntime, mode: ModeDefinition): Promise<ApplyResult> {
  const preflight = preflightMode(runtime, mode);
  if (preflight) {
    return { ok: false, mode, stage: "preflight", message: preflight, stateChanged: false, rollbackSucceeded: true };
  }

  const target = runtime.findModel(mode.provider, mode.model)!;
  const previousModel = runtime.getCurrentModel();
  const previousThinking = runtime.getThinkingLevel();

  try {
    if (!(await runtime.setModel(target))) {
      return {
        ok: false,
        mode,
        stage: "model",
        message: `model unavailable or authentication failed: ${mode.provider}/${mode.model}`,
        stateChanged: false,
        rollbackSucceeded: true,
      };
    }
  } catch (cause) {
    return {
      ok: false,
      mode,
      stage: "model",
      message: cause instanceof Error ? cause.message : String(cause),
      stateChanged: false,
      rollbackSucceeded: true,
    };
  }

  runtime.setThinkingLevel(mode.thinkingLevel);
  const effectiveThinking = runtime.getThinkingLevel();
  if (effectiveThinking === mode.thinkingLevel) return { ok: true, mode };

  let rollbackSucceeded = previousModel !== undefined;
  if (previousModel !== undefined) {
    try {
      rollbackSucceeded = await runtime.setModel(previousModel);
      if (rollbackSucceeded) {
        runtime.setThinkingLevel(previousThinking);
        rollbackSucceeded = runtime.getThinkingLevel() === previousThinking;
      }
    } catch {
      rollbackSucceeded = false;
    }
  }

  return {
    ok: false,
    mode,
    stage: rollbackSucceeded ? "thinking" : "rollback",
    message: `thinking level ${mode.thinkingLevel} was clamped to ${effectiveThinking}`,
    stateChanged: !rollbackSucceeded,
    rollbackSucceeded,
  };
}
