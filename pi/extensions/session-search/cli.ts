#!/usr/bin/env node
/**
 * session-search as a command: what the agent runs through `bash`, and what
 * you run yourself.
 *
 * It needs nothing from a running pi but what pi already hands every `bash`
 * child: the working directory and `PI_SESSION_FILE`. See
 * docs/adr/ADR-001-tools-only-when-a-cli-cannot.md for why this is a CLI and
 * not a tool.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Environment, type ReadRequest, read, search, status } from "./service.ts";

export const USAGE = `Usage:
  session-search search [QUERY] [--touched GLOB] [--action read|write|any]
                        [--command TEXT] [--scope SCOPE] [--after DATE]
                        [--before DATE] [--role user|assistant|any] [--limit N]
  session-search read SESSION (--entry ID [--around N] | --branch LEAF | --last N)
                        [--include-tools] [--offset N]
  session-search status [--rebuild]

QUERY is an FTS5 expression over prose; "-" reads it from stdin.
SCOPE is all (default), project, repo, lineage, or a path glob.`;

/** A mistake in the invocation itself, as opposed to a query that failed. */
class UsageError extends Error {}

export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  stdin(): string;
}

/** pi's own rule, from `getAgentDir()`, without importing pi to apply it. */
export function agentDir(env: NodeJS.ProcessEnv): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), ".pi", "agent");
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function integer(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${flag} must be an integer from ${min} to ${max}`);
  }
  return n;
}

async function runSearch(args: string[], env: Environment, io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      touched: { type: "string" },
      action: { type: "string" },
      command: { type: "string" },
      scope: { type: "string" },
      after: { type: "string" },
      before: { type: "string" },
      role: { type: "string" },
      limit: { type: "string" },
    },
  });
  if (positionals.length > 1) {
    throw new UsageError("search takes one QUERY; quote it to pass phrases and operators");
  }
  const query = positionals[0] === "-" ? io.stdin().trim() : positionals[0];
  const result = await search(env, {
    query,
    touched: values.touched,
    action: oneOf(values.action, ["read", "write", "any"], "action"),
    command: values.command,
    scope: values.scope,
    after: values.after,
    before: values.before,
    role: oneOf(values.role, ["user", "assistant", "any"], "role"),
    limit: integer(values.limit, "limit", 1, 50),
  });
  io.stdout(result.text);
}

async function runRead(args: string[], env: Environment, io: Io): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      entry: { type: "string" },
      around: { type: "string" },
      branch: { type: "string" },
      last: { type: "string" },
      "include-tools": { type: "boolean" },
      offset: { type: "string" },
    },
  });
  const [session, ...extra] = positionals;
  if (!session || extra.length > 0) throw new UsageError("read takes exactly one SESSION");

  const modes = [values.entry, values.branch, values.last].filter((value) => value !== undefined);
  if (modes.length > 1) throw new UsageError("give one of --entry, --branch, or --last");
  if (values.around !== undefined && values.entry === undefined) {
    throw new UsageError("--around needs --entry");
  }

  const common = {
    session,
    includeTools: values["include-tools"],
    offset: integer(values.offset, "offset", 0, Number.MAX_SAFE_INTEGER),
  };
  const request: ReadRequest =
    values.entry !== undefined
      ? { ...common, mode: "around", entry: values.entry, around: integer(values.around, "around", 0, 100) }
      : values.branch !== undefined
        ? { ...common, mode: "branch", branch: values.branch }
        : { ...common, mode: "last", last: integer(values.last, "last", 1, 200) };

  io.stdout((await read(env, request)).text);
}

async function runStatus(args: string[], env: Environment, io: Io): Promise<void> {
  const { values } = parseArgs({ args, options: { rebuild: { type: "boolean" } } });
  io.stdout(await status(env, { rebuild: values.rebuild }));
}

/**
 * Exit codes: 0 answered, 1 the query failed (bad FTS5, unknown session), 2 the
 * invocation was wrong. Both failures print why on stderr.
 */
export async function main(argv: string[], io: Io): Promise<number> {
  const [subcommand, ...args] = argv;
  const env: Environment = {
    cwd: io.cwd,
    agentDir: agentDir(io.env),
    sessionFile: io.env.PI_SESSION_FILE || undefined,
    configPath: io.env.PI_SESSION_SEARCH_CONFIG,
  };

  try {
    if (subcommand === "search") await runSearch(args, env, io);
    else if (subcommand === "read") await runRead(args, env, io);
    else if (subcommand === "status") await runStatus(args, env, io);
    else if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") io.stdout(USAGE);
    else throw new UsageError(subcommand ? `unknown command "${subcommand}"` : "missing command");
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // parseArgs reports unknown and malformed flags as TypeErrors with a code.
    const usage = cause instanceof UsageError || (cause as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    io.stderr(usage ? `session-search: ${message}\n\n${USAGE}` : `session-search: ${message}`);
    return usage ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    stdin: () => readFileSync(0, "utf8"),
  });
}
