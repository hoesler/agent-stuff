/**
 * The refresh pi calls on the inovex provider.
 *
 * Split from the extension entry point so its decisions — when to reach for the
 * network, what to hand back on a pass that may not, and when a failure is worth
 * saying — can be tested without a gateway key.
 */

import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Catalog, type ChatModelConfig, toProviderModels } from "./enrich.ts";
import { fetchGatewayModels, GatewayError, type GatewayModel } from "./gateway.ts";

/**
 * The part of pi's RefreshModelsContext this refresh reads. Narrowed by hand so
 * a test can build one, and so a later pi release adding fields cannot break
 * the build here.
 */
export interface RefreshContext {
  allowNetwork: boolean;
  signal: AbortSignal;
}

export interface GatewayRefreshDeps {
  /** The snapshot's list, until the gateway gives a newer one. */
  initial: readonly GatewayModel[];
  /** pi's catalog, read afresh on every pass. */
  catalog: () => Catalog;
  /** The gateway key, or undefined when the environment has none. */
  token: () => string | undefined;
  fetchModels?: typeof fetchGatewayModels;
  saveSnapshot: (models: readonly GatewayModel[]) => Promise<void>;
  /**
   * Told why the list could not be read, before the throw. pi's own network
   * pass swallows refresh errors, so without this an expired key would look
   * like a gateway that simply has the models it had yesterday.
   */
  onFailure?: (reason: string) => void;
}

/** pi's running catalog, through the one pi-ai specifier pi aliases for extensions. */
export function builtinCatalog(): Catalog {
  return {
    providers: getBuiltinProviders(),
    models: (provider) => getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]) as unknown as ChatModelConfig[],
  };
}

export function createGatewayRefresh({ initial, catalog, token, fetchModels, saveSnapshot, onFailure }: GatewayRefreshDeps) {
  let entries: readonly GatewayModel[] = initial;

  // pi's network pass and the one asked for on session start can trip over the
  // same trouble, so a reason is only worth saying once. A good read clears it,
  // and trouble that comes back is said again.
  let lastAnnounced: string | undefined;
  const announce = (reason: string) => {
    if (reason !== lastAnnounced) onFailure?.(reason);
    lastAnnounced = reason;
  };

  const current = () => toProviderModels(entries, catalog());

  async function refreshModels(context: RefreshContext): Promise<ChatModelConfig[]> {
    // A refreshModels return value replaces the provider's models, and pi
    // rebuilds the provider at the top of every pass. A cache-only pass that
    // handed back anything but the latest list would undo the last network one.
    if (!context.allowNetwork) return current();

    // No key, no question to ask. The sandbox injects it; until it does, the
    // snapshot's models stay listed and a request says what is missing.
    const key = token();
    if (!key) return current();

    let fetched: GatewayModel[];
    try {
      fetched = await (fetchModels ?? fetchGatewayModels)(key, context.signal);
    } catch (cause) {
      // pi aborts the previous pass for a provider whenever a new one starts,
      // so a cancelled request is routine. It is pi's to report. A pass that
      // ran out of time is not: the gateway stalled, and the list is stale.
      if (context.signal.aborted) {
        if ((context.signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError") {
          announce("the gateway did not answer in time");
        }
        throw cause;
      }
      announce(
        cause instanceof GatewayError
          ? cause.message
          : `the gateway could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      throw cause;
    }

    entries = fetched;
    lastAnnounced = undefined;
    try {
      await saveSnapshot(fetched);
    } catch (cause) {
      // The list is good; only the next startup misses it.
      announce(`the model list could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return current();
  }

  return { current, refreshModels };
}
