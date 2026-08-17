import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  DynamicBorder,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { parseCommand } from "./args.ts";
import { createCli, type Exec, type HunkCli } from "./cli.ts";
import { defaultConfig, loadConfig } from "./config.ts";
import { spawnWindow } from "./ghostty.ts";
import {
  ADDRESSED_ENTRY,
  confirmAddressed,
  nextAddressed,
  pendingNotes,
  restoreAddressed,
  type AddressedState,
} from "./pending.ts";
import { fixPrompt, reviewPrompt } from "./prompts.ts";
import { ensureSession, type Resolution } from "./session.ts";
import {
  smartDefaultValue,
  TARGET_PRESETS,
  targetArgs,
  targetLabel,
  type PresetValue,
  type Target,
} from "./targets.ts";
import type { HunkConfig, HunkNote } from "./types.ts";

const SPAWN_HINT = "Open a review yourself with `hunk diff`, then run /hunk again.";

export default function hunkExtension(pi: ExtensionAPI) {
  let config: HunkConfig = defaultConfig();
  /** Set when a fix turn is in flight, so `agent_settled` knows what to confirm. */
  let outstandingFix: { sessionId: string; notes: HunkNote[]; since: string } | undefined;

  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  function cliFor(cwd: string): HunkCli {
    return createCli({ exec, hunkBin: config.hunkBin, cwd });
  }

  async function gitRoot(cwd: string): Promise<string | undefined> {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (result.code !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  async function isDirty(cwd: string): Promise<boolean> {
    const result = await pi.exec("git", ["status", "--porcelain"], { cwd });
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async function localBranches(cwd: string): Promise<string[]> {
    const result = await pi.exec(
      "git",
      ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
      { cwd },
    );
    if (result.code !== 0) return [];
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async function recentCommits(cwd: string): Promise<Array<{ sha: string; title: string }>> {
    const result = await pi.exec("git", ["log", "-n", "15", "--format=%h%x09%s"], { cwd });
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length === 2 && parts[0])
      .map(([sha, title]) => ({ sha, title }));
  }

  /** The same `ctx.ui.custom` + `SelectList` shape `code-review` and `agent-modes` use. */
  async function pick(ctx: ExtensionCommandContext, title: string, items: SelectItem[], selected: number) {
    if (items.length === 0) return undefined;
    return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));
      const list = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      if (selected >= 0) list.setSelectedIndex(selected);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "enter to confirm, esc to cancel")));
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function pickTarget(ctx: ExtensionCommandContext): Promise<Target | undefined> {
    const presets = TARGET_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }));
    const smart = smartDefaultValue(await isDirty(ctx.cwd));
    const chosen = await pick(
      ctx,
      "Review with Hunk",
      presets,
      presets.findIndex((preset) => preset.value === smart),
    );
    if (!chosen) return undefined;

    if (chosen === ("workingTree" satisfies PresetValue)) return { kind: "workingTree" };
    if (chosen === ("staged" satisfies PresetValue)) return { kind: "staged" };

    if (chosen === ("baseBranch" satisfies PresetValue)) {
      const branches = await localBranches(ctx.cwd);
      if (branches.length === 0) {
        ctx.ui.notify("No local branches to compare against.", "warning");
        return undefined;
      }
      const branch = await pick(
        ctx,
        "Base branch",
        branches.map((name) => ({ value: name, label: name, description: "" })),
        0,
      );
      return branch ? { kind: "baseBranch", branch } : undefined;
    }

    const commits = await recentCommits(ctx.cwd);
    if (commits.length === 0) {
      ctx.ui.notify("No commits to review.", "warning");
      return undefined;
    }
    const sha = await pick(
      ctx,
      "Commit",
      commits.map((commit) => ({ value: commit.sha, label: commit.sha, description: commit.title })),
      0,
    );
    return sha ? { kind: "commit", sha } : undefined;
  }

  async function resolve(ctx: ExtensionCommandContext, target: Target | undefined, sessionId: string | undefined) {
    return ensureSession(
      {
        cli: cliFor(ctx.cwd),
        gitRoot: () => gitRoot(ctx.cwd),
        realpath: (path) => realpath(path),
        spawn: (args) =>
          config.spawn === "never"
            ? Promise.resolve({ ok: false as const, message: "Opening a window is disabled (`spawn: never`)." })
            : spawnWindow({ exec, platform: process.platform }, { cwd: ctx.cwd, hunkBin: config.hunkBin, target: args }),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: () => Date.now(),
      },
      { target: target ? targetArgs(target) : undefined, sessionId },
    );
  }

  /** Takes the non-session arms only, so the union stays discriminated. */
  function reportUnresolved(ctx: ExtensionCommandContext, resolution: Exclude<Resolution, { kind: "session" }>) {
    if (resolution.kind === "ambiguous") {
      const ids = resolution.sessionIds.join(", ");
      ctx.ui.notify(`Several Hunk windows show this repository: ${ids}. Re-run with --session <id>.`, "warning");
      return;
    }
    ctx.ui.notify(resolution.message, "warning");
  }

  /** The same file `/review` reads, so guidelines written once apply to both. */
  async function projectGuidelines(cwd: string): Promise<string | undefined> {
    try {
      const text = await readFile(join(cwd, "REVIEW_GUIDELINES.md"), "utf8");
      return text.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async function startReview(ctx: ExtensionCommandContext, target: Target, sessionId: string | undefined) {
    const resolution = await resolve(ctx, target, sessionId);
    if (resolution.kind !== "session") {
      reportUnresolved(ctx, resolution);
      return;
    }
    ctx.ui.notify(`Reviewing ${targetLabel(target)} in Hunk.`, "info");
    pi.sendUserMessage(
      reviewPrompt({
        sessionId: resolution.sessionId,
        targetLabel: targetLabel(target),
        guidelines: await projectGuidelines(ctx.cwd),
      }),
    );
  }

  /**
   * `undefined` means fix mode could not even look; `{ empty: true }` means it
   * looked and found nothing new. Auto mode needs those apart: only the second
   * should fall through to a review.
   */
  async function startFix(
    ctx: ExtensionCommandContext,
    sessionId: string | undefined,
    explicit: boolean,
  ): Promise<{ empty: boolean } | undefined> {
    const resolution = await resolve(ctx, undefined, sessionId);
    if (resolution.kind !== "session") {
      if (explicit) reportUnresolved(ctx, resolution);
      return undefined;
    }

    const notes = await cliFor(ctx.cwd).listNotes(resolution.sessionId, "user");
    if (!notes.ok) {
      ctx.ui.notify(notes.message, "error");
      return undefined;
    }

    const pending = pendingNotes(notes.value, restoreAddressed(ctx.sessionManager.getBranch()));
    if (pending.length === 0) {
      if (explicit) ctx.ui.notify("No new notes in the Hunk window.", "info");
      return { empty: true };
    }

    outstandingFix = { sessionId: resolution.sessionId, notes: pending, since: new Date().toISOString() };
    ctx.ui.notify(`Addressing ${pending.length} note${pending.length === 1 ? "" : "s"} from Hunk.`, "info");
    pi.sendUserMessage(fixPrompt({ sessionId: resolution.sessionId, notes: pending, author: config.noteAuthor }));
    return { empty: false };
  }

  /**
   * Adopt the binary's own manual instead of documenting its CLI here, so the
   * agent's knowledge of Hunk tracks the installed version.
   */
  pi.on("resources_discover", async () => {
    const path = await createCli({ exec, hunkBin: config.hunkBin, cwd: process.cwd() }).skillPath();
    if (!path.ok || !path.value) return {};
    // pi's loader takes either a directory or a markdown file (core/skills.js),
    // so the printed SKILL.md path goes in verbatim: exact, and it cannot pick
    // up whatever else a future Hunk release ships alongside it.
    return { skillPaths: [path.value] };
  });

  pi.on("session_start", async (_event, ctx) => {
    const snapshot = await loadConfig({
      envPath: process.env.PI_HUNK_CONFIG,
      startupCwd: ctx.cwd,
      agentDir: getAgentDir(),
      projectTrusted: ctx.isProjectTrusted(),
    });
    config = snapshot.config;
    for (const error of snapshot.errors) ctx.ui.notify(`hunk config: ${error.message}`, "warning");
  });

  /**
   * Notes are marked addressed only after the turn, and only where a reply of
   * ours landed on the same anchor. Marking at dispatch would bury a note the
   * agent silently failed to answer.
   */
  pi.on("agent_settled", async (_event, ctx) => {
    const fix = outstandingFix;
    if (!fix) return;
    outstandingFix = undefined;

    const all = await cliFor(ctx.cwd).listNotes(fix.sessionId, "all");
    if (!all.ok) return ctx.ui.notify(all.message, "warning");

    const confirmed = confirmAddressed(fix.notes, all.value, { author: config.noteAuthor, since: fix.since });
    if (confirmed.length > 0) {
      pi.appendEntry<AddressedState>(ADDRESSED_ENTRY, {
        noteIds: nextAddressed(restoreAddressed(ctx.sessionManager.getBranch()), confirmed),
      });
    }
    const unanswered = fix.notes.length - confirmed.length;
    if (unanswered > 0) {
      ctx.ui.notify(
        `${unanswered} note${unanswered === 1 ? "" : "s"} got no reply in Hunk and stay pending.`,
        "warning",
      );
    }
  });

  pi.registerCommand("hunk", {
    description: "Review a changeset in Hunk, or address the notes left there. Usage: /hunk [review|fix] [target]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hunk requires interactive mode", "error");
        return;
      }

      const parsed = parseCommand(args);
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      if (parsed.mode === "fix") {
        await startFix(ctx, parsed.sessionId, true);
        return;
      }

      if (parsed.mode === "auto") {
        const attempted = await startFix(ctx, parsed.sessionId, false);
        if (attempted && !attempted.empty) return;
      }

      const target = parsed.mode === "review" && parsed.target ? parsed.target : await pickTarget(ctx);
      if (!target) {
        ctx.ui.notify(`Cancelled. ${SPAWN_HINT}`, "info");
        return;
      }
      await startReview(ctx, target, parsed.sessionId);
    },
  });
}
