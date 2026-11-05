import type { Exec } from "./cli.ts";
import type { SpawnOutcome } from "./types.ts";

/**
 * A Rex session is driven through the `rex` binary, which finds and connects to
 * the Rex server on its own. The window opens as a new tab rather than a split:
 * a tab has room for a diff without squeezing the pane pi is running in.
 */

/** Long enough for a busy server, short enough not to wedge a command handler. */
export const REX_TIMEOUT_MS = 10000;

/**
 * Rex injects this into every terminal it opens. It names the session to add
 * the tab to, so without it there is nowhere to open one — picking some other
 * session would put the diff where the user is not looking.
 */
export function insideRex(env: Record<string, string | undefined>): boolean {
  return typeof env.REX_SESSION === "string" && env.REX_SESSION.length > 0;
}

/**
 * Runs its arguments as one command and, only if it fails, holds the tab open
 * until Enter. A Rex tab closes when its command exits, so a hunk that cannot
 * start — wrong binary, rejected target — would otherwise vanish with its error,
 * leaving only "did not register" to go on. herdr and Ghostty type into a shell,
 * which stays open by itself; a clean quit here still closes the tab.
 */
export const PAUSE_ON_FAILURE =
  '"$@" || { status=$?; printf "\\nhunk exited with status %s. Press Enter to close this tab." "$status"; read _; exit "$status"; }';

/**
 * The command goes after `--` as separate words, so a target with spaces needs
 * no quoting. `-c` is explicit for the same reason the other backends carry a
 * cwd: the tab must open on the repository under review, not wherever pi started.
 * `--autostart=false` because a server `rex` started for us would not hold pi's
 * session: an unreachable server must surface as itself, not as a timeout.
 */
export function windowArgs(session: string, cwd: string, hunkBin: string, target: string[]): string[] {
  return [
    "window",
    "new",
    "-s",
    session,
    "Hunk",
    "-c",
    cwd,
    "--json",
    "--autostart=false",
    "--",
    "sh",
    "-c",
    PAUSE_ON_FAILURE,
    "sh",
    hunkBin,
    ...target,
  ];
}

export interface RexDeps {
  exec: Exec;
  env: Record<string, string | undefined>;
}

export async function spawnTab(
  deps: RexDeps,
  options: { cwd: string; rexBin: string; hunkBin: string; target: string[] },
): Promise<SpawnOutcome> {
  const session = deps.env.REX_SESSION;
  if (!insideRex(deps.env) || !session) {
    return { ok: false, message: "pi is not running inside a Rex session." };
  }
  try {
    const outcome = await deps.exec(
      options.rexBin,
      windowArgs(session, options.cwd, options.hunkBin, options.target),
      { timeout: REX_TIMEOUT_MS },
    );
    // A killed process can still report `code: 0` — pi's own `exec` resolves a
    // kill as `code ?? 0` — so `killed` is checked before `code` is trusted.
    if (outcome.killed) {
      return { ok: false, message: `rex did not respond within ${REX_TIMEOUT_MS / 1000}s.` };
    }
    if (outcome.code !== 0) {
      return { ok: false, message: outcome.stderr.trim() || outcome.stdout.trim() || "rex window new failed" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
