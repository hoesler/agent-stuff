/**
 * GitHub Copilot Model Limits Extension
 *
 * Fetches actual context window and max output token limits from the GitHub
 * Copilot /models API at startup, overriding the incorrect static values
 * from models.dev that pi ships with.
 *
 * This is a stopgap until https://github.com/earendil-works/pi/pull/2527 lands
 * in a pi release, which implements the same fix in pi-core.
 *
 * The extension:
 * 1. Reads the Copilot OAuth token from ~/.pi/agent/auth.json
 * 2. Fetches model capabilities from the Copilot /models API
 * 3. Patches the built-in github-copilot models with correct contextWindow/maxTokens
 * 4. Only uses picker-enabled models from the API for limit lookups
 *
 * Falls back silently to built-in models if the API call fails or no auth is available.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface CopilotModel {
  id: string;
  name: string;
  model_picker_enabled?: boolean;
  policy?: { state: string };
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
    };
    supports?: { vision?: boolean };
  };
}

interface AuthEntry {
  type: string;
  refresh: string;
  access: string;
  expires: number;
  enterpriseUrl?: string;
}

/**
 * Derive the Copilot API base URL from the token, matching pi-core's logic:
 * 1. Parse proxy-ep from the token (proxy.xxx → api.xxx)
 * 2. Fall back to copilot-api.{enterpriseDomain} for enterprise
 * 3. Fall back to api.individual.githubcopilot.com
 */
function getBaseUrl(token: string, enterpriseDomain?: string): string {
  const proxyMatch = token.match(/proxy-ep=([^;]+)/);
  if (proxyMatch) {
    return `https://${proxyMatch[1].replace(/^proxy\./, "api.")}`;
  }
  if (enterpriseDomain) {
    return `https://copilot-api.${enterpriseDomain}`;
  }
  return "https://api.individual.githubcopilot.com";
}

async function fetchCopilotModels(
  token: string,
  enterpriseDomain?: string,
): Promise<CopilotModel[]> {
  const baseUrl = getBaseUrl(token, enterpriseDomain);
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2025-05-01",
      ...COPILOT_HEADERS,
    },
  });

  if (!response.ok) {
    throw new Error(`Copilot /models API returned ${response.status}`);
  }

  const data = (await response.json()) as { data?: CopilotModel[] };
  return data.data ?? [];
}

/**
 * Resolve the path to pi-ai's models.generated.js by deriving it from the
 * pi-ai package entry point that jiti aliases for extensions.
 */
async function loadBuiltInCopilotModels(): Promise<Record<string, any> | undefined> {
  const piAiMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const modelsPath = join(dirname(piAiMain), "models.generated.js");
  const mod = await import(modelsPath);
  return mod.MODELS?.["github-copilot"];
}

export default async function copilotModelLimits(pi: ExtensionAPI) {
  // process.env.HOME may be undefined in pi's execution context
  const home = process.env.HOME || homedir();
  const authPath = join(home, ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) return;

  let auth: Record<string, AuthEntry>;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf-8"));
  } catch {
    return;
  }

  const copilotAuth = auth["github-copilot"];
  if (!copilotAuth?.access) return;
  if (copilotAuth.expires && copilotAuth.expires < Date.now()) return;

  let apiModels: CopilotModel[];
  try {
    apiModels = await fetchCopilotModels(copilotAuth.access, copilotAuth.enterpriseUrl);
  } catch {
    return; // Fail silently — built-in models remain
  }

  if (apiModels.length === 0) return;

  // Build lookup of API limits, keyed by model ID.
  // Only include picker-enabled models — this excludes internal/legacy models
  // (e.g. gpt-4o-mini-2024-07-18, text-embedding-*) and disabled ones.
  const limitsById = new Map<
    string,
    { contextWindow: number; maxTokens: number }
  >();

  for (const m of apiModels) {
    if (!m.model_picker_enabled) continue;

    const ctx = m.capabilities?.limits?.max_context_window_tokens;
    const out = m.capabilities?.limits?.max_output_tokens;

    if (ctx != null && out != null) {
      const entry = { contextWindow: ctx, maxTokens: out };
      limitsById.set(m.id, entry);
      // Also index by base name (strip date suffix like -2025-04-14)
      const base = m.id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
      if (base !== m.id && !limitsById.has(base)) {
        limitsById.set(base, entry);
      }
    }
  }

  // Load built-in model definitions to preserve api, compat, thinkingLevelMap, etc.
  let builtInModels: Record<string, any>;
  try {
    builtInModels = (await loadBuiltInCopilotModels()) ?? {};
  } catch {
    return;
  }

  if (Object.keys(builtInModels).length === 0) return;

  // Determine the correct base URL for this auth context
  const baseUrl = getBaseUrl(copilotAuth.access, copilotAuth.enterpriseUrl);

  // Build patched model list
  const patchedModels = [];
  const changes: string[] = [];

  for (const [modelId, model] of Object.entries(builtInModels) as [string, any][]) {
    const apiLimits = limitsById.get(modelId);

    const patchedContextWindow = apiLimits?.contextWindow ?? model.contextWindow;
    const patchedMaxTokens = apiLimits?.maxTokens ?? model.maxTokens;

    if (model.contextWindow !== patchedContextWindow || model.maxTokens !== patchedMaxTokens) {
      changes.push(
        `  ${modelId}: ctx ${model.contextWindow}→${patchedContextWindow}, max ${model.maxTokens}→${patchedMaxTokens}`,
      );
    }

    patchedModels.push({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl,
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap && { thinkingLevelMap: model.thinkingLevelMap }),
      input: model.input,
      cost: model.cost,
      contextWindow: patchedContextWindow,
      maxTokens: patchedMaxTokens,
      headers: COPILOT_HEADERS,
      ...(model.compat && { compat: model.compat }),
    });
  }

  if (patchedModels.length === 0) return;

  // registerProvider() validation requires baseUrl and apiKey/oauth at the
  // provider config level, even when overriding a built-in provider. The baseUrl
  // is already computed. The apiKey is a placeholder — OAuth credentials are used
  // at runtime and take precedence over this fallback in getApiKeyAndHeaders().
  pi.registerProvider("github-copilot", {
    baseUrl,
    apiKey: "__COPILOT_OAUTH__",
    models: patchedModels,
  });

  // Show a notification so users can verify the extension worked
  if (changes.length > 0) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `[copilot-model-limits] Patched ${changes.length} model(s) with API limits`,
        "info",
      );
    });
  }
}
