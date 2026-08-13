/**
 * Following files, not events.
 *
 * An in-process writer hooked to message events sees only its own session. With
 * many project directories and several pi windows open at once, every session
 * written elsewhere would stay invisible until the user remembered to backfill.
 * The filesystem is the shared channel that events are not.
 */

import { type Dirent, closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SessionFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface StoredState {
  size: number;
  mtimeMs: number;
  bytesIndexed: number;
}

export interface FilePlan {
  kind: "unchanged" | "new" | "grown" | "rewritten";
  /** Byte offset to start reading from. */
  from: number;
}

/**
 * Sessions live one directory deep: `<sessionsDir>/<encoded-cwd>/<id>.jsonl`.
 * Walking with `stat` only keeps this well under 100 ms for a few hundred files.
 */
export function listSessionFiles(sessionsDir: string): SessionFile[] {
  const files: SessionFile[] = [];

  const collect = (dir: string) => {
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = statSync(path);
        files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // A session removed between readdir and stat is simply not indexed.
      }
    }
  };

  collect(sessionsDir);
  return files;
}

/**
 * A file that shrank, or whose stored offset exceeds its current size, was
 * rewritten. Everything else that changed is a tail read.
 *
 * Misjudging this costs speed and never correctness: `entries` is keyed
 * `UNIQUE(path, entry_id)` and ingest uses `ON CONFLICT DO NOTHING`, so a
 * misjudged rewrite degrades to writing rows that already exist.
 */
export function planFile(stored: StoredState | undefined, current: SessionFile): FilePlan {
  if (!stored) return { kind: "new", from: 0 };
  if (current.size < stored.size || current.size < stored.bytesIndexed) {
    return { kind: "rewritten", from: 0 };
  }
  if (current.size === stored.size && current.mtimeMs === stored.mtimeMs) {
    return { kind: "unchanged", from: stored.bytesIndexed };
  }
  return { kind: "grown", from: stored.bytesIndexed };
}

export interface TailRead {
  lines: string[];
  nextOffset: number;
}

/**
 * Read whole lines from `from` to EOF, advancing the offset only to the last
 * newline. A partially written trailing line is left for the next pass, which
 * is what makes it safe to index a session another pi process is writing right
 * now.
 */
export function readLines(path: string, from: number): TailRead {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return { lines: [], nextOffset: from };
  }

  try {
    const size = statSync(path).size;
    if (size <= from) return { lines: [], nextOffset: from };

    const buffer = Buffer.allocUnsafe(size - from);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(handle, buffer, filled, buffer.length - filled, from + filled);
      if (read <= 0) break;
      filled += read;
    }

    const chunk = buffer.subarray(0, filled);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], nextOffset: from };

    const complete = chunk.subarray(0, lastNewline + 1).toString("utf8");
    return {
      lines: complete.split("\n").filter((line) => line.length > 0),
      nextOffset: from + lastNewline + 1,
    };
  } catch {
    return { lines: [], nextOffset: from };
  } finally {
    closeSync(handle);
  }
}

/** Whether a stored offset still lands on a record boundary. */
export function endsOnNewline(path: string, offset: number): boolean {
  if (offset <= 0) return true;
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(1);
    const read = readSync(handle, buffer, 0, 1, offset - 1);
    return read === 1 && buffer[0] === 0x0a;
  } catch {
    return false;
  } finally {
    closeSync(handle);
  }
}
