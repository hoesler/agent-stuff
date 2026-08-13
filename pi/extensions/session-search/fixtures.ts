/**
 * A fixture generator that writes real session JSONL into a temporary
 * directory. `node:sqlite` makes real databases cheap in tests, so nothing in
 * the stateful half is mocked: ingest reads the same bytes pi writes.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FixtureEntry {
  id: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string;
  role?: "user" | "assistant";
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  toolResult?: { toolName: string; text: string };
  bash?: { command: string; output: string };
  summary?: string;
  name?: string;
  label?: string;
}

export interface FixtureSession {
  /** Relative to the sessions root, e.g. `--work-repo--/a.jsonl`. */
  path: string;
  id: string;
  cwd: string;
  created?: string;
  parentSession?: string;
  entries: FixtureEntry[];
}

const BASE_TIME = Date.parse("2026-08-01T10:00:00.000Z");

function timestampFor(entry: FixtureEntry, index: number): string {
  return entry.timestamp ?? new Date(BASE_TIME + index * 60_000).toISOString();
}

/** Serialize one fixture entry into the JSONL shape pi writes. */
export function entryLine(entry: FixtureEntry, index = 0): string {
  const base = {
    id: entry.id,
    parentId: entry.parentId ?? null,
    timestamp: timestampFor(entry, index),
  };

  if (entry.type === "compaction") {
    return JSON.stringify({ ...base, type: "compaction", summary: entry.summary, firstKeptEntryId: "e0" });
  }
  if (entry.type === "branch_summary") {
    return JSON.stringify({ ...base, type: "branch_summary", fromId: "e0", summary: entry.summary });
  }
  if (entry.type === "session_info" || entry.name !== undefined) {
    return JSON.stringify({ ...base, type: "session_info", name: entry.name });
  }
  if (entry.type === "label" || entry.label !== undefined) {
    return JSON.stringify({ ...base, type: "label", targetId: "e0", label: entry.label });
  }
  if (entry.toolResult) {
    return JSON.stringify({
      ...base,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "t0",
        toolName: entry.toolResult.toolName,
        content: [{ type: "text", text: entry.toolResult.text }],
        isError: false,
        timestamp: Date.parse(base.timestamp),
      },
    });
  }
  if (entry.bash) {
    return JSON.stringify({
      ...base,
      type: "message",
      message: {
        role: "bashExecution",
        command: entry.bash.command,
        output: entry.bash.output,
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: Date.parse(base.timestamp),
      },
    });
  }

  const role = entry.role ?? "assistant";
  const content: Record<string, unknown>[] = [];
  if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking });
  if (entry.text) content.push({ type: "text", text: entry.text });
  for (const call of entry.toolCalls ?? []) {
    content.push({ type: "toolCall", id: `t-${call.name}`, name: call.name, arguments: call.arguments });
  }

  return JSON.stringify({
    ...base,
    type: entry.type ?? "message",
    message: { role, content, timestamp: Date.parse(base.timestamp) },
  });
}

function headerLine(session: FixtureSession): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: session.id,
    timestamp: session.created ?? new Date(BASE_TIME).toISOString(),
    cwd: session.cwd,
    ...(session.parentSession ? { parentSession: session.parentSession } : {}),
  });
}

/** Write a session file, creating its project directory. Returns the path. */
export function writeSession(root: string, session: FixtureSession): string {
  const path = join(root, session.path);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [headerLine(session), ...session.entries.map((entry, index) => entryLine(entry, index))];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** Append entries to an existing fixture, as a live pi process would. */
export function appendEntries(path: string, entries: FixtureEntry[]): void {
  if (entries.length === 0) {
    appendFileSync(path, "\n");
    return;
  }
  appendFileSync(path, `${entries.map((entry, index) => entryLine(entry, index)).join("\n")}\n`);
}

/** Append a line without its trailing newline, as a half-written record. */
export function appendPartial(path: string, entry: FixtureEntry): void {
  appendFileSync(path, entryLine(entry));
}
