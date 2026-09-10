/**
 * GitHub Copilot Model Limits Extension
 *
 * pi ships static context-window and max-output values for Copilot models,
 * generated from models.dev. The Copilot /models API reports what the signed-in
 * account may actually use. This extension refreshes pi's catalog with those
 * numbers, so a long session is measured against the real window.
 *
 * Limits only. Which models the account may use is pi's own job since 0.85: the
 * built-in Copilot provider filters the catalog by the account's available model
 * ids, taken from this same endpoint when the OAuth token is refreshed.
 *
 * Both of the pi surfaces used here are ones pi promises extensions:
 *
 *  - `@earendil-works/pi-ai/providers/all` is on pi's extension alias list, so
 *    `getBuiltinModels` is always the running pi's catalog. Locating pi-ai by
 *    path instead — `import.meta.resolve("@earendil-works/pi-ai")` — is what the
 *    previous version did, and it does not survive pi's bundled builds, where
 *    pi-ai exists only as an in-bundle virtual module and the specifier resolves
 *    either to nothing or to whatever stale copy happens to sit in node_modules.
 *
 *  - `refreshModels` receives a credential pi has already refreshed, so nothing
 *    here reads, locks or writes auth.json, and no OAuth internals are needed.
 *
 * Nothing is cached. The limits are read from Copilot when they are needed and
 * are never written down, so there is no stored copy to go stale or to reconcile
 * against the account. What that costs is one request per session start; see
 * `refreshOnSessionStart` for why it has to be asked for at all.
 */

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { sharedModelHeaders } from "./headers.ts";
import { createCopilotModelRefresh } from "./refresh.ts";

const PROVIDER = "github-copilot";

/** Long enough for a slow Copilot API, short enough not to hang a reload. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * A reason to report, and somewhere to report it once there is somewhere.
 *
 * The refresh that reads the limits runs before the first `session_start`, and a
 * `refreshModels` is handed no UI, so a failure has nowhere to go at the moment
 * it happens. Holding it until a context arrives is what makes it visible
 * instead of merely thrown.
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
 * Ask pi to read the limits again, over the network.
 *
 * Only one pass in pi 0.85 does that on its own: the one interactive mode fires
 * after startup. Every other refresh is a cache-only pass — `registerProvider`,
 * `unregisterProvider`, the session bootstrap, and `synchronizeCredentialState`
 * after a logout or an api-key change all call `refresh({ allowNetwork: false })`
 * — and pi rebuilds the composed provider at the top of each one, so a cache-only
 * pass leaves the models at pi's shipped numbers. A `/reload` is the plain case:
 * it re-runs extension loading, which re-registers this provider, and no network
 * pass follows it for the rest of the session.
 *
 * Errors are not read back off the result. A failure inside the refresh reports
 * itself through the reporter, which catches the passes pi fires as well as this
 * one; and an aborted refresh is routine, because pi supersedes the previous pass
 * for a provider whenever a new one starts.
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

export default function copilotModelLimits(pi: ExtensionAPI) {
  const builtInModels = () => getBuiltinModels(PROVIDER) as unknown as ProviderModelConfig[];
  const failures = createFailureReporter();

  // No baseUrl and no apiKey: overriding a built-in provider inherits both its
  // auth methods, and the placeholder key the previous version passed now
  // composes into a real api-key method that fails to resolve.
  //
  // The headers, on the other hand, have to be said again. pi rebuilds every
  // model a refreshModels returns with `headers: undefined`, and Copilot
  // answers a request that arrives without `Editor-Version` with a 400. Lifting
  // them to the provider, where pi merges them into the resolved auth, is what
  // keeps the models this extension touched usable at all.
  pi.registerProvider(PROVIDER, {
    headers: sharedModelHeaders(builtInModels()),
    refreshModels: createCopilotModelRefresh({ builtInModels, onFailure: failures.report }),
  });

  pi.on("session_start", async (_event, ctx) => {
    failures.bindTo((reason) =>
      ctx.ui.notify(
        `copilot-model-limits: ${reason}. pi's own catalog values are showing and may not match your Copilot account.`,
        "error",
      ),
    );
    await refreshOnSessionStart(ctx);
  });
}
