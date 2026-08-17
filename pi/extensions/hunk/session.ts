import type { HunkCli } from "./cli.ts";
import type { SpawnOutcome } from "./ghostty.ts";
import type { HunkSession } from "./types.ts";

export const POLL_INTERVAL_MS = 200;
export const POLL_CEILING_MS = 5000;

export interface SessionDeps {
  cli: HunkCli;
  /** The repository root, or undefined outside a repository. */
  gitRoot: () => Promise<string | undefined>;
  realpath: (path: string) => Promise<string>;
  spawn: (target: string[]) => Promise<SpawnOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type Resolution =
  | { kind: "session"; sessionId: string }
  | { kind: "ambiguous"; sessionIds: string[] }
  | { kind: "none"; message: string };

async function resolveOrSelf(realpath: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Hunk reports resolved paths, and on macOS a repository under `/tmp` reaches
 * pi as `/tmp/…` and Hunk as `/private/tmp/…`. Comparing the raw strings would
 * silently find no session in exactly the case a user is most likely to test.
 */
async function matching(deps: SessionDeps, sessions: HunkSession[], root: string): Promise<HunkSession[]> {
  const target = await resolveOrSelf(deps.realpath, root);
  const matches: HunkSession[] = [];
  for (const session of sessions) {
    if (!session.repoRoot) continue;
    if ((await resolveOrSelf(deps.realpath, session.repoRoot)) === target) matches.push(session);
  }
  return matches;
}

/**
 * A live session showing the target, or an explanation. Called without a target
 * — as fix mode calls it — there is nothing to spawn, so an absent window is
 * reported rather than created: a window opened now would be empty of the notes
 * it exists to read.
 */
export async function ensureSession(
  deps: SessionDeps,
  options: { target?: string[]; sessionId?: string },
): Promise<Resolution> {
  if (options.sessionId) return { kind: "session", sessionId: options.sessionId };

  const root = await deps.gitRoot();
  if (!root) {
    return { kind: "none", message: "This is not a git repository, so there is no review to match." };
  }

  const listed = await deps.cli.listSessions();
  if (!listed.ok) return { kind: "none", message: listed.message };

  const matches = await matching(deps, listed.value, root);

  if (matches.length > 1) {
    return { kind: "ambiguous", sessionIds: matches.map((session) => session.sessionId) };
  }

  if (matches.length === 1) {
    const found = matches[0];
    if (!options.target) return { kind: "session", sessionId: found.sessionId };
    const reloaded = await deps.cli.reload(found.sessionId, options.target);
    if (!reloaded.ok) return { kind: "none", message: reloaded.message };
    return { kind: "session", sessionId: found.sessionId };
  }

  if (!options.target) {
    return { kind: "none", message: "No Hunk window is open for this repository." };
  }

  const spawned = await deps.spawn(options.target);
  if (!spawned.ok) {
    return {
      kind: "none",
      message: `${spawned.message} Run this in your own terminal instead: hunk ${options.target.join(" ")}`,
    };
  }

  const deadline = deps.now() + POLL_CEILING_MS;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    const polled = await deps.cli.listSessions();
    if (!polled.ok) continue;
    const found = await matching(deps, polled.value, root);
    if (found.length > 0) return { kind: "session", sessionId: found[0].sessionId };
  }

  return {
    kind: "none",
    message: "The Hunk window opened but did not register within 5s. Run /hunk again.",
  };
}
