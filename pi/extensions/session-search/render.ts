/**
 * Result and transcript formatting.
 *
 * Both tools are written against an agent's context budget, since every result
 * competes with the user's actual work for room. A result gives an id to open
 * by hand and a snippet the calling agent can decide from — nothing more.
 */

import type { SearchResult } from "./search.ts";
import type { TranscriptEntry } from "./search.ts";

export interface RenderOptions {
  now: Date;
  home: string;
  backlog?: { files: number; bytes: number };
}

export interface TranscriptOptions {
  includeTools: boolean;
  maxChars: number;
  offset: number;
}

export function shortId(id: string): string {
  return id.length > 6 ? id.slice(0, 6) : id;
}

function abbreviate(path: string | undefined, home: string): string {
  if (!path) return "(unknown cwd)";
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

export function relativeTime(ts: string, now: Date): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return "unknown";
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return plural(days, "day");
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return plural(weeks, "week");
  const months = Math.floor(days / 30);
  if (months < 12) return plural(months, "month");
  return plural(Math.floor(days / 365), "year");
}

function dayOf(ts: string | undefined): string {
  return ts ? ts.slice(0, 10) : "(undated)";
}

function branchLine(result: SearchResult): string | undefined {
  const parts: string[] = [];
  if (!result.branch.onMainLine) {
    const diverged = result.branch.divergedAt ? result.branch.divergedAt.slice(5, 10) : "?";
    parts.push(
      `side branch, diverged ${diverged}, ran ${result.branch.entriesPastDivergence} more ` +
        `${result.branch.entriesPastDivergence === 1 ? "entry" : "entries"}`,
    );
  }
  if (result.continuations.length > 0) {
    parts.push(
      `also in ${result.continuations.length} fork${result.continuations.length === 1 ? "" : "s"}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function renderResults(results: readonly SearchResult[], options: RenderOptions): string {
  const lines: string[] = [];

  if (results.length === 0) lines.push("No matching sessions.");

  results.forEach((result, index) => {
    lines.push(`${index + 1}. "${result.name ?? "(unnamed)"}"   ${abbreviate(result.cwd, options.home)}`);
    const when = result.ts
      ? `${dayOf(result.ts)} (${relativeTime(result.ts, options.now)})`
      : "(undated)";
    lines.push(
      `   ${when} · session ${shortId(result.sessionId)} · entry ${result.entryId}`,
    );
    const branch = branchLine(result);
    if (branch) lines.push(`   ${branch}`);
    if (result.snippet) lines.push(`   …${result.snippet}…`);
    lines.push("");
  });

  if (options.backlog && options.backlog.files > 0) {
    // Partial coverage that says it is partial beats a hang or a silent omission.
    lines.push(
      `Note: ${options.backlog.files} files (${formatBytes(options.backlog.bytes)}) are not indexed yet — ` +
        "run /session-index to finish them.",
    );
  }

  return lines.join("\n").trimEnd();
}

function speaker(entry: TranscriptEntry): string {
  if (entry.kind !== "message") return entry.kind;
  return entry.role ?? "message";
}

export function renderTranscript(
  entries: readonly TranscriptEntry[],
  options: TranscriptOptions,
): string {
  const window = entries.slice(options.offset);
  const lines: string[] = [];
  let used = 0;
  let rendered = 0;

  for (const entry of window) {
    const block: string[] = [];
    if (entry.text) block.push(`${speaker(entry)}: ${entry.text}`);
    if (options.includeTools) {
      // Tool names and targets, never their outputs. That is what keeps a
      // 200-entry branch renderable as dialogue rather than as the megabytes of
      // file contents the dialogue was about.
      for (const item of entry.evidence) {
        block.push(`  → ${item.tool} ${item.target ?? ""}`.trimEnd());
      }
    }
    if (block.length === 0) continue;

    const text = block.join("\n");
    if (used + text.length > options.maxChars && rendered > 0) break;
    lines.push(text);
    used += text.length + 1;
    rendered += 1;
  }

  const consumed = options.offset + rendered;
  if (consumed < entries.length) {
    lines.push(
      `… truncated at entry ${consumed} of ${entries.length} — call again with offset: ${consumed} to continue.`,
    );
  }

  return lines.join("\n");
}
