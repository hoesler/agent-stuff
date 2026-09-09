import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import copilotModelLimits from "./index.ts";

function registration(): { name?: string; config?: ProviderConfig } {
  const seen: { name?: string; config?: ProviderConfig } = {};
  const pi = {
    registerProvider(name: string, config: ProviderConfig) {
      seen.name = name;
      seen.config = config;
    },
  } as unknown as ExtensionAPI;
  copilotModelLimits(pi);
  return seen;
}

test("the refresh is registered on pi's own Copilot provider", () => {
  const { name, config } = registration();
  assert.equal(name, "github-copilot");
  assert.equal(typeof config?.refreshModels, "function");
});

// pi strips the headers off every model a refreshModels returns, and Copilot
// answers a request without Editor-Version with a 400. Registering them on the
// provider is what puts them back.
test("the headers pi's Copilot models carry are registered on the provider", () => {
  const { config } = registration();
  assert.equal(config?.headers?.["Editor-Version"], "vscode/1.107.0");
  assert.equal(config?.headers?.["Copilot-Integration-Id"], "vscode-chat");
});
