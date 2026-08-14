/**
 * session-search — find a past conversation again.
 *
 * The one question this answers is *where is that conversation*, and it returns
 * enough to act on: a session id to open by hand, and a snippet the calling
 * agent can read further from. The user stays in the current session throughout.
 *
 * The index refreshes itself from file tails at query time — no daemon, no
 * background writer, no event hook. See `ingest.ts` for why files beat events.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SessionSearchConfigLoader, resolveConfigPaths } from "./config.ts";
import { getMeta, openIndex, resetIndex } from "./db.ts";
import { type RefreshStats, refreshIndex } from "./ingest.ts";
import { renderResults, renderTranscript } from "./render.ts";
import { type SearchParams, loadFileNodes, readEntries, resolveSession, searchIndex } from "./search.ts";
import { gitWorktrees, resolveScope } from "./scope.ts";
import type { ConfigSnapshot, SessionSearchConfig } from "./types.ts";

/** Cap on one `session_read`, in characters. */
const READ_CHAR_CAP = 8000;

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

interface SearchDetails {
  count?: number;
  backlogFiles?: number;
  path?: string;
}

function textResult(text: string, details: SearchDetails = {}): AgentToolResult<SearchDetails> {
  return { content: [{ type: "text", text }], details };
}

export default function sessionSearchExtension(pi: ExtensionAPI): void {
  let loader: SessionSearchConfigLoader | undefined;
  let snapshot: ConfigSnapshot | undefined;
  let db: DatabaseSync | undefined;
  let openedPath: string | undefined;
  let lastStats: RefreshStats | undefined;
  /** Set when a refresh could not run, so results can say what they omit. */
  let staleNote: string | undefined;

  const resolvedConfig = (ctx: ExtensionContext, config: SessionSearchConfig): SessionSearchConfig => ({
    ...config,
    dbPath: isAbsolute(config.dbPath) ? config.dbPath : resolve(ctx.cwd, config.dbPath),
    sessionsDir: isAbsolute(config.sessionsDir)
      ? config.sessionsDir
      : resolve(ctx.cwd, config.sessionsDir),
  });

  const loadConfig = async (ctx: ExtensionContext): Promise<SessionSearchConfig> => {
    if (!loader) {
      loader = new SessionSearchConfigLoader(
        resolveConfigPaths({
          envPath: process.env.PI_SESSION_SEARCH_CONFIG,
          startupCwd: ctx.cwd,
          agentDir: getAgentDir(),
          projectTrusted: ctx.isProjectTrusted(),
        }),
        getAgentDir(),
      );
    }
    snapshot = await loader.refresh();
    return resolvedConfig(ctx, snapshot.config);
  };

  /**
   * Everything a query needs: current config, an open index, and a refresh that
   * degrades rather than throwing when another pi process holds the write lock.
   */
  const withIndex = async <T>(
    ctx: ExtensionContext,
    run: (db: DatabaseSync, config: SessionSearchConfig) => T,
    options: { refresh?: boolean } = {},
  ): Promise<T> => {
    const config = await loadConfig(ctx);

    if (db && openedPath !== config.dbPath) {
      db.close();
      db = undefined;
    }
    if (!db) {
      db = openIndex(config.dbPath);
      openedPath = config.dbPath;
    }

    if (options.refresh !== false) {
      try {
        lastStats = refreshIndex(db, {
          sessionsDir: config.sessionsDir,
          budgetBytes: config.refreshBudgetBytes,
          includeThinking: config.includeThinking,
          excludeCwd: config.excludeCwd,
        });
        staleNote = undefined;
      } catch (cause) {
        // A search must never fail because another window is indexing.
        const since = getMeta(db, "last_refresh") ?? "an earlier run";
        staleNote =
          `Index busy (${cause instanceof Error ? cause.message : String(cause)}); ` +
          `not including sessions written since ${since}.`;
      }
    }

    return run(db, config);
  };

  const configNotes = (): string[] =>
    (snapshot?.errors ?? []).map((error) => `session-search: ${error.path}: ${error.message}`);

  pi.on("session_start", async (_event, ctx) => {
    await loadConfig(ctx);
  });

  pi.on("session_shutdown", async () => {
    db?.close();
    db = undefined;
    openedPath = undefined;
  });

  pi.registerTool({
    name: "session_search",
    label: "Session search",
    description: [
      "Find a past pi conversation across every project, session, and fork.",
      "",
      "Two surfaces are indexed:",
      "- what was SAID — `query` is an FTS5 expression over user and assistant prose,",
      "  compaction and branch summaries, session names, and labels. Double-quoted",
      '  phrases, AND/OR/NOT, and prefix* all work: `"session index" AND sqlite`.',
      "- what was DONE — `touched` globs a file path from tool evidence (narrow it with",
      '  action: "write" for "sessions where I changed this file"), and `command`',
      "  substring-matches a shell command that was run. Tool output is never indexed,",
      "  so search for the command, not for what it printed.",
      "",
      "At least one of `query`, `touched`, or `command` is required; the rest narrow.",
      "",
      "`scope` says WHERE to look, and defaults to every project. Use `project` for",
      '"here", `repo` for "this repository including its other worktrees", `lineage`',
      "for \"earlier in this conversation's fork family\", or pass a path glob such as",
      "`~/Develop/**` for anywhere else. A scope that cannot be honoured widens and",
      "says so in the result rather than quietly returning less.",
      "Each result gives a session id to open with `pi --resume`, an entry id, whether",
      "the hit sits on the session's main line or an abandoned side branch, and a",
      "snippet. Use session_read to expand one without leaving this session.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "FTS5 expression over prose" })),
      touched: Type.Optional(
        Type.String({ description: "Glob over a file path from tool evidence, e.g. **/auth.ts" }),
      ),
      action: Type.Optional(
        Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("any")], {
          description: "Narrows `touched` to how the file was used",
        }),
      ),
      command: Type.Optional(
        Type.String({ description: "Substring of a shell command that was run" }),
      ),
      scope: Type.Optional(
        Type.String({
          description:
            '"all" (default), "project", "repo", "lineage", or a glob over the session\'s working directory',
        }),
      ),
      after: Type.Optional(
        Type.String({ description: "ISO date, or relative shorthand such as 14d" }),
      ),
      before: Type.Optional(Type.String({ description: "ISO date, or relative shorthand" })),
      role: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("any")]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default 10" })),
    }),

    // A malformed FTS5 expression is thrown so pi reports it to the model with
    // isError, which is what lets the model correct its own syntax.
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return withIndex(ctx, (index, config) => {
        const requested = params as SearchParams & { scope?: string };
        const scope = resolveScope(requested.scope, {
          cwd: ctx.cwd,
          sessionFile: ctx.sessionManager?.getSessionFile() ?? undefined,
          files: () => loadFileNodes(index),
          worktrees: gitWorktrees,
        });
        const results = searchIndex(
          index,
          { ...requested, scope: scope.filter },
          { maxSnippetChars: config.maxSnippetChars },
        );
        const body = renderResults(results, {
          now: new Date(),
          home: homedir(),
          backlog:
            lastStats && lastStats.remainingFiles > 0
              ? { files: lastStats.remainingFiles, bytes: lastStats.remainingBytes }
              : undefined,
        });
        const notes = [
          ...configNotes(),
          ...(staleNote ? [staleNote] : []),
          ...(scope.note ? [scope.note] : []),
        ];
        return textResult([...notes, body].join("\n"), {
          count: results.length,
          backlogFiles: lastStats?.remainingFiles ?? 0,
        });
      });
    },
  });

  pi.registerTool({
    name: "session_read",
    label: "Session read",
    description: [
      "Expand a session_search hit without leaving the current session.",
      "",
      "Give `session` (a session id, an unambiguous id prefix, or a session file path)",
      "and one of:",
      "- `entry` plus `around` — that entry with N surrounding entries (default 10)",
      "- `branch` — a leaf entry id, returning that whole path from the root",
      "- `last` — the final N entries of the session",
      "",
      "Tool *outputs* are never stored or returned. `include_tools` adds tool names and",
      "their targets only, which is what keeps a long branch affordable to read.",
      "Output is capped; `offset` pages through it and truncation is stated.",
    ].join("\n"),
    parameters: Type.Object({
      session: Type.String({ description: "Session id, id prefix, or file path" }),
      entry: Type.Optional(Type.String({ description: "Entry id to centre on" })),
      around: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "Default 10" })),
      branch: Type.Optional(Type.String({ description: "Leaf entry id of a branch to read" })),
      last: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      include_tools: Type.Optional(Type.Boolean({ description: "Default false" })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const request = params as {
        session: string;
        entry?: string;
        around?: number;
        branch?: string;
        last?: number;
        include_tools?: boolean;
        offset?: number;
      };

      return withIndex(ctx, (index) => {
        const path = resolveSession(index, request.session);
        if (!path) {
          throw new Error(
            `No indexed session matches "${request.session}". ` +
              "Use the session id from session_search, or run /session-index if it may be unindexed.",
          );
        }

        const entries = request.entry
          ? readEntries(index, {
              path,
              mode: "around",
              entryId: request.entry,
              radius: request.around ?? 10,
            })
          : request.branch
            ? readEntries(index, { path, mode: "branch", leafId: request.branch })
            : readEntries(index, { path, mode: "last", count: request.last ?? 20 });

        if (entries.length === 0) {
          throw new Error(`Nothing to read in ${path} for that request.`);
        }

        return textResult(
          renderTranscript(entries, {
            includeTools: request.include_tools ?? false,
            maxChars: READ_CHAR_CAP,
            offset: request.offset ?? 0,
          }),
          { path },
        );
      });
    },
  });

  pi.registerCommand("session-index", {
    description: "Show session-search index status, or --rebuild it from scratch",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command !== "" && command !== "--rebuild") {
        ctx.ui.notify("Usage: /session-index [--rebuild]", "warning");
        return;
      }

      try {
        const text = await withIndex(
          ctx,
          (index, config) => {
            if (command === "--rebuild") {
              resetIndex(index);
              // A rebuild is the deliberate, unbudgeted pass: it exists to clear
              // whatever inline refresh left behind.
              lastStats = refreshIndex(index, {
                sessionsDir: config.sessionsDir,
                budgetBytes: Number.MAX_SAFE_INTEGER,
                includeThinking: config.includeThinking,
                excludeCwd: config.excludeCwd,
              });
            }
            return describeStatus(
              index,
              { dbPath: config.dbPath, sessionsDir: config.sessionsDir },
              lastStats,
            );
          },
          { refresh: command !== "--rebuild" },
        );
        ctx.ui.notify([...configNotes(), ...(staleNote ? [staleNote] : []), text].join("\n"), "info");
      } catch (cause) {
        ctx.ui.notify(
          `session-search: ${cause instanceof Error ? cause.message : String(cause)}`,
          "warning",
        );
      }
    },
  });
}
