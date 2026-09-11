import type { Exec } from "./cli.ts";
import { spawnWindow } from "./ghostty.ts";
import { insideHerdr, spawnPane } from "./herdr.ts";
import type { HunkConfig, SpawnMode, SpawnOutcome } from "./types.ts";

export interface SpawnDeps {
  exec: Exec;
  env: Record<string, string | undefined>;
  platform: string;
}

/**
 * Which backend a mode resolves to. `auto` is the only mode that inspects the
 * environment; an explicit mode is honored even where it cannot work, so a
 * configured `herdr` fails with herdr's own reason instead of quietly opening a
 * Ghostty window somewhere the user is not looking.
 */
export function chooseBackend(
  config: HunkConfig,
  env: Record<string, string | undefined>,
): Exclude<SpawnMode, "auto"> {
  if (config.spawn !== "auto") return config.spawn;
  return insideHerdr(env) ? "herdr" : "ghostty";
}

/**
 * The one place the spawn modes are dispatched. Every arm returns a
 * `SpawnOutcome`, so `ensureSession` keeps its single recovery path: print the
 * command and let the user run it themselves.
 */
export function createSpawn(
  deps: SpawnDeps,
  options: { config: HunkConfig; cwd: string },
): (target: string[]) => Promise<SpawnOutcome> {
  return async (target) => {
    const { config, cwd } = options;
    switch (chooseBackend(config, deps.env)) {
      case "never":
        return { ok: false, message: "Opening a window is disabled (`spawn: never`)." };
      case "herdr":
        return spawnPane(
          { exec: deps.exec, env: deps.env },
          { cwd, herdrBin: config.herdrBin, hunkBin: config.hunkBin, target },
        );
      default:
        return spawnWindow(
          { exec: deps.exec, platform: deps.platform },
          { cwd, hunkBin: config.hunkBin, target },
        );
    }
  };
}
