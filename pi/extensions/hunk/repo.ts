import type { Exec } from "./cli.ts";

/**
 * What the menu needs to know about the repository before it can offer
 * anything. Every fact here either decides whether a row is worth showing or
 * fills in the count that makes it worth choosing, so they are read together,
 * once, rather than discovered one picker at a time.
 */
export interface RepoFacts {
  /** Changed files in the working tree. */
  uncommitted: number;
  /** Files in the index. */
  staged: number;
  /** The branch this one forked from, and how far it has moved. */
  base?: { branch: string; changed: number };
  /** Local branches, most recently committed first, never the current one. */
  branches: string[];
  commits: Array<{ sha: string; title: string }>;
}

const NO_COMMITS_YET = "No commits yet on ";

/**
 * `--porcelain -b` so one call answers both questions. The header is stable
 * output; the shapes that are not a branch name are `HEAD (no branch)` when
 * detached and `No commits yet on <branch>` before the first commit.
 */
export function parseStatus(stdout: string): { branch: string | undefined; changed: number } {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const header = lines[0]?.startsWith("## ") ? lines[0].slice(3) : undefined;
  const changed = lines.filter((line) => !line.startsWith("## ")).length;
  if (!header || header.startsWith("HEAD (")) return { branch: undefined, changed };
  const named = header.startsWith(NO_COMMITS_YET) ? header.slice(NO_COMMITS_YET.length) : header;
  return { branch: named.split("...")[0] || undefined, changed };
}

/** `--name-only` output, counted. A blank line is not a file. */
export function countLines(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/** `origin/main` as git reports the remote's head, named without its remote. */
export function parseDefaultBranch(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function parseBranches(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function parseCommits(stdout: string): Array<{ sha: string; title: string }> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab === -1 ? undefined : { sha: line.slice(0, tab), title: line.slice(tab + 1) };
    })
    .filter((commit): commit is { sha: string; title: string } => commit !== undefined && commit.sha.length > 0);
}

/**
 * Which ref the branch row compares against. A base that is the branch you are
 * on is no base at all — the same reason the branch picker has never offered
 * the current branch — and a detected default with no local branch is reached
 * through its remote-tracking ref rather than dropped.
 */
export function chooseBase(options: {
  detected: string | undefined;
  branches: string[];
  current: string | undefined;
}): string | undefined {
  const { detected, branches, current } = options;
  if (detected) {
    if (detected === current) return undefined;
    return branches.includes(detected) ? detected : `origin/${detected}`;
  }
  return ["main", "master"].find((name) => name !== current && branches.includes(name));
}

export interface RepoDeps {
  exec: Exec;
}

/** Output only where the call succeeded, so a failure costs its own fact alone. */
async function read(deps: RepoDeps, cwd: string, args: string[]): Promise<string> {
  try {
    const result = await deps.exec("git", args, { cwd });
    return result.code === 0 ? result.stdout : "";
  } catch {
    return "";
  }
}

export async function repoFacts(deps: RepoDeps, cwd: string): Promise<RepoFacts> {
  const [status, staged, defaultBranch, branches, commits] = await Promise.all([
    read(deps, cwd, ["status", "--porcelain", "-b"]),
    read(deps, cwd, ["diff", "--cached", "--name-only"]),
    read(deps, cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    read(deps, cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
    read(deps, cwd, ["log", "-n", "15", "--format=%h%x09%s"]),
  ]);

  const { branch: current, changed: uncommitted } = parseStatus(status);
  const local = parseBranches(branches);
  const base = chooseBase({ detected: parseDefaultBranch(defaultBranch), branches: local, current });

  return {
    uncommitted,
    staged: countLines(staged),
    // Only now, and only when there is something to compare against: the
    // count costs a diff of the whole branch.
    base: base
      ? { branch: base, changed: countLines(await read(deps, cwd, ["diff", "--name-only", `${base}...HEAD`])) }
      : undefined,
    branches: local.filter((name) => name !== current),
    commits: parseCommits(commits),
  };
}
