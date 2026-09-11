import type { SelectItem } from "@earendil-works/pi-tui";
import type { RepoFacts } from "./repo.ts";
import type { Target } from "./targets.ts";

/**
 * What choosing a row means. The two `pick…` arms need a second question
 * before there is a target; the rest are ready to act on.
 */
export type MenuChoice =
  | { kind: "notes" }
  | { kind: "target"; target: Target }
  | { kind: "pickCommit" }
  | { kind: "pickBranch" };

export interface MenuRow {
  item: SelectItem;
  choice: MenuChoice;
}

export interface MenuState {
  facts: RepoFacts;
  /** Pending notes in the live window. */
  notes: number;
  /** Why there is no notes row, when there is none. */
  notesReason?: string;
}

/** What a row may be asked to do. The menu offers both; the two explicit forms offer one. */
export type MenuAction = "review" | "open";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Only rows that would show something. A changeset with no files in it is not
 * worth offering, since the window would open on an empty diff, and the dim
 * line explains any absence the counts do not already account for.
 *
 * The order is what makes the cursor's resting place on the first row the
 * likeliest choice: notes when there are notes, then the working tree.
 */
export function menuRows(state: MenuState): MenuRow[] {
  const { facts } = state;
  const rows: MenuRow[] = [];

  if (state.notes > 0) {
    rows.push({
      item: {
        value: "notes",
        label: `${plural(state.notes, "note")} you left in Hunk`,
        description: "reply to each, mark them handled",
      },
      choice: { kind: "notes" },
    });
  }

  if (facts.uncommitted > 0) {
    rows.push({
      item: {
        value: "uncommitted",
        label: "Uncommitted changes",
        description: `${plural(facts.uncommitted, "file")} · hunk diff`,
      },
      choice: { kind: "target", target: { kind: "workingTree" } },
    });
  }

  if (facts.staged > 0) {
    rows.push({
      item: {
        value: "staged",
        label: "Staged changes only",
        description: `${plural(facts.staged, "file")} · hunk diff --staged`,
      },
      choice: { kind: "target", target: { kind: "staged" } },
    });
  }

  if (facts.base && facts.base.changed > 0) {
    const { branch, changed } = facts.base;
    rows.push({
      item: {
        value: "base",
        label: `This branch vs ${branch}`,
        description: `${plural(changed, "file")} · hunk diff ${branch}...HEAD`,
      },
      choice: { kind: "target", target: { kind: "baseBranch", branch } },
    });
  }

  if (facts.commits.length > 0) {
    rows.push({
      item: { value: "commit", label: "A commit…", description: `choose from the last ${facts.commits.length}` },
      choice: { kind: "pickCommit" },
    });
  }

  if (facts.branches.length > 0) {
    rows.push({
      item: { value: "branch", label: "Another branch…", description: "choose what to compare against" },
      choice: { kind: "pickBranch" },
    });
  }

  return rows;
}

/**
 * What is missing and why, said once under the rows. A reason is never
 * reworded — Hunk's own messages carry meaning its skill maps to causes — but
 * a full stop is dropped, because these are fragments in a list and the ones
 * that arrive as sentences would otherwise punctuate mid-line.
 */
export function menuNote(state: MenuState): string | undefined {
  const reasons: string[] = [];
  if (state.notes === 0 && state.notesReason) reasons.push(state.notesReason.replace(/\.$/, ""));
  if (state.facts.uncommitted === 0 && state.facts.staged === 0) reasons.push("nothing uncommitted or staged");
  return reasons.length > 0 ? reasons.join(" · ") : undefined;
}

export function menuFooter(value: string, allowed: readonly MenuAction[]): string {
  if (value === "notes") return "enter to address these notes · esc to cancel";
  const verbs: string[] = [];
  if (allowed.includes("review")) verbs.push("enter to review with the agent");
  if (allowed.includes("open")) verbs.push(allowed.includes("review") ? "o to open it yourself" : "enter to open it in Hunk");
  return [...verbs, "esc to cancel"].join(" · ");
}

export function menuChoice(rows: MenuRow[], value: string): MenuChoice | undefined {
  return rows.find((row) => row.item.value === value)?.choice;
}
