/**
 * inovex AI Gateway Extension
 *
 * Registers an `inovex` provider whose models are the ones the gateway lists at
 * `/v1/models`, with the limits and prices pi's own catalog has for them.
 *
 * The gateway speaks two APIs behind one key. Claude goes over the Anthropic
 * Messages API, which the gateway forwards untranslated; everything else,
 * Gemini included, over the OpenAI Chat Completions API on /v1. The key is read
 * from GATEWAY_API_TOKEN and sent only as `Authorization: Bearer` — the gateway
 * refuses a key that arrives as `x-api-key` alone, which is how pi's Anthropic
 * client would otherwise send it.
 *
 * Startup does not wait on the gateway: the provider is registered from the
 * last list it gave, kept on disk, and every session start asks for a fresh one.
 */

import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { GATEWAY_ORIGIN, type fetchGatewayModels } from "./gateway.ts";
import { builtinCatalog, createGatewayRefresh } from "./refresh.ts";
import { readSnapshot, writeSnapshot } from "./snapshot.ts";

const PROVIDER = "inovex";
const TOKEN_ENV = "GATEWAY_API_TOKEN";

/** Long enough for a slow gateway, short enough not to hang a reload. */
const REFRESH_TIMEOUT_MS = 15_000;

export interface InovexGatewayOptions {
  snapshotPath: string;
  token?: () => string | undefined;
  fetchModels?: typeof fetchGatewayModels;
}

/**
 * A reason to report, and somewhere to report it once there is somewhere.
 *
 * pi's own network pass runs before the first `session_start`, and a
 * `refreshModels` is handed no UI, so a failure has nowhere to go at the moment
 * it happens. Holding it until a context arrives is what makes it visible.
 */
function createFailureReporter() {
  const waiting: string[] = [];
  let announce: ((reason: string) => void) | undefined;

  return {
    report(reason: string) {
      if (announce) announce(reason);
      else waiting.push(reason);
    },
    /** Rebound on every session start, so a message always lands on the live UI. */
    bindTo(next: (reason: string) => void) {
      announce = next;
      for (const reason of waiting.splice(0)) next(reason);
    },
  };
}

/**
 * Ask pi to read the list again, over the network.
 *
 * Only the pass interactive mode fires after startup reads models over the
 * network on its own. A `/reload`, `/new` or resume re-registers the provider
 * from the snapshot and nothing reads the gateway again; `pi -p` never does.
 * Errors are not read back off the result: the refresh reports its own.
 */
async function refreshOnSessionStart(ctx: ExtensionContext): Promise<void> {
  // pi reads PI_OFFLINE as "no model network at all". Asking anyway would be
  // going behind it.
  if (process.env.PI_OFFLINE !== undefined) return;

  try {
    await ctx.modelRegistry.refresh({
      providers: [PROVIDER],
      allowNetwork: true,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    // A refresh that was superseded or timed out is pi's to talk about.
  }
}

export function createInovexGateway({ snapshotPath, token, fetchModels }: InovexGatewayOptions) {
  return function inovexGateway(pi: ExtensionAPI) {
    const failures = createFailureReporter();
    const refresh = createGatewayRefresh({
      initial: readSnapshot(snapshotPath),
      catalog: builtinCatalog,
      token: token ?? (() => process.env[TOKEN_ENV] || undefined),
      fetchModels,
      saveSnapshot: (models) => writeSnapshot(snapshotPath, models),
      onFailure: failures.report,
    });

    pi.registerProvider(PROVIDER, {
      name: "inovex AI Gateway",
      baseUrl: `${GATEWAY_ORIGIN}/v1`,
      api: "openai-completions",
      apiKey: `$${TOKEN_ENV}`,
      authHeader: true,
      models: refresh.current(),
      refreshModels: refresh.refreshModels,
    });

    pi.on("session_start", (_event, ctx) => {
      failures.bindTo((reason) => ctx.ui.notify(`inovex-gateway: ${reason}.`, "error"));
      // Started, never awaited. pi awaits each extension's session_start in
      // turn, after the TUI is on screen, so waiting on the gateway here would
      // hold up every handler behind this one.
      void refreshOnSessionStart(ctx);
    });
  };
}

export default createInovexGateway({ snapshotPath: join(getAgentDir(), "inovex-gateway", "models.json") });
