/**
 * Where to search: the `scope` parameter, resolved against the world.
 *
 * Resolution is the only part of searching that has to ask the world questions
 * — which repository this is, which session is running — so it lives here and
 * hands `search.ts` a plain value. Git and the session manager are injected,
 * which is what lets the rules below be tested without either.
 *
 * Every failure degrades to a wider scope and says so. A scope that silently
 * narrowed would return fewer hits and look like an answer.
 */

import { execFileSync } from "node:child_process";
import { type FileNode, familyRoot } from "./lineage.ts";

/** A resolved scope: what `search.ts` filters `files` by. */
export type ScopeFilter =
  | { kind: "all" }
  | { kind: "glob"; pattern: string }
  /** Directories, each matching itself and everything below it. */
  | { kind: "roots"; roots: string[] }
  /** Session file paths, matched exactly. */
  | { kind: "paths"; paths: string[] };

export interface ScopeDeps {
  cwd: string;
  /** The running session's file, when there is one. */
  sessionFile?: string;
  /** Called only by `lineage`, so no other scope pays for reading the table. */
  files(): readonly FileNode[];
  /** Every worktree root of the repository at `cwd`, or undefined if not a repo. */
  worktrees(cwd: string): string[] | undefined;
}

export interface ResolvedScope {
  filter: ScopeFilter;
  /** Set when the scope asked for could not be honoured as written. */
  note?: string;
}

/** `git worktree list --porcelain`: paragraphs whose first line names the root. */
export function parseWorktreeList(stdout: string): string[] {
  const roots: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length).trim());
  }
  return roots;
}

/**
 * Every worktree root of the repository at `cwd`, or undefined when `cwd` is
 * not in a repository — or when git is missing, slow, or unhappy, all of which
 * are the same thing to a caller that just wants to widen the scope back out.
 */
export function gitWorktrees(cwd: string): string[] | undefined {
  try {
    const stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const roots = parseWorktreeList(stdout);
    return roots.length > 0 ? roots : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reserved words are matched exactly, so any string carrying glob or path
 * syntax is unambiguously a glob. The cost is that a directory named literally
 * `repo` needs `**\/repo` — which is what a useful glob for it looks like
 * anyway, since a bare pattern is already prefix-matched.
 */
export function resolveScope(raw: string | undefined, deps: ScopeDeps): ResolvedScope {
  if (raw === undefined || raw === "all") return { filter: { kind: "all" } };

  if (raw === "project") return { filter: { kind: "roots", roots: [deps.cwd] } };

  if (raw === "repo") {
    const roots = deps.worktrees(deps.cwd);
    if (roots && roots.length > 0) return { filter: { kind: "roots", roots } };
    return {
      filter: { kind: "roots", roots: [deps.cwd] },
      note: `scope "repo": ${deps.cwd} is not a git repository; searched it as "project" instead.`,
    };
  }

  if (raw === "lineage") {
    if (!deps.sessionFile) {
      return {
        filter: { kind: "all" },
        note: 'scope "lineage": no running session to take a fork family from; searched the whole index.',
      };
    }
    const files = deps.files();
    const root = familyRoot(files, deps.sessionFile);
    const paths = files
      .map((file) => file.path)
      .filter((path) => familyRoot(files, path) === root)
      .sort();
    return { filter: { kind: "paths", paths: paths.length > 0 ? paths : [deps.sessionFile] } };
  }

  return { filter: { kind: "glob", pattern: raw } };
}
