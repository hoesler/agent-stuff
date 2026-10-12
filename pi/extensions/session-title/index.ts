/**
 * session-title — name pi sessions with a configured model, or the session model.
 *
 * Automatic titling runs once, after the first user↔assistant exchange settles.
 * Without a configured model it uses the session model at the lowest thinking
 * level that model supports. A name set by the user is never
 * overwritten; `/title` re-titles on demand from the current conversation.
 */

import { completeSimple, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionTitleConfigLoader, resolveConfigPaths } from "./config.ts";
import { createController, type TitleController } from "./controller.ts";
import { alreadyTitled, latestMarker, STATE_ENTRY_TYPE } from "./state.ts";
import { generateTitle } from "./title.ts";
import { initialDialogue, recentWindow } from "./transcript.ts";
import { selectTitlingModel, shouldTitleOnSettle, withResolvedEndpoint } from "./trigger.ts";
import type { ConfigSnapshot, ModelThinkingLevel, SessionTitleConfig, TitleMarker } from "./types.ts";

/** Titling is a small task: unless configured, use the least effort the model allows. */
function titlingThinkingLevel(model: Model<any>, configured: ModelThinkingLevel | undefined): ModelThinkingLevel {
  return configured ?? getSupportedThinkingLevels(model)[0] ?? "off";
}

export default function sessionTitleExtension(pi: ExtensionAPI): void {
  let loader: SessionTitleConfigLoader | undefined;
  let snapshot: ConfigSnapshot | undefined;
  let controller: TitleController | undefined;
  let sessionEnabled: boolean | undefined;
  let warned = false;

  const debugLog = (message: string) => {
    if (snapshot?.ok && snapshot.config.debug) console.error(`[session-title] ${message}`);
  };

  const config = (): SessionTitleConfig | undefined => (snapshot?.ok ? snapshot.config : undefined);

  const isEnabled = () => sessionEnabled ?? config()?.enabled ?? false;

  /** How status and doctor name the titling model. */
  const modelLabel = (ctx: ExtensionContext, current: SessionTitleConfig): string => {
    if (current.model) return current.model;
    return ctx.model ? `session model (${ctx.model.provider}/${ctx.model.id})` : "session model (none selected)";
  };

  const refresh = async (ctx: ExtensionContext): Promise<ConfigSnapshot> => {
    if (!loader) {
      loader = new SessionTitleConfigLoader(
        resolveConfigPaths({
          envPath: process.env.PI_SESSION_TITLE_CONFIG,
          startupCwd: ctx.cwd,
          agentDir: getAgentDir(),
          projectTrusted: ctx.isProjectTrusted(),
        }),
      );
    }
    snapshot = await loader.refresh();
    return snapshot;
  };

  /**
   * A broken config, or a model that cannot be resolved or authenticated, warns
   * once — a typo must not be indistinguishable from the feature being off.
   */
  const warnOnce = (ctx: ExtensionContext, message: string) => {
    if (warned) return;
    warned = true;
    ctx.ui.notify(`session-title: ${message}`, "warning");
  };

  const runGeneration = async (
    ctx: ExtensionContext,
    mode: "initial" | "manual",
    currentName: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    /**
     * Every reason titling cannot run is named and thrown. Automatic titling
     * swallows the throw, so it warns here instead — once, since it fires
     * unbidden. A manual run reports the cause at the command, so warning here
     * too would say it twice.
     */
    const fail: (message: string) => never = (message) => {
      if (mode !== "manual") warnOnce(ctx, message);
      throw new Error(message);
    };

    const current = config();
    if (!current) fail("invalid configuration");

    const model = selectTitlingModel(ctx.modelRegistry, current.model, ctx.model);
    if (!model) fail(current.model ? `model not found: ${current.model}` : "no session model selected");

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) fail(`authentication failed for ${modelLabel(ctx, current)}: ${auth.error}`);

    const branch = ctx.sessionManager.getBranch();
    const parts = mode === "initial" ? initialDialogue(branch) : recentWindow(branch);
    if (parts.length === 0) fail("no conversation to title yet");

    // The credential, not the catalog, names the endpoint for this model.
    const endpoint = withResolvedEndpoint(model, auth.baseUrl);

    return generateTitle({
      complete: (context, options) =>
        completeSimple(endpoint, context, {
          ...options,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
        }),
      thinkingLevel: titlingThinkingLevel(model, current.thinkingLevel),
      maxLength: current.maxLength,
      parts,
      currentName,
      signal,
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const current = await refresh(ctx);
    warned = false;
    sessionEnabled = undefined;

    if (!current.ok && current.reason === "invalid" && ctx.hasUI) {
      warnOnce(ctx, `invalid configuration: ${current.errors.map((e) => e.message).join("; ")}`);
    }

    controller = createController({
      now: () => Date.now(),
      isEnabled,
      getCurrentName: () => pi.getSessionName(),
      setSessionName: (name) => pi.setSessionName(name),
      // The controller must always latch a user rename so a session that is later
      // re-enabled cannot overwrite it; the guard here ensures an invalid
      // configuration leaves no trace in the session file.
      appendMarker: (marker: TitleMarker) => {
        if (config()) pi.appendEntry(STATE_ENTRY_TYPE, marker);
      },
      generateTitle: (request) => runGeneration(ctx, request.mode, request.currentName, request.signal),
      debug: debugLog,
    });

    const existingName = pi.getSessionName();
    controller.restore(alreadyTitled(existingName), existingName);
  });

  pi.on("session_info_changed", async (event) => {
    controller?.observeNameChange(event.name);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!controller) return;
    await refresh(ctx);
    const decided = shouldTitleOnSettle({
      hasUI: ctx.hasUI,
      configured: Boolean(config()),
      enabled: isEnabled(),
      titled: controller.isTitled(),
    });
    if (!decided) return;
    // Best-effort background work: never hold pi's settled lifecycle while a
    // provider call is in flight.
    void controller.run("initial");
  });

  pi.on("session_shutdown", async () => {
    controller?.shutdown();
    controller = undefined;
  });

  pi.registerCommand("title", {
    description: "Generate a session name from the current conversation",
    handler: async (args, ctx) => {
      const command = args.trim();
      await refresh(ctx);

      if (command === "on" || command === "off") {
        sessionEnabled = command === "on";
        ctx.ui.notify(`session-title: automatic titling ${command} for this session`, "info");
        return;
      }

      if (command === "status") {
        const current = config();
        const marker = latestMarker(ctx.sessionManager.getBranch());
        ctx.ui.notify(
          [
            `Model: ${current ? modelLabel(ctx, current) : "(invalid configuration)"}`,
            `Resolves: ${current && selectTitlingModel(ctx.modelRegistry, current.model, ctx.model) ? "yes" : "no"}`,
            `Automatic titling: ${isEnabled() ? "enabled" : "disabled"}`,
            `Current name: ${pi.getSessionName() ?? "(none)"}`,
            `Name source: ${marker ? marker.kind : pi.getSessionName() ? "unknown" : "(none)"}`,
            `Automatic titling: ${controller?.isTitled() ? "stood down" : "armed"}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (command === "doctor") {
        const current = config();
        const configLine =
          snapshot === undefined
            ? "Config: unread"
            : snapshot.ok
              ? "Config: loaded"
              : `Config: ${snapshot.reason} — ${snapshot.errors.map((error) => error.message).join("; ")}`;
        const lines = [
          "Config paths (lowest precedence first):",
          ...(loader?.paths ?? []).map((path) => `  ${path}`),
          `Environment override: ${process.env.PI_SESSION_TITLE_CONFIG ?? "(unset)"}`,
          `Project trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`,
          configLine,
        ];
        if (current) {
          const model = selectTitlingModel(ctx.modelRegistry, current.model, ctx.model);
          lines.push(`Model ${modelLabel(ctx, current)}: ${model ? "found" : "NOT FOUND"}`);
          if (model) {
            const level = titlingThinkingLevel(model, current.thinkingLevel);
            lines.push(`Thinking level: ${level}${current.thinkingLevel ? "" : " (lowest supported)"}`);
          }
          if (model) {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            lines.push(`Authentication: ${auth.ok ? "ok" : `failed — ${auth.error}`}`);
            // The endpoint is worth printing even though it is rarely wrong:
            // when it is, every other line here still reads "ok".
            if (auth.ok) lines.push(`Endpoint: ${withResolvedEndpoint(model, auth.baseUrl).baseUrl}`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (command.length > 0) {
        ctx.ui.notify("Usage: /title [status|doctor|on|off]", "warning");
        return;
      }

      if (!config()) {
        ctx.ui.notify("session-title: invalid configuration. Run /title doctor.", "warning");
        return;
      }

      try {
        const name = await controller?.run("manual");
        ctx.ui.notify(
          name ? `Session renamed: ${name}` : "session-title: could not generate a name",
          name ? "info" : "warning",
        );
      } catch (cause) {
        ctx.ui.notify(
          `session-title: ${cause instanceof Error ? cause.message : String(cause)}`,
          "warning",
        );
      }
    },
  });
}
