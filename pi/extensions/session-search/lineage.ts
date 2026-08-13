/**
 * Fork families over `files.parent_path`, which forms a forest.
 *
 * Both fork paths in pi's SessionManager — `forkFrom` and
 * `createBranchedSession` — copy entries verbatim and preserve `entry_id`, so
 * the same id in five files is one moment, not five hits. Collapsing on
 * `entry_id` is therefore an equality check: no similarity scoring, no
 * threshold to tune.
 *
 * The canonical hit is the oldest file containing the entry, where the moment
 * happened; its descendants are listed as continuations. The ancestor says what
 * was said, the descendants say where the work went next, and the user picks
 * which to open.
 */

export interface FileNode {
  path: string;
  parentPath: string | null;
  created: string | undefined;
}

export interface Candidate {
  path: string;
  created: string | undefined;
}

/**
 * Walk up to the root of the fork family. A forked-from session whose file is
 * gone still anchors its own family, and a cycle stops at the first repeat.
 */
export function familyRoot(files: readonly FileNode[], path: string): string {
  const parents = new Map<string, string | null>();
  for (const file of files) parents.set(file.path, file.parentPath);

  const seen = new Set<string>([path]);
  let current = path;
  for (;;) {
    const parent = parents.get(current);
    if (!parent || !parents.has(parent) || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

/** Group paths by their family root, preserving input order within a group. */
export function groupByFamily(
  files: readonly FileNode[],
  paths: readonly string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const root = familyRoot(files, path);
    const bucket = groups.get(root);
    if (bucket) bucket.push(path);
    else groups.set(root, [path]);
  }
  return groups;
}

export interface OriginChoice {
  origin: Candidate;
  continuations: Candidate[];
}

/** Oldest first, ties broken on path so the choice is stable between calls. */
export function chooseOrigin(candidates: readonly Candidate[]): OriginChoice {
  const sorted = [...candidates].sort((a, b) => {
    const left = a.created ?? "";
    const right = b.created ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return { origin: sorted[0], continuations: sorted.slice(1) };
}
