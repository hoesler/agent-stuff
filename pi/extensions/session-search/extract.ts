/**
 * One raw JSONL entry to one index row.
 *
 * Entries are read structurally rather than through pi's session types, so this
 * module stays free of pi imports and testable with plain object literals — the
 * approach `session-title/transcript.ts` already takes.
 *
 * Two rules carry the design:
 *
 * 1. Every entry with an id produces a row, even when it has no prose. Branch
 *    resolution walks `parentId` to the root, so a skipped tool result would
 *    break the chain and misplace a hit on the wrong branch.
 * 2. Tool *results*, bash *output*, and image data are never prose. They are
 *    most of the corpus by bytes and none of it by recall value: indexing them
 *    would make a search for `auth.ts` match every session that ever read a
 *    file mentioning it.
 */

export type Action = "read" | "write" | "run" | "other";

export interface EvidenceRow {
  tool: string;
  action: Action;
  target: string | undefined;
}

export interface ExtractedEntry {
  entryId: string;
  parentId: string | null;
  kind: string;
  role: string | undefined;
  ts: string | undefined;
  text: string | undefined;
  evidence: EvidenceRow[];
}

export interface SessionHeaderRow {
  sessionId: string;
  created: string | undefined;
  cwd: string | undefined;
  parentPath: string | undefined;
}

export interface ExtractOptions {
  includeThinking: boolean;
}

const READ_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "ls",
  "tree",
  "search",
  "webfetch",
  "web_search",
]);

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "multi_edit",
  "patch",
  "apply_patch",
  "create",
  "delete",
  "move",
]);

/**
 * Read and write are recorded separately because "sessions where I modified
 * auth.ts" is far more selective than "sessions where that file appeared".
 */
export function toolAction(name: string): Action {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "run") return "run";
  if (WRITE_TOOLS.has(lower)) return "write";
  if (READ_TOOLS.has(lower)) return "read";
  return "other";
}

const TARGET_KEYS = ["file_path", "path", "filePath", "command", "pattern", "query", "url"];

export function toolTarget(_name: string, args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Pull prose out of message content that may be a string or a block array. */
function blockText(content: unknown, includeThinking: boolean): string | undefined {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (includeThinking && block?.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return clean(parts.join(" "));
}

function clean(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? clean(value) : undefined;
}

function toolCallEvidence(content: unknown): EvidenceRow[] {
  if (!Array.isArray(content)) return [];
  const rows: EvidenceRow[] = [];
  for (const block of content as any[]) {
    if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
    rows.push({
      tool: block.name,
      action: toolAction(block.name),
      target: toolTarget(block.name, block.arguments),
    });
  }
  return rows;
}

/** The `type: "session"` first line of a session file. */
export function extractHeader(raw: unknown): SessionHeaderRow | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type !== "session" || typeof record.id !== "string") return undefined;
  return {
    sessionId: record.id,
    created: typeof record.timestamp === "string" ? record.timestamp : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    parentPath: typeof record.parentSession === "string" ? record.parentSession : undefined,
  };
}

export function extractEntry(raw: unknown, options: ExtractOptions): ExtractedEntry | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string") return undefined;
  if (record.type === "session") return undefined;

  const message = (record.message ?? undefined) as Record<string, unknown> | undefined;
  const role = record.type === "message" && typeof message?.role === "string" ? message.role : undefined;

  let text: string | undefined;
  let evidence: EvidenceRow[] = [];

  switch (record.type) {
    case "message":
      if (role === "user" || role === "assistant") {
        text = blockText(message?.content, options.includeThinking && role === "assistant");
      }
      if (role === "assistant") evidence = toolCallEvidence(message?.content);
      else if (role === "bashExecution" && typeof message?.command === "string") {
        // Commands are searchable, their output is not: "the session where I ran
        // the migration" works without ingesting a megabyte of migration logs.
        evidence = [{ tool: "bash", action: "run", target: message.command }];
      }
      break;
    case "compaction":
    case "branch_summary":
      text = stringField(record.summary);
      break;
    case "session_info":
      text = stringField(record.name);
      break;
    case "label":
      text = stringField(record.label);
      break;
    default:
      break;
  }

  return {
    entryId: record.id,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    kind: record.type,
    role,
    ts: typeof record.timestamp === "string" ? record.timestamp : undefined,
    text,
    evidence,
  };
}
