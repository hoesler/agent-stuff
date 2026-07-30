/**
 * session-title — name pi sessions with a cheap, explicitly configured model.
 *
 * Automatic titling runs once, after the first user↔assistant exchange settles,
 * and only when a titling model is configured. A name set by the user is never
 * overwritten; `/title` re-titles on demand from the current conversation.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionTitleConfigLoader, resolveConfigPaths } from "./config.ts";
import { createController, type TitleController } from "./controller.ts";
import { alreadyTitled, latestMarker, STATE_ENTRY_TYPE } from "./state.ts";
import { generateTitle } from "./title.ts";
import { initialDialogue, recentWindow } from "./transcript.ts";
import { resolveTitlingModel, shouldTitleOnSettle } from "./trigger.ts";
import type { ConfigSnapshot, SessionTitleConfig, TitleMarker } from "./types.ts";

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
   * A missing config means "feature off" and stays silent. A present but broken
   * config, or a model that cannot be resolved or authenticated, warns once —
   * a typo must not be indistinguishable from the feature being off.
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
    const current = config();
    if (!current) return undefined;

    const model = resolveTitlingModel(ctx.modelRegistry, current.model);
    if (!model) {
      warnOnce(ctx, `model not found: ${current.model}`);
      return undefined;
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      warnOnce(ctx, `authentication failed for ${current.model}: ${auth.error}`);
      return undefined;
    }

    const branch = ctx.sessionManager.getBranch();
    const parts = mode === "initial" ? initialDialogue(branch) : recentWindow(branch);
    if (parts.length === 0) return undefined;

    return generateTitle({
      complete: (context, options) =>
        completeSimple(model, context, {
          ...options,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
        }),
      config: current,
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
      appendMarker: (marker: TitleMarker) => pi.appendEntry(STATE_ENTRY_TYPE, marker),
      generateTitle: (request) => runGeneration(ctx, request.mode, request.currentName, request.signal),
      debug: debugLog,
    });

    const existingName = pi.getSessionName();
    controller.restore(alreadyTitled(existingName), existingName);
  });

  pi.on("session_info_changed", async (event) => {
    if (!config()) return;
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
            `Model: ${current?.model ?? "(not configured)"}`,
            `Resolves: ${current && resolveTitlingModel(ctx.modelRegistry, current.model) ? "yes" : "no"}`,
            `Automatic titling: ${isEnabled() ? "enabled" : "disabled"}`,
            `Current name: ${pi.getSessionName() ?? "(none)"}`,
            `Name source: ${marker ? marker.kind : pi.getSessionName() ? "unknown" : "(none)"}`,
            `Automatic titling has run: ${controller?.isTitled() ?? false}`,
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
          const model = resolveTitlingModel(ctx.modelRegistry, current.model);
          lines.push(`Model ${current.model}: ${model ? "found" : "NOT FOUND in registry"}`);
          if (model) {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            lines.push(`Authentication: ${auth.ok ? "ok" : `failed — ${auth.error}`}`);
          }
        } else {
          lines.push(
            "",
            "Example config:",
            JSON.stringify(
              { version: 1, model: "copilot/gpt-5-mini", thinkingLevel: "off", maxLength: 50 },
              null,
              2,
            ),
          );
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (command.length > 0) {
        ctx.ui.notify("Usage: /title [status|doctor|on|off]", "warning");
        return;
      }

      if (!config()) {
        ctx.ui.notify(
          "session-title: no titling model configured. Run /title doctor for setup.",
          "warning",
        );
        return;
      }

      const name = await controller?.run("manual");
      ctx.ui.notify(
        name ? `Session renamed: ${name}` : "session-title: could not generate a name",
        name ? "info" : "warning",
      );
    },
  });
}
