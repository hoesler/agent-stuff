import type { Exec } from "./cli.ts";
import { commandLine } from "./command.ts";
import type { SpawnOutcome } from "./types.ts";

/**
 * A herdr session is driven through the `herdr` binary, which speaks the socket
 * API documented at https://herdr.dev/docs/socket-api/. Going through the CLI
 * rather than the socket buys `pane run`, which sends the command text and
 * Enter as one submission and honors the pane's live bracketed-paste mode —
 * the part a hand-rolled `pane.send_input` client would have to get right.
 */

/** Long enough for a busy server, short enough not to wedge a command handler. */
export const HERDR_TIMEOUT_MS = 10000;

/**
 * herdr injects this into every pane it manages. Its own skill is explicit that
 * a session must not be driven from outside it, so this is a precondition
 * rather than a hint: without it there is no session to split.
 */
export function insideHerdr(env: Record<string, string | undefined>): boolean {
  return env.HERDR_ENV === "1";
}

/** herdr's own words, minus its prefix, so its error codes reach the user unchanged. */
function herdrMessage(outcome: { stderr: string; stdout: string }): string {
  const text = outcome.stderr.trim() || outcome.stdout.trim();
  return text.startsWith("herdr:") ? text.slice("herdr:".length).trim() : text;
}

/**
 * `--current` rather than an omitted target: an omitted one splits whichever
 * pane the UI has focused, which may belong to the user or another client.
 * `--cwd` is explicit for the same reason the Ghostty surface carries one — the
 * new pane must open on the repository under review, not wherever pi started.
 */
export function splitArgs(cwd: string): string[] {
  return ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--focus"];
}

/** `pane run` takes the command as words; one quoted line keeps a spaced target intact. */
export function runArgs(pane: string, hunkBin: string, target: string[]): string[] {
  return ["pane", "run", pane, commandLine(hunkBin, target)];
}

/** The new pane, as `pane split` reports it. Unreadable output means no pane. */
export function paneId(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const result = (parsed as { result?: { pane?: { pane_id?: unknown } } })?.result;
  const id = result?.pane?.pane_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export interface HerdrDeps {
  exec: Exec;
  env: Record<string, string | undefined>;
}

export async function spawnPane(
  deps: HerdrDeps,
  options: { cwd: string; herdrBin: string; hunkBin: string; target: string[] },
): Promise<SpawnOutcome> {
  if (!insideHerdr(deps.env)) {
    return { ok: false, message: "pi is not running inside a herdr pane." };
  }
  try {
    const split = await deps.exec(options.herdrBin, splitArgs(options.cwd), { timeout: HERDR_TIMEOUT_MS });
    // A killed process can still report `code: 0` — pi's own `exec` resolves a
    // kill as `code ?? 0` — so `killed` is checked before `code` is trusted.
    if (split.killed) {
      return { ok: false, message: `herdr did not respond within ${HERDR_TIMEOUT_MS / 1000}s.` };
    }
    if (split.code !== 0) {
      return { ok: false, message: herdrMessage(split) || "herdr pane split failed" };
    }
    const pane = paneId(split.stdout);
    if (!pane) {
      return { ok: false, message: "herdr split the pane but reported no pane id." };
    }

    const run = await deps.exec(options.herdrBin, runArgs(pane, options.hunkBin, options.target), {
      timeout: HERDR_TIMEOUT_MS,
    });
    if (run.killed) {
      return { ok: false, message: `herdr did not respond within ${HERDR_TIMEOUT_MS / 1000}s.` };
    }
    if (run.code !== 0) {
      // The pane is real and still open, so naming it lets the user finish by hand there.
      return {
        ok: false,
        message: `herdr opened pane ${pane} but could not start hunk in it: ${herdrMessage(run) || "pane run failed"}.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
