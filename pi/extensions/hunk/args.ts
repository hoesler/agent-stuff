import { rawTarget, type Target } from "./targets.ts";

export type Mode = "menu" | "review" | "open" | "fix";

export type ParsedCommand = { mode: Mode; target?: Target; sessionId?: string } | { error: string };

/**
 * `/hunk [review|open|fix] [target…] [--session <id>]`. A target implies
 * review, because a target says which changeset to look at and addressing
 * notes never needs one. No arguments at all opens the menu, which is the one
 * surface that names every form.
 */
export function parseCommand(args: string): ParsedCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  let sessionId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== "--session") {
      rest.push(tokens[i]);
      continue;
    }
    const value = tokens[i + 1];
    if (!value) return { error: "--session needs a session id." };
    sessionId = value;
    i += 1;
  }

  const withSession = <T extends { mode: Mode; target?: Target }>(command: T) =>
    sessionId ? { ...command, sessionId } : command;

  if (rest.length === 0) return withSession({ mode: "menu" });

  const [head, ...tail] = rest;

  if (head === "fix") {
    if (tail.length > 0) {
      return { error: `/hunk fix takes no target. Use /hunk review ${tail.join(" ")} to review it.` };
    }
    return withSession({ mode: "fix", target: undefined });
  }

  if (head === "review" || head === "open") {
    return withSession({ mode: head, target: tail.length > 0 ? rawTarget(tail) : undefined });
  }

  return withSession({ mode: "review", target: rawTarget(rest) });
}
