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

/** Copies the tokens, so a caller reusing its parse buffer cannot mutate a stored target. */
export function rawTarget(tokens: string[]): Target {
  return { kind: "raw", tokens: [...tokens] };
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
