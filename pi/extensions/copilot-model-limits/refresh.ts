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
}

/** What the Copilot API expects to hear from an editor. */
const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

const COPILOT_API_VERSION = "2026-06-01";

export function createCopilotModelRefresh({ builtInModels, fetchModels }: CopilotRefreshDeps) {
  const request: typeof globalThis.fetch = (...args) => (fetchModels ?? globalThis.fetch)(...args);

  return async function refreshModels(context: RefreshContext): Promise<ProviderModelConfig[]> {
    const models = builtInModels();

    // pi's cache-only pass. It wants the current list, not a round trip.
    if (!context.allowNetwork) return models;

    const credential = copilotCredential(context.credential);
    if (!credential) return models;

    const baseUrl = copilotApiBaseUrl(credential.access, enterpriseDomain(credential.enterpriseUrl));
    const response = await request(`${baseUrl}/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.access}`,
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
        ...COPILOT_HEADERS,
      },
      signal: context.signal,
    });

    // From here on a failure is reported rather than absorbed. pi shows it as
    // "Could not refresh github-copilot; showing cached models.", which is the
    // point of the extension: limits it could not read should not look read.
    if (!response.ok) {
      throw new Error(`Copilot /models answered ${response.status} ${response.statusText}`);
    }

    const limits = parseCopilotLimits(await response.json());
    if (limits.size === 0) {
      throw new Error("Copilot /models reported no usable token limits");
    }

    return applyCopilotLimits(models, limits);
  };
}
