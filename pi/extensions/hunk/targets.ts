/**
 * What a review is pointed at. `raw` is what the user typed: Hunk owns that
 * grammar, so it is forwarded unparsed and an invalid target fails in Hunk with
 * Hunk's own message.
 */
export type Target =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "baseBranch"; branch: string }
  | { kind: "commit"; sha: string }
  | { kind: "raw"; tokens: string[] };

export type PresetValue = "workingTree" | "staged" | "baseBranch" | "commit";

export interface PickerItem {
  value: PresetValue;
  label: string;
  description: string;
}

/** Keep this order stable: the picker's smart default is chosen by value. */
export const TARGET_PRESETS: readonly PickerItem[] = [
  { value: "workingTree", label: "Review the working tree", description: "" },
  { value: "staged", label: "Review staged changes", description: "--staged" },
  { value: "baseBranch", label: "Review against a base branch", description: "(local)" },
  { value: "commit", label: "Review a commit", description: "" },
];

export function rawTarget(tokens: string[]): Target {
  return { kind: "raw", tokens };
}

const HUNK_COMMANDS = new Set(["diff", "show"]);

/** Arguments for `hunk <these>`, and equally for `session reload -- <these>`. */
export function targetArgs(target: Target): string[] {
  switch (target.kind) {
    case "workingTree":
      return ["diff"];
    case "staged":
      return ["diff", "--staged"];
    case "baseBranch":
      return ["diff", `${target.branch}...HEAD`];
    case "commit":
      return ["show", target.sha];
    case "raw":
      return HUNK_COMMANDS.has(target.tokens[0] ?? "") ? [...target.tokens] : ["diff", ...target.tokens];
  }
}

export function targetLabel(target: Target): string {
  switch (target.kind) {
    case "workingTree":
      return "working tree";
    case "staged":
      return "staged changes";
    case "baseBranch":
      return `${target.branch}...HEAD`;
    case "commit":
      return `commit ${target.sha}`;
    case "raw":
      return target.tokens.join(" ");
  }
}

/** The same reasoning `/review` applies: review what is uncommitted if there is any. */
export function smartDefaultValue(dirty: boolean): PresetValue {
  return dirty ? "workingTree" : "baseBranch";
}
