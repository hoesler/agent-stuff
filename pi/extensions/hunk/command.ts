/**
 * Turning a target into a command line a shell will run. Both spawn backends
 * type their command into an interactive shell rather than exec'ing it, so both
 * need the same quoting — Ghostty through a surface's initial input, herdr
 * through `pane run`.
 */

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The `hunk` invocation as one shell-safe line, without a terminator. */
export function commandLine(hunkBin: string, target: string[]): string {
  return [hunkBin, ...target].map(shellQuote).join(" ");
}

/** What Ghostty types into the new surface. The newline runs it. */
export function startupInput(hunkBin: string, target: string[]): string {
  return `${commandLine(hunkBin, target)}\n`;
}
