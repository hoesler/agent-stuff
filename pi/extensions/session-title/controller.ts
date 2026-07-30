import type { TitleMarker } from "./types.ts";

/**
 * Request lifecycle for session titling.
 *
 * Ported in shape from pi-autoname (MIT) — https://github.com/ssdiwu/pi-autoname
 *
 * Owns every write to the session name. A boolean latch would not be enough:
 * `/title` can run while the automatic call is in flight, and shutdown can
 * arrive mid-call.
 */

export type TitleMode = "initial" | "manual";

export interface TitleRequest {
  mode: TitleMode;
  currentName: string | undefined;
  signal: AbortSignal;
}

export interface ControllerRuntime {
  now(): number;
  /** Config `enabled`; a manual request runs regardless. */
  isEnabled(): boolean;
  getCurrentName(): string | undefined;
  setSessionName(name: string): void;
  appendMarker(marker: TitleMarker): void;
  generateTitle(request: TitleRequest): Promise<string | undefined>;
  debug(message: string): void;
}

export interface TitleController {
  /** Adopt persisted state at session start. */
  restore(titled: boolean, existingName: string | undefined): void;
  /** React to `session_info_changed`. */
  observeNameChange(name: string | undefined): void;
  /** Whether automatic titling should stand down. */
  isTitled(): boolean;
  run(mode: TitleMode): Promise<string | undefined>;
  shutdown(): void;
}

export function normalizeName(name: string | undefined): string | undefined {
  const normalized = name?.trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

export function createController(runtime: ControllerRuntime): TitleController {
  let titled = false;
  /** The last name this extension wrote, so pi's echo is recognisable as ours. */
  let ownName: string | undefined;
  let sequence = 0;
  let active: AbortController | undefined;

  const apply = (name: string, requestSequence: number): string | undefined => {
    if (requestSequence !== sequence) {
      runtime.debug(`discarding stale title: ${name}`);
      return undefined;
    }
    const normalized = normalizeName(name);
    if (!normalized) return undefined;

    // Claim ownership before writing: setSessionName() makes pi emit
    // session_info_changed, and that echo must not look like a user rename.
    ownName = normalized;
    titled = true;

    if (normalized === normalizeName(runtime.getCurrentName())) {
      runtime.debug(`title already current: ${normalized}`);
    } else {
      runtime.setSessionName(normalized);
    }
    runtime.appendMarker({ kind: "generated", name: normalized, timestamp: runtime.now() });
    return normalized;
  };

  return {
    restore(isTitled, existingName) {
      titled = isTitled;
      ownName = normalizeName(existingName);
      sequence += 1;
    },

    observeNameChange(name) {
      const normalized = normalizeName(name);
      if (!normalized || normalized === ownName) return;
      ownName = normalized;
      titled = true;
      runtime.appendMarker({ kind: "user", name: normalized, timestamp: runtime.now() });
      runtime.debug(`external session name observed: ${normalized}`);
    },

    isTitled() {
      return titled;
    },

    async run(mode) {
      if (mode !== "manual" && !runtime.isEnabled()) return undefined;

      active?.abort(new Error("superseded by a newer titling request"));
      const controller = new AbortController();
      active = controller;
      const requestSequence = ++sequence;

      try {
        const name = await runtime.generateTitle({
          mode,
          currentName: normalizeName(runtime.getCurrentName()),
          signal: controller.signal,
        });
        return name ? apply(name, requestSequence) : undefined;
      } catch (cause) {
        if (!controller.signal.aborted) {
          runtime.debug(`titling failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        return undefined;
      } finally {
        if (active === controller) active = undefined;
      }
    },

    shutdown() {
      sequence += 1;
      active?.abort(new Error("session shut down"));
      active = undefined;
    },
  };
}
