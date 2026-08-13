/**
 * Branch resolution over a session's `(id, parentId, ts)` skeleton.
 *
 * This is what neither ripgrep nor a session-level index can do. A line match
 * tells you which file holds the text, not which branch — and the branch is
 * what the user is looking for.
 *
 * The main line is the path from the chronologically last entry back to the
 * root: that is the branch a resume lands on, which makes it the meaningful
 * default. Branch identity is the leaf entry id, never an ordinal — ordinals
 * renumber when a new branch diverges earlier, and an identifier that changes
 * between being read and being used is worse than none.
 */

export interface Skeleton {
  id: string;
  parentId: string | null;
  ts: string | undefined;
}

export interface BranchInfo {
  onMainLine: boolean;
  /** Leaf of the branch the entry sits on — the branch's stable identity. */
  leafId: string;
  /** Timestamp of the first entry off the main line, for a side-branch hit. */
  divergedAt: string | undefined;
  /** Entries from the divergence point to the branch leaf, inclusive. */
  entriesPastDivergence: number;
}

function index(skeleton: readonly Skeleton[]): Map<string, Skeleton> {
  const byId = new Map<string, Skeleton>();
  for (const node of skeleton) byId.set(node.id, node);
  return byId;
}

function childrenOf(skeleton: readonly Skeleton[]): Map<string, Skeleton[]> {
  const children = new Map<string, Skeleton[]>();
  for (const node of skeleton) {
    if (node.parentId === null) continue;
    const bucket = children.get(node.parentId);
    if (bucket) bucket.push(node);
    else children.set(node.parentId, [node]);
  }
  return children;
}

/** Root-first path from an entry to its root, stopping at a cycle or a gap. */
export function pathToRoot(byId: Map<string, Skeleton>, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: Skeleton | undefined = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}

function latest(nodes: readonly Skeleton[]): Skeleton | undefined {
  let best: Skeleton | undefined;
  for (const node of nodes) {
    // Ties break on the later position in the array, which is file order.
    if (!best || (node.ts ?? "") >= (best.ts ?? "")) best = node;
  }
  return best;
}

/** The path a resume lands on: from the chronologically last entry to the root. */
export function mainLine(skeleton: readonly Skeleton[]): string[] {
  const last = latest(skeleton);
  if (!last) return [];
  return pathToRoot(index(skeleton), last.id);
}

/** Descend to the leaf of the branch an entry sits on, taking the newest child. */
function descend(children: Map<string, Skeleton[]>, from: string): string[] {
  const walked = [from];
  const seen = new Set<string>([from]);
  let current = from;
  for (;;) {
    const next = latest(children.get(current) ?? []);
    if (!next || seen.has(next.id)) return walked;
    seen.add(next.id);
    walked.push(next.id);
    current = next.id;
  }
}

export function classifyEntry(skeleton: readonly Skeleton[], entryId: string): BranchInfo {
  const byId = index(skeleton);
  if (!byId.has(entryId)) {
    return { onMainLine: false, leafId: entryId, divergedAt: undefined, entriesPastDivergence: 0 };
  }

  const line = mainLine(skeleton);
  const main = new Set(line);
  if (main.has(entryId)) {
    return {
      onMainLine: true,
      leafId: line[line.length - 1] ?? entryId,
      divergedAt: undefined,
      entriesPastDivergence: 0,
    };
  }

  const children = childrenOf(skeleton);
  const toEntry = pathToRoot(byId, entryId);
  const divergence = toEntry.find((id) => !main.has(id)) ?? entryId;
  const branch = descend(children, divergence);

  return {
    onMainLine: false,
    leafId: branch[branch.length - 1],
    divergedAt: byId.get(divergence)?.ts,
    entriesPastDivergence: branch.length,
  };
}
