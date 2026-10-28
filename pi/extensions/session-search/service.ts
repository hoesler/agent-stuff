/**
 * The three things session-search does — search, read, status — as plain
 * functions over an `Environment`, so the CLI and `/session-index` share one
 * path through config, index, and refresh.
 *
 * Each call opens the index, refreshes it from file tails, answers, and closes
 * it. A CLI is one call per process, and a steady-state refresh costs a `stat`
 * per file, so there is nothing a long-lived handle would save.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SessionSearchConfigLoader, resolveConfigPaths } from "./config.ts";
import { getMeta, openIndex, resetIndex } from "./db.ts";
import { type RefreshStats, refreshIndex } from "./ingest.ts";
import { renderAmbiguous, renderResults, renderTranscript } from "./render.ts";
import { type SearchParams, findSession, loadFileNodes, readEntries, searchIndex } from "./search.ts";
import { gitWorktrees, resolveScope } from "./scope.ts";
import type { SessionSearchConfig } from "./types.ts";

/** Cap on one read, in characters. */
export const READ_CHAR_CAP = 8000;

/** What a call needs from the world it runs in. */
export interface Environment {
  cwd: string;
  agentDir: string;
  /** The running session's file; `lineage` scope needs it. */
  sessionFile?: string;
  /** `PI_SESSION_SEARCH_CONFIG`, replacing the global config file. */
  configPath?: string;
}

export type SearchRequest = Omit<SearchParams, "scope"> & { scope?: string };

export type ReadRequest = {
  session: string;
  includeTools?: boolean;
  offset?: number;
} & (
  | { mode: "around"; entry: string; around?: number }
  | { mode: "branch"; branch: string }
  | { mode: "last"; last?: number }
);

export interface StatusPaths {
  dbPath: string;
  sessionsDir: string;
}

function count(db: DatabaseSync, sql: string): number {
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } catch {
    return 0;
  }
}

function sizeOf(path: string): string {
  try {
    const bytes = statSync(path).size;
    return bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "(not created yet)";
  }
}

export function describeStatus(
  db: DatabaseSync,
  paths: StatusPaths,
  stats?: RefreshStats,
): string {
  const lines = [
    `Sessions directory: ${paths.sessionsDir}`,
    `Index: ${paths.dbPath}`,
    `Files indexed: ${count(db, "SELECT count(*) AS n FROM files WHERE bytes_indexed > 0")}`,
    `Entries: ${count(db, "SELECT count(*) AS n FROM entries")}`,
    `Prose rows: ${count(db, "SELECT count(*) AS n FROM entries WHERE text IS NOT NULL")}`,
    `Evidence rows: ${count(db, "SELECT count(*) AS n FROM evidence")}`,
    `Index size: ${sizeOf(paths.dbPath)}`,
    `Skipped lines: ${getMeta(db, "skipped_lines") ?? "0"}`,
    `Last refresh: ${getMeta(db, "last_refresh") ?? "(never)"}`,
  ];
  if (stats) {
    lines.push(
      `This refresh: ${stats.filesIngested} files, ${stats.entriesInserted} new entries, ` +
        `${stats.bytesRead} bytes, ${stats.elapsedMs} ms`,
    );
    if (stats.remainingFiles > 0) {
      lines.push(`Backlog: ${stats.remainingFiles} files not yet indexed`);
    }
  }
  return lines.join("\n");
}

interface Opened {
  db: DatabaseSync;
  config: SessionSearchConfig;
  stats?: RefreshStats;
  /** Config errors and a busy index: what every answer must say it omits. */
  notes: string[];
}

/**
 * Everything a query needs: current config, an open index, and a refresh that
 * degrades rather than throwing when another pi process holds the write lock.
 */
async function withIndex<T>(
  env: Environment,
  run: (opened: Opened) => T,
  options: { refresh?: boolean } = {},
): Promise<T> {
  const loader = new SessionSearchConfigLoader(
    resolveConfigPaths({ envPath: env.configPath, cwd: env.cwd, agentDir: env.agentDir }),
    env.agentDir,
  );
  const snapshot = await loader.refresh();
  const config: SessionSearchConfig = {
    ...snapshot.config,
    dbPath: isAbsolute(snapshot.config.dbPath)
      ? snapshot.config.dbPath
      : resolve(env.cwd, snapshot.config.dbPath),
    sessionsDir: isAbsolute(snapshot.config.sessionsDir)
      ? snapshot.config.sessionsDir
      : resolve(env.cwd, snapshot.config.sessionsDir),
  };
  const notes = snapshot.errors.map((error) => `session-search: ${error.path}: ${error.message}`);

  const db = openIndex(config.dbPath);
  try {
    let stats: RefreshStats | undefined;
    if (options.refresh !== false) {
      try {
        stats = refreshIndex(db, {
          sessionsDir: config.sessionsDir,
          budgetBytes: config.refreshBudgetBytes,
          includeThinking: config.includeThinking,
          excludeCwd: config.excludeCwd,
        });
      } catch (cause) {
        // A search must never fail because another window is indexing.
        const since = getMeta(db, "last_refresh") ?? "an earlier run";
        notes.push(
          `Index busy (${cause instanceof Error ? cause.message : String(cause)}); ` +
            `not including sessions written since ${since}.`,
        );
      }
    }
    return run({ db, config, stats, notes });
  } finally {
    db.close();
  }
}

/**
 * A malformed FTS5 expression or a missing search term is thrown, so the CLI
 * reports it on stderr with a failing exit — which is what lets the agent
 * correct its own syntax.
 */
export async function search(
  env: Environment,
  request: SearchRequest,
): Promise<{ text: string; count: number }> {
  return withIndex(env, ({ db, config, stats, notes }) => {
    const scope = resolveScope(request.scope, {
      cwd: env.cwd,
      sessionFile: env.sessionFile,
      files: () => loadFileNodes(db),
      worktrees: gitWorktrees,
    });
    const results = searchIndex(
      db,
      { ...request, scope: scope.filter },
      { maxSnippetChars: config.maxSnippetChars },
    );
    const body = renderResults(results, {
      now: new Date(),
      home: homedir(),
      backlog:
        stats && stats.remainingFiles > 0
          ? { files: stats.remainingFiles, bytes: stats.remainingBytes }
          : undefined,
    });
    const text = [...notes, ...(scope.note ? [scope.note] : []), body].join("\n");
    return { text, count: results.length };
  });
}

export async function read(
  env: Environment,
  request: ReadRequest,
): Promise<{ text: string; path: string }> {
  return withIndex(env, ({ db, notes }) => {
    const match = findSession(db, request.session);
    if (match.kind === "ambiguous") {
      throw new Error(renderAmbiguous(request.session, match.total, match.candidates, homedir()));
    }
    if (match.kind === "none") {
      throw new Error(
        `No indexed session matches "${request.session}". ` +
          "Use the session id from a search, or run `status` if it may be unindexed.",
      );
    }
    const { path } = match;

    const entries =
      request.mode === "around"
        ? readEntries(db, { path, mode: "around", entryId: request.entry, radius: request.around ?? 10 })
        : request.mode === "branch"
          ? readEntries(db, { path, mode: "branch", leafId: request.branch })
          : readEntries(db, { path, mode: "last", count: request.last ?? 20 });

    if (entries.length === 0) {
      throw new Error(`Nothing to read in ${path} for that request.`);
    }

    const transcript = renderTranscript(entries, {
      includeTools: request.includeTools ?? false,
      maxChars: READ_CHAR_CAP,
      offset: request.offset ?? 0,
    });
    return { text: [...notes, transcript].join("\n"), path };
  });
}

/**
 * Coverage of the index. `rebuild` drops it and reingests without a byte
 * budget: the deliberate pass that clears whatever inline refresh left behind.
 */
export async function status(env: Environment, options: { rebuild?: boolean } = {}): Promise<string> {
  return withIndex(
    env,
    ({ db, config, stats, notes }) => {
      let refreshed = stats;
      if (options.rebuild) {
        resetIndex(db);
        refreshed = refreshIndex(db, {
          sessionsDir: config.sessionsDir,
          budgetBytes: Number.MAX_SAFE_INTEGER,
          includeThinking: config.includeThinking,
          excludeCwd: config.excludeCwd,
        });
      }
      const text = describeStatus(db, { dbPath: config.dbPath, sessionsDir: config.sessionsDir }, refreshed);
      return [...notes, text].join("\n");
    },
    { refresh: !options.rebuild },
  );
}
