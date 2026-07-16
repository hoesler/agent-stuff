import type { ActiveMode, ModeConfig, ModeDefinition, ThinkingLevel } from "./types.ts";

export interface ActualSelection {
  provider?: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
}

export function inferActiveMode(config: ModeConfig, selection: ActualSelection): ActiveMode {
  const mode = config.modes.find(
    (candidate) =>
      candidate.provider === selection.provider &&
      candidate.model === selection.model &&
      candidate.thinkingLevel === selection.thinkingLevel,
  );
  return mode ? { kind: "named", mode } : { kind: "custom" };
}

export function cycleOrder(
  config: ModeConfig,
  active: ActiveMode,
  direction: 1 | -1,
): ModeDefinition[] {
  if (active.kind !== "named") {
    return direction === 1 ? [...config.modes] : [...config.modes].reverse();
  }
  const index = config.modes.findIndex((mode) => mode.id === active.mode.id);
  const ordered: ModeDefinition[] = [];
  for (let offset = 1; offset <= config.modes.length; offset += 1) {
    const position = (index + direction * offset + config.modes.length) % config.modes.length;
    ordered.push(config.modes[position]!);
  }
  return ordered;
}

export interface SessionStartLike {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SessionEntryLike {
  type: string;
}

export function isFreshSession(event: SessionStartLike, entries: readonly SessionEntryLike[]): boolean {
  if (event.reason === "new") return true;
  if (event.reason !== "startup") return false;
  let modelChanges = 0;
  let thinkingChanges = 0;
  for (const entry of entries) {
    if (entry.type === "model_change") modelChanges += 1;
    else if (entry.type === "thinking_level_change") thinkingChanges += 1;
    else return false;
  }
  return modelChanges <= 1 && thinkingChanges <= 1;
}
