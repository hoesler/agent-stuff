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
 * The command goes after `--` as separate words, so a target with spaces needs
 * no quoting. `-c` is explicit for the same reason the other backends carry a
 * cwd: the tab must open on the repository under review, not wherever pi started.
 */
export function windowArgs(session: string, cwd: string, hunkBin: string, target: string[]): string[] {
  return ["window", "new", "-s", session, "Hunk", "-c", cwd, "--json", "--", hunkBin, ...target];
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
