import type { Exec } from "./cli.ts";

/**
 * Adapted from `mitsuhiko/agent-stuff`'s `split-fork.ts`: a new surface
 * configuration carries the working directory and the command to type, and the
 * focused terminal splits to the right — falling back to a new window when
 * none is open.
 */
export const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** What Ghostty types into the new surface. The newline runs it. */
export function startupInput(hunkBin: string, target: string[]): string {
  return `${[hunkBin, ...target].map(shellQuote).join(" ")}\n`;
}

export interface SpawnDeps {
  exec: Exec;
  platform: string;
}

export type SpawnOutcome = { ok: true } | { ok: false; message: string };

/**
 * Nothing else in the extension assumes Ghostty. A window the user opened by
 * hand is indistinguishable to every other module, so failing here is always
 * recoverable by printing the command for the user to run.
 */
export async function spawnWindow(
  deps: SpawnDeps,
  options: { cwd: string; hunkBin: string; target: string[] },
): Promise<SpawnOutcome> {
  if (deps.platform !== "darwin") {
    return { ok: false, message: "pi only opens a window on macOS with Ghostty." };
  }
  const input = startupInput(options.hunkBin, options.target);
  try {
    const outcome = await deps.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", options.cwd, input]);
    if (outcome.code !== 0) {
      return { ok: false, message: outcome.stderr.trim() || outcome.stdout.trim() || "osascript failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
