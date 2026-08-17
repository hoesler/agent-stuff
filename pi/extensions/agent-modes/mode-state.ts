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

/**
 * Flags through which a pi invocation can pin the model or the thinking level.
 * Kept in sync with pi's own argument parser (`cli/args.ts`), which matches the
 * exact token and consumes the following argument as the value.
 */
const MODEL_SELECTION_FLAGS = new Set(["--model", "--models", "--provider", "--thinking"]);

/**
 * Whether the invocation pinned a model or thinking level on the command line.
 *
 * Such a selection is more specific than the configured `defaultMode`, so
 * applying the default on session start would silently discard it — which is
 * exactly what happens to `pi --model <x>` and to every subagent spawned with
 * an explicit model.
 *
 * Matching mirrors pi's parser: only a standalone flag token followed by a
 * value counts, so a prompt that merely mentions `--model`, a `--model=x` form
 * pi itself ignores, or a trailing flag with no value are all not selections.
 */
export function hasExplicitModelSelection(argv: readonly string[]): boolean {
  return argv.some((arg, index) => MODEL_SELECTION_FLAGS.has(arg) && index + 1 < argv.length);
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
