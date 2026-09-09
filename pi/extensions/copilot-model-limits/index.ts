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
 */

import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { sharedModelHeaders } from "./headers.ts";
import { createCopilotModelRefresh } from "./refresh.ts";

const PROVIDER = "github-copilot";

export default function copilotModelLimits(pi: ExtensionAPI) {
  const builtInModels = () => getBuiltinModels(PROVIDER) as unknown as ProviderModelConfig[];

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
    refreshModels: createCopilotModelRefresh({ builtInModels }),
  });
}
