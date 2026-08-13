/**
 * Query construction, filtering, grouping, and ranking.
 *
 * Two surfaces are searchable, matching how a session is actually recalled:
 * what was said (the FTS5 prose index) and what was done (the evidence table).
 */

import type { DatabaseSync } from "node:sqlite";
import type { EvidenceRow } from "./extract.ts";
import { matchesGlob } from "./ingest.ts";
import { type Candidate, type FileNode, chooseOrigin, familyRoot } from "./lineage.ts";
import { type BranchInfo, type Skeleton, classifyEntry, pathToRoot } from "./tree.ts";

export interface SearchParams {
  query?: string;
  touched?: string;
  action?: "read" | "write" | "any";
  command?: string;
  cwd?: string;
  after?: string;
  before?: string;
  role?: "user" | "assistant" | "any";
  limit?: number;
}

export interface SearchOptions {
  maxSnippetChars: number;
}

export interface Continuation {
  sessionId: string;
  path: string;
}

export interface SearchResult {
  sessionId: string;
  path: string;
  cwd: string | undefined;
  name: string | undefined;
  entryId: string;
  ts: string | undefined;
  role: string | undefined;
  kind: string;
  snippet: string | undefined;
  branch: BranchInfo;
  continuations: Continuation[];
}

const DEFAULT_LIMIT = 10;

/**
 * SQLite's `GLOB` already understands `*`, `?`, and `[…]`; the translation
 * needed is a doubled star collapsed to one, plus an implicit leading star so a
 * bare `auth.ts` matches a full path too.
 */
export function globToLike(pattern: string): string {
  const collapsed = pattern.replace(/\*\*/g, "*");
  return collapsed.startsWith("*") || collapsed.startsWith("/") ? collapsed : `*${collapsed}`;
}

/** An ISO date, a full ISO timestamp, or relative shorthand such as `14d`. */
export function parseWhen(value: string, now: Date): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  const relative = /^(\d+)\s*([hdwm])$/i.exec(trimmed);
  if (!relative) return undefined;
  const amount = Number(relative[1]);
  const hours = { h: 1, d: 24, w: 24 * 7, m: 24 * 30 }[relative[2].toLowerCase() as "h" | "d" | "w" | "m"];
  return new Date(now.getTime() - amount * hours * 3_600_000).toISOString();
}

interface CandidateRow {
  rowid: number;
  entryId: string;
  parentId: string | null;
  kind: string;
  role: string | null;
  ts: string | null;
  path: string;
  sessionId: string | null;
  cwd: string | null;
  created: string | null;
  snippet: string | null;
}

function buildQuery(params: SearchParams, now: Date): { sql: string; args: unknown[] } {
  const wheres: string[] = [];
  const args: unknown[] = [];

  const select = params.query
    ? "SELECT e.rowid AS rowid, e.entry_id AS entryId, e.parent_id AS parentId, e.kind AS kind, " +
      "e.role AS role, e.ts AS ts, f.path AS path, f.session_id AS sessionId, f.cwd AS cwd, " +
      "f.created AS created, snippet(prose, 0, '', '', '…', 24) AS snippet " +
      "FROM prose JOIN entries e ON e.rowid = prose.rowid JOIN files f ON f.path = e.path"
    : "SELECT e.rowid AS rowid, e.entry_id AS entryId, e.parent_id AS parentId, e.kind AS kind, " +
      "e.role AS role, e.ts AS ts, f.path AS path, f.session_id AS sessionId, f.cwd AS cwd, " +
      "f.created AS created, NULL AS snippet " +
      "FROM entries e JOIN files f ON f.path = e.path";

  if (params.query) {
    wheres.push("prose MATCH ?");
    args.push(params.query);
  }

  if (params.touched) {
    let clause = "EXISTS (SELECT 1 FROM evidence v WHERE v.entry_rowid = e.rowid AND v.target GLOB ?";
    args.push(globToLike(params.touched));
    if (params.action && params.action !== "any") {
      clause += " AND v.action = ?";
      args.push(params.action);
    }
    wheres.push(`${clause})`);
  }

  if (params.command) {
    wheres.push(
      "EXISTS (SELECT 1 FROM evidence v WHERE v.entry_rowid = e.rowid AND v.action = 'run' " +
        "AND v.target LIKE '%' || ? || '%')",
    );
    args.push(params.command);
  }

  if (params.cwd) {
    wheres.push("f.cwd GLOB ?");
    args.push(globToLike(params.cwd));
  }

  if (params.role && params.role !== "any") {
    wheres.push("e.role = ?");
    args.push(params.role);
  }

  const after = params.after ? parseWhen(params.after, now) : undefined;
  if (after) {
    wheres.push("COALESCE(e.ts, f.last_activity) >= ?");
    args.push(after);
  }
  const before = params.before ? parseWhen(params.before, now) : undefined;
  if (before) {
    wheres.push("COALESCE(e.ts, f.last_activity) < ?");
    args.push(before);
  }

  // Ranked by relevance when there is a query to rank against, by recency when
  // the question is "what did I touch" rather than "what did I say". A session
  // name and a user label are deliberate, near-perfect signal, so they outrank
  // an equally good match in the body: bm25 is negative, and scaling it up
  // moves the hit toward the top.
  const order = params.query
    ? "ORDER BY bm25(prose) * CASE e.kind WHEN 'session_info' THEN 2.0 WHEN 'label' THEN 1.5 ELSE 1.0 END"
    : "ORDER BY COALESCE(e.ts, f.created) DESC";
  const overfetch = (params.limit ?? DEFAULT_LIMIT) * 10 + 50;

  return {
    sql: `${select} WHERE ${wheres.join(" AND ")} ${order} LIMIT ${overfetch}`,
    args,
  };
}

function snippetOf(row: CandidateRow, maxChars: number): string | undefined {
  const raw = row.snippet ?? undefined;
  if (!raw) return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function loadFileNodes(db: DatabaseSync): FileNode[] {
  return (db.prepare("SELECT path, parent_path AS parentPath, created FROM files").all() as any[]).map(
    (row) => ({
      path: row.path as string,
      parentPath: (row.parentPath ?? null) as string | null,
      created: (row.created ?? undefined) as string | undefined,
    }),
  );
}

function loadSkeleton(db: DatabaseSync, path: string): Skeleton[] {
  return (
    db
      .prepare("SELECT entry_id AS id, parent_id AS parentId, ts FROM entries WHERE path = ? ORDER BY rowid")
      .all(path) as any[]
  ).map((row) => ({
    id: row.id as string,
    parentId: (row.parentId ?? null) as string | null,
    ts: (row.ts ?? undefined) as string | undefined,
  }));
}

function sessionName(db: DatabaseSync, path: string): string | undefined {
  const row = db
    .prepare(
      "SELECT text FROM entries WHERE path = ? AND kind = 'session_info' AND text IS NOT NULL " +
        "ORDER BY rowid DESC LIMIT 1",
    )
    .get(path) as { text?: string } | undefined;
  return row?.text ?? undefined;
}

export function searchIndex(
  db: DatabaseSync,
  params: SearchParams,
  options: SearchOptions,
  now: Date = new Date(),
): SearchResult[] {
  if (!params.query && !params.touched && !params.command) {
    throw new Error("at least one of query, touched, or command is required");
  }

  const { sql, args } = buildQuery(params, now);
  let rows: CandidateRow[];
  try {
    rows = db.prepare(sql).all(...(args as any[])) as unknown as CandidateRow[];
  } catch (cause) {
    // SQLite raises on a malformed FTS5 expression; hand that back as something
    // the caller can correct rather than as database noise.
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`invalid query: ${message}`);
  }

  const files = loadFileNodes(db);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const skeletons = new Map<string, Skeleton[]>();
  const limit = params.limit ?? DEFAULT_LIMIT;

  const results: SearchResult[] = [];
  const seenEntries = new Set<string>();

  for (const row of rows) {
    if (results.length >= limit) break;
    // The same entry id in five files is one moment, not five hits.
    if (seenEntries.has(row.entryId)) continue;
    seenEntries.add(row.entryId);

    const holders = db
      .prepare("SELECT path FROM entries WHERE entry_id = ?")
      .all(row.entryId) as any[];
    const root = familyRoot(files, row.path);
    const candidates: Candidate[] = holders
      .map((holder) => holder.path as string)
      .filter((path) => path === row.path || familyRoot(files, path) === root)
      .map((path) => ({ path, created: byPath.get(path)?.created }));

    const { origin, continuations } = chooseOrigin(
      candidates.length > 0 ? candidates : [{ path: row.path, created: row.created ?? undefined }],
    );

    let skeleton = skeletons.get(origin.path);
    if (!skeleton) {
      skeleton = loadSkeleton(db, origin.path);
      skeletons.set(origin.path, skeleton);
    }

    const originRow = db
      .prepare("SELECT session_id AS sessionId, cwd FROM files WHERE path = ?")
      .get(origin.path) as { sessionId?: string; cwd?: string } | undefined;

    results.push({
      sessionId: originRow?.sessionId ?? row.sessionId ?? origin.path,
      path: origin.path,
      cwd: originRow?.cwd ?? row.cwd ?? undefined,
      name: sessionName(db, origin.path),
      entryId: row.entryId,
      ts: row.ts ?? undefined,
      role: row.role ?? undefined,
      kind: row.kind,
      snippet: snippetOf(row, options.maxSnippetChars),
      branch: classifyEntry(skeleton, row.entryId),
      continuations: continuations.map((candidate) => ({
        path: candidate.path,
        sessionId:
          ((
            db.prepare("SELECT session_id AS sessionId FROM files WHERE path = ?").get(candidate.path) as
              | { sessionId?: string }
              | undefined
          )?.sessionId ?? candidate.path) as string,
      })),
    });
  }

  return results;
}

/** Resolve an exact path, an exact session id, or a unique id prefix. */
export function resolveSession(db: DatabaseSync, idOrPath: string): string | undefined {
  const exactPath = db.prepare("SELECT path FROM files WHERE path = ?").get(idOrPath) as
    | { path: string }
    | undefined;
  if (exactPath) return exactPath.path;

  const exactId = db.prepare("SELECT path FROM files WHERE session_id = ?").get(idOrPath) as
    | { path: string }
    | undefined;
  if (exactId) return exactId.path;

  const prefixed = db
    .prepare("SELECT path FROM files WHERE session_id LIKE ? || '%' LIMIT 2")
    .all(idOrPath) as any[];
  return prefixed.length === 1 ? (prefixed[0].path as string) : undefined;
}

export interface TranscriptEntry {
  entryId: string;
  parentId: string | null;
  kind: string;
  role: string | undefined;
  ts: string | undefined;
  text: string | undefined;
  evidence: EvidenceRow[];
}

export type ReadRequest =
  | { path: string; mode: "around"; entryId: string; radius: number }
  | { path: string; mode: "branch"; leafId: string }
  | { path: string; mode: "last"; count: number };

interface EntryRow {
  rowid: number;
  entryId: string;
  parentId: string | null;
  kind: string;
  role: string | null;
  ts: string | null;
  text: string | null;
}

function attachEvidence(db: DatabaseSync, rows: EntryRow[]): TranscriptEntry[] {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => "?").join(",");
  const evidence = db
    .prepare(
      `SELECT entry_rowid AS rowid, tool, action, target FROM evidence WHERE entry_rowid IN (${placeholders}) ORDER BY rowid`,
    )
    .all(...rows.map((row) => row.rowid)) as any[];

  const byRow = new Map<number, EvidenceRow[]>();
  for (const item of evidence) {
    const bucket = byRow.get(Number(item.rowid)) ?? [];
    bucket.push({ tool: item.tool, action: item.action, target: item.target ?? undefined });
    byRow.set(Number(item.rowid), bucket);
  }

  return rows.map((row) => ({
    entryId: row.entryId,
    parentId: row.parentId ?? null,
    kind: row.kind,
    role: row.role ?? undefined,
    ts: row.ts ?? undefined,
    text: row.text ?? undefined,
    evidence: byRow.get(row.rowid) ?? [],
  }));
}

const ENTRY_COLUMNS =
  "rowid, entry_id AS entryId, parent_id AS parentId, kind, role, ts, text";

export function readEntries(db: DatabaseSync, request: ReadRequest): TranscriptEntry[] {
  if (request.mode === "around") {
    const anchor = db
      .prepare("SELECT rowid FROM entries WHERE path = ? AND entry_id = ?")
      .get(request.path, request.entryId) as { rowid: number } | undefined;
    if (!anchor) return [];
    const rows = db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM entries WHERE path = ? AND rowid BETWEEN ? AND ? ORDER BY rowid`,
      )
      .all(
        request.path,
        Number(anchor.rowid) - request.radius,
        Number(anchor.rowid) + request.radius,
      ) as unknown as EntryRow[];
    return attachEvidence(db, rows);
  }

  if (request.mode === "last") {
    const rows = db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE path = ? ORDER BY rowid DESC LIMIT ?`)
      .all(request.path, request.count) as unknown as EntryRow[];
    return attachEvidence(db, [...rows].reverse());
  }

  const skeleton = loadSkeleton(db, request.path);
  const byId = new Map(skeleton.map((node) => [node.id, node]));
  const wanted = pathToRoot(byId, request.leafId);
  if (wanted.length === 0) return [];

  const placeholders = wanted.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM entries WHERE path = ? AND entry_id IN (${placeholders}) ORDER BY rowid`,
    )
    .all(request.path, ...wanted) as unknown as EntryRow[];
  return attachEvidence(db, rows);
}
