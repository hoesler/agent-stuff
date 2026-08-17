import type { HunkNote, HunkResult, HunkSession } from "./types.ts";

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number;
}

/** The one seam onto the outside world. `pi.exec` satisfies this. */
export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecOutcome>;

/**
 * Hunk's own words, minus its prefix. Never reworded: its bundled skill maps
 * each message to a cause, including that "No active Hunk sessions" can mean a
 * sandbox blocked localhost rather than that no window is open.
 */
export function hunkMessage(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.startsWith("hunk:") ? trimmed.slice("hunk:".length).trim() : trimmed;
}

/**
 * Whether a *thrown* spawn error names a missing executable. Only the throw
 * path needs this: pi's own `exec` never throws, so this serves other `Exec`
 * implementations. It is deliberately not applied to a failed command's output
 * — see `run`.
 */
function looksMissing(text: string): boolean {
  return /ENOENT|command not found|No such file or directory/i.test(text);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(value: unknown): number | undefined {
  return Array.isArray(value) ? optionalNumber(value[0]) : undefined;
}

/**
 * Unparseable output means no sessions, never an exception. `session list`
 * exits 0 whether or not anything is live, so its body is the only signal, and
 * a malformed body must degrade to "nothing is live".
 */
export function parseSessions(stdout: string): HunkSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const sessions = record(parsed)?.sessions;
  if (!Array.isArray(sessions)) return [];
  const result: HunkSession[] = [];
  for (const entry of sessions) {
    const fields = record(entry);
    const sessionId = optionalString(fields?.sessionId);
    if (!fields || !sessionId) continue;
    result.push({
      sessionId,
      repoRoot: optionalString(fields.repoRoot),
      title: optionalString(fields.title),
      fileCount: optionalNumber(fields.fileCount),
    });
  }
  return result;
}

export function parseNotes(stdout: string): HunkNote[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const comments = record(parsed)?.comments;
  if (!Array.isArray(comments)) return [];
  const result: HunkNote[] = [];
  for (const entry of comments) {
    const fields = record(entry);
    const noteId = optionalString(fields?.noteId);
    const filePath = optionalString(fields?.filePath);
    if (!fields || !noteId || !filePath) continue;
    const newLine = firstLine(fields.newRange);
    const oldLine = firstLine(fields.oldRange);
    result.push({
      noteId,
      source: optionalString(fields.source) ?? "unknown",
      filePath,
      line: newLine ?? oldLine,
      side: newLine === undefined ? "old" : "new",
      body: optionalString(fields.body) ?? "",
      author: optionalString(fields.author),
      createdAt: optionalString(fields.createdAt),
    });
  }
  return result;
}

export interface HunkCli {
  listSessions(): Promise<HunkResult<HunkSession[]>>;
  reload(sessionId: string, target: string[]): Promise<HunkResult<void>>;
  listNotes(sessionId: string, type: "user" | "all"): Promise<HunkResult<HunkNote[]>>;
  skillPath(): Promise<HunkResult<string>>;
}

export function createCli(deps: { exec: Exec; hunkBin: string; cwd: string }): HunkCli {
  async function run(args: string[]): Promise<HunkResult<string>> {
    let outcome: ExecOutcome;
    try {
      outcome = await deps.exec(deps.hunkBin, args, { cwd: deps.cwd, timeout: 15000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: looksMissing(message) ? "missing-binary" : "hunk-error", message };
    }
    if (outcome.code === 0) return { ok: true, value: outcome.stdout };
    // pi's `exec` resolves a spawn failure as `{stdout:"", stderr:"", code:1}`,
    // discarding the ENOENT, so blank output on a failure is the only signal
    // that the binary never ran — Hunk itself always prints a message. Matching
    // the text instead would misread a real Hunk error that happens to mention
    // a missing file, and would send the user to reinstall Hunk over a bad path.
    if (!outcome.stderr.trim() && !outcome.stdout.trim()) {
      return {
        ok: false,
        kind: "missing-binary",
        message: `\`${deps.hunkBin}\` failed without output. Check that Hunk is installed and on PATH.`,
      };
    }
    return { ok: false, kind: "hunk-error", message: hunkMessage(outcome.stderr) || hunkMessage(outcome.stdout) };
  }

  return {
    async listSessions() {
      const result = await run(["session", "list", "--json"]);
      return result.ok ? { ok: true, value: parseSessions(result.value) } : result;
    },
    async reload(sessionId, target) {
      const result = await run(["session", "reload", sessionId, "--json", "--", ...target]);
      return result.ok ? { ok: true, value: undefined } : result;
    },
    async listNotes(sessionId, type) {
      const result = await run(["session", "comment", "list", sessionId, "--type", type, "--json"]);
      return result.ok ? { ok: true, value: parseNotes(result.value) } : result;
    },
    async skillPath() {
      const result = await run(["skill", "path"]);
      return result.ok ? { ok: true, value: result.value.trim() } : result;
    },
  };
}
