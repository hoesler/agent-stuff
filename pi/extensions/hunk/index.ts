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
import { menuChoice, menuFooter, menuNote, menuRows, type MenuAction } from "./menu.ts";
import { pendingNotes } from "./pending.ts";
import { fixPrompt, reviewPrompt } from "./prompts.ts";
import { repoFacts, type RepoFacts } from "./repo.ts";
import { ensureSession, type Resolution } from "./session.ts";
import { createSpawn } from "./spawn.ts";
import { targetArgs, targetLabel, type Target } from "./targets.ts";
import type { HunkConfig, HunkNote } from "./types.ts";

const SPAWN_HINT = "Open a review yourself with `hunk diff`, then run /hunk again.";

/** What a picker reports back: the row, and which of its verbs was pressed. */
interface Picked {
  value: string;
  action: string;
}

interface PickOptions {
  title: string;
  items: SelectItem[];
  /** A muted line under the rows, for what is missing and why. */
  note?: string;
  /** The hint under that, recomputed for whichever row the cursor is on. */
  footer?: (value: string) => string;
  /** Raw key data → the action it stands for, read before the list sees it. */
  keys?: Record<string, string>;
}

const CONFIRM = "confirm";

/**
 * What the live window holds. `empty` and `unavailable` are kept apart because
 * one is a window with nothing new in it and the other is no reading at all —
 * the menu words them differently, and `/hunk fix` reports them at different
 * severities.
 */
type Probe =
  // `all` rides along with `notes` because the thread above a pending note is
  // made of notes that are not pending themselves, and the window is read once.
  | { kind: "notes"; sessionId: string; notes: HunkNote[]; all: HunkNote[] }
  | { kind: "empty"; sessionId: string }
  | { kind: "unavailable"; message: string };

export default function hunkExtension(pi: ExtensionAPI) {
  let config: HunkConfig = defaultConfig();

  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  function cliFor(cwd: string): HunkCli {
    return createCli({ exec, hunkBin: config.hunkBin, cwd });
  }

  async function gitRoot(cwd: string): Promise<string | undefined> {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (result.code !== 0) return undefined;
    return result.stdout.trim() || undefined;
  }

  /** The same `ctx.ui.custom` + `SelectList` shape `code-review` and `agent-modes` use. */
  async function pick(ctx: ExtensionCommandContext, options: PickOptions): Promise<Picked | undefined> {
    if (options.items.length === 0) return undefined;
    return ctx.ui.custom<Picked | undefined>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
      const list = new SelectList(options.items, Math.min(options.items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });

      // The rows are ordered so the first is the likeliest, and the footer has
      // to name that row's verbs before a key is ever pressed.
      let selected = options.items[0];
      const hint = (value: string) => options.footer?.(value) ?? "enter to confirm, esc to cancel";
      const footer = new Text(theme.fg("dim", hint(selected.value)));
      list.onSelectionChange = (item) => {
        selected = item;
        footer.setText(theme.fg("dim", hint(item.value)));
        tui.requestRender();
      };
      list.onSelect = (item) => done({ value: item.value, action: CONFIRM });
      list.onCancel = () => done(undefined);

      container.addChild(list);
      if (options.note) container.addChild(new Text(theme.fg("muted", options.note)));
      container.addChild(footer);
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Before the list, so a secondary verb is not read as navigation.
          // Nothing here sets a filter, so plain keys are free to mean this.
          const action = options.keys?.[data];
          if (action) return done({ value: selected.value, action });
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function pickCommit(ctx: ExtensionCommandContext, facts: RepoFacts): Promise<Target | undefined> {
    const picked = await pick(ctx, {
      title: "Which commit",
      items: facts.commits.map((commit) => ({ value: commit.sha, label: commit.sha, description: commit.title })),
    });
    return picked ? { kind: "commit", sha: picked.value } : undefined;
  }

  async function pickBranch(ctx: ExtensionCommandContext, facts: RepoFacts): Promise<Target | undefined> {
    const picked = await pick(ctx, {
      title: "Compare against which branch",
      items: facts.branches.map((name) => ({ value: name, label: name, description: "" })),
    });
    return picked ? { kind: "baseBranch", branch: picked.value } : undefined;
  }

  async function resolve(ctx: ExtensionCommandContext, target: Target | undefined, sessionId: string | undefined) {
    return ensureSession(
      {
        cli: cliFor(ctx.cwd),
        gitRoot: () => gitRoot(ctx.cwd),
        realpath: (path) => realpath(path),
        spawn: createSpawn(
          { exec, env: process.env, platform: process.platform },
          { config, cwd: ctx.cwd },
        ),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        now: () => Date.now(),
      },
      { target: target ? targetArgs(target) : undefined, sessionId },
    );
  }

  /** Takes the non-session arms only, so the union stays discriminated. */
  function unresolvedMessage(resolution: Exclude<Resolution, { kind: "session" }>): string {
    if (resolution.kind === "ambiguous") {
      return `Several Hunk windows show this repository: ${resolution.sessionIds.join(", ")}. Re-run with --session <id>.`;
    }
    return resolution.message;
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

  /**
   * Open the target, and hand it to the agent or to the user. Resolution is
   * shared: a window is opened or reloaded either way, and only the prompt
   * tells the two apart.
   */
  async function act(
    ctx: ExtensionCommandContext,
    target: Target,
    sessionId: string | undefined,
    action: MenuAction,
  ) {
    const resolution = await resolve(ctx, target, sessionId);
    if (resolution.kind !== "session") {
      ctx.ui.notify(unresolvedMessage(resolution), "warning");
      return;
    }
    if (action === "open") {
      ctx.ui.notify(`Opened ${targetLabel(target)} in Hunk. Leave notes there, then run /hunk fix.`, "info");
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
   * Reading the live window never spawns one: `ensureSession` without a target
   * reports an absent window rather than opening an empty one.
   *
   * Every note is read, not just the user's: which of them are answered is a
   * fact about the replies standing next to them, and the window is the only
   * place that fact lives.
   */
  async function probeNotes(ctx: ExtensionCommandContext, sessionId: string | undefined): Promise<Probe> {
    const resolution = await resolve(ctx, undefined, sessionId);
    if (resolution.kind !== "session") return { kind: "unavailable", message: unresolvedMessage(resolution) };

    const notes = await cliFor(ctx.cwd).listNotes(resolution.sessionId, "all");
    if (!notes.ok) return { kind: "unavailable", message: notes.message };

    const pending = pendingNotes(notes.value);
    if (pending.length === 0) return { kind: "empty", sessionId: resolution.sessionId };
    return { kind: "notes", sessionId: resolution.sessionId, notes: pending, all: notes.value };
  }

  function dispatchFix(ctx: ExtensionCommandContext, sessionId: string, notes: HunkNote[], all: HunkNote[]) {
    ctx.ui.notify(`Addressing ${notes.length} note${notes.length === 1 ? "" : "s"} from Hunk.`, "info");
    pi.sendUserMessage(fixPrompt({ sessionId, notes, all, author: config.noteAuthor }));
  }

  /** Why the menu has no notes row, in the words the reading itself produced. */
  function notesReason(probe: Probe | undefined): string | undefined {
    if (!probe) return undefined;
    if (probe.kind === "empty") return `no new notes in ${probe.sessionId}`;
    if (probe.kind === "unavailable") return probe.message;
    return undefined;
  }

  /**
   * The menu, and equally the target picker the two explicit forms use. Which
   * verbs a row has is the only difference: bare `/hunk` offers both and the
   * notes row with them, `/hunk review` and `/hunk open` offer their own.
   */
  async function runMenu(
    ctx: ExtensionCommandContext,
    sessionId: string | undefined,
    allowed: readonly MenuAction[],
  ) {
    const offersNotes = allowed.length > 1;
    const [facts, probe] = await Promise.all([
      repoFacts({ exec }, ctx.cwd),
      offersNotes ? probeNotes(ctx, sessionId) : Promise.resolve(undefined),
    ]);

    const state = {
      facts,
      notes: probe?.kind === "notes" ? probe.notes.length : 0,
      notesReason: notesReason(probe),
    };
    const rows = menuRows(state);
    const note = menuNote(state);
    if (rows.length === 0) {
      const verb = allowed.includes("review") ? "review" : "open";
      ctx.ui.notify(`Nothing to ${verb}${note ? ` — ${note}` : ""}. ${SPAWN_HINT}`, "info");
      return;
    }

    const picked = await pick(ctx, {
      title: "Hunk",
      items: rows.map((row) => row.item),
      note,
      footer: (value) => menuFooter(value, allowed),
      // Matched whole, so the SS3 arrow keys (`\x1bOA`) cannot read as an `O`.
      keys: allowed.includes("open") && allowed.includes("review") ? { o: "open", O: "open" } : undefined,
    });
    if (!picked) {
      ctx.ui.notify(`Cancelled. ${SPAWN_HINT}`, "info");
      return;
    }

    const choice = menuChoice(rows, picked.value);
    if (!choice) return;
    if (choice.kind === "notes") {
      if (probe?.kind === "notes") dispatchFix(ctx, probe.sessionId, probe.notes, probe.all);
      return;
    }

    const target =
      choice.kind === "target"
        ? choice.target
        : choice.kind === "pickCommit"
          ? await pickCommit(ctx, facts)
          : await pickBranch(ctx, facts);
    if (!target) {
      ctx.ui.notify(`Cancelled. ${SPAWN_HINT}`, "info");
      return;
    }

    // An explicit form has one verb, so its confirm means that verb.
    const action: MenuAction = picked.action === "open" || !allowed.includes("review") ? "open" : "review";
    await act(ctx, target, sessionId, action);
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

  pi.registerCommand("hunk", {
    description: "Open a changeset in Hunk to review, or address the notes left there. Usage: /hunk [review|open|fix] [target]",
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
        const probe = await probeNotes(ctx, parsed.sessionId);
        if (probe.kind === "unavailable") ctx.ui.notify(probe.message, "warning");
        else if (probe.kind === "empty") ctx.ui.notify("No new notes in the Hunk window.", "info");
        else dispatchFix(ctx, probe.sessionId, probe.notes, probe.all);
        return;
      }

      if (parsed.target) {
        await act(ctx, parsed.target, parsed.sessionId, parsed.mode === "open" ? "open" : "review");
        return;
      }

      const allowed: readonly MenuAction[] = parsed.mode === "menu" ? ["review", "open"] : [parsed.mode];
      await runMenu(ctx, parsed.sessionId, allowed);
    },
  });
}
