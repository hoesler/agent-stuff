/**
 * The refresh pi calls on the github-copilot provider.
 *
 * Split from the extension entry point so its decisions — when to reach for the
 * network, when to hand pi its own list back, and when to let a failure show —
 * can be tested without a Copilot account.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { applyCopilotLimits, copilotApiBaseUrl, enterpriseDomain, parseCopilotLimits } from "./limits.ts";

/**
 * The part of pi's RefreshModelsContext this refresh reads. Narrowed by hand so
 * a test can build one, and so a later pi release adding fields cannot break
 * the build here.
 */
export interface RefreshContext {
  allowNetwork: boolean;
  credential?: { readonly type: string };
  signal?: AbortSignal;
}

/** The two fields a Copilot OAuth credential is read for, once it is known to be one. */
interface CopilotCredential {
  access: string;
  enterpriseUrl?: unknown;
}

function copilotCredential(credential: RefreshContext["credential"]): CopilotCredential | undefined {
  // /models answers to the Copilot proxy token that OAuth mints. A
  // COPILOT_GITHUB_TOKEN api key is an ordinary GitHub PAT and cannot read it.
  if (credential?.type !== "oauth") return undefined;
  const oauth = credential as { access?: unknown; enterpriseUrl?: unknown };
  return typeof oauth.access === "string" ? { access: oauth.access, enterpriseUrl: oauth.enterpriseUrl } : undefined;
}

export interface CopilotRefreshDeps {
  /** pi's own Copilot catalog, read afresh on every refresh. */
  builtInModels: () => ProviderModelConfig[];
  /** Defaults to the ambient fetch, looked up per call so a later swap is honoured. */
  fetchModels?: typeof globalThis.fetch;
  /**
   * Told why the limits could not be read, just before the throw.
   *
   * Throwing is not enough on its own. pi surfaces a refresh error in the model
   * picker, but the pass that actually reads the limits is the one interactive
   * mode fires after startup, and that one ends in `.catch(() => {})` without
   * ever reading `result.errors`. A Copilot account that could not be read
   * would otherwise sit there showing pi's catalog values as if they were its
   * own.
   */
  onFailure?: (reason: string) => void;
}

/** What the Copilot API expects to hear from an editor. */
const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const COPILOT_API_VERSION = "2026-06-01";

export function createCopilotModelRefresh({ builtInModels, fetchModels, onFailure }: CopilotRefreshDeps) {
  const request: typeof globalThis.fetch = (...args) => (fetchModels ?? globalThis.fetch)(...args);

  // pi's own network pass and the pass the extension asks for on session start
  // can both trip over the same trouble, so the reason is only worth saying
  // once. A good read clears it, and trouble that comes back is said again.
  let lastAnnounced: string | undefined;

  const announce = (reason: string) => {
    if (reason !== lastAnnounced) onFailure?.(reason);
    lastAnnounced = reason;
  };

  /** Say it, then throw it, so neither pi nor the user is left guessing. */
  const fail = (reason: string): never => {
    announce(reason);
    throw new Error(reason);
  };

  return async function refreshModels(context: RefreshContext): Promise<ProviderModelConfig[]> {
    const models = builtInModels();

    // pi's cache-only pass. It wants the current list, not a round trip.
    if (!context.allowNetwork) return models;

    const credential = copilotCredential(context.credential);
    if (!credential) return models;

    const baseUrl = copilotApiBaseUrl(credential.access, enterpriseDomain(credential.enterpriseUrl));

    // From here on a failure is reported rather than absorbed. Limits it could
    // not read should not look read.
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(`${baseUrl}/models`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.access}`,
          "X-GitHub-Api-Version": COPILOT_API_VERSION,
          ...COPILOT_HEADERS,
        },
        signal: context.signal,
      });
    } catch (cause) {
      // pi aborts the previous pass for a provider whenever a new one starts,
      // so a cancelled request is routine and stays quiet. It is pi's to report.
      if (context.signal?.aborted) throw cause;
      announce(`Copilot /models could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw cause;
    }

    if (!response.ok) {
      fail(`Copilot /models answered ${response.status} ${response.statusText}`);
    }

    const limits = parseCopilotLimits(await response.json());
    if (limits.size === 0) {
      fail("Copilot /models reported no usable token limits");
    }

    lastAnnounced = undefined;
    return applyCopilotLimits(models, limits);
  };
}
