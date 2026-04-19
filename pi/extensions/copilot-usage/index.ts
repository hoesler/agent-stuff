/**
 * Copilot Usage Extension for pi
 *
 * Shows GitHub Copilot premium request usage via /copilot-usage command.
 * Uses pi's existing Copilot OAuth token — no separate PAT needed.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

interface QuotaSnapshot {
  percent_remaining: number;
  remaining: number;
  entitlement: number;
  overage_count: number;
  unlimited: boolean;
}

interface CopilotUser {
  quota_snapshots: {
    premium_interactions?: QuotaSnapshot;
  };
}

interface AuthJson {
  "github-copilot"?: {
    refresh?: string;
  };
}

async function getOAuthToken(): Promise<string | null> {
  try {
    const raw = await readFile(AUTH_PATH, "utf8");
    const auth = JSON.parse(raw) as AuthJson;
    return auth["github-copilot"]?.refresh ?? null;
  } catch {
    return null;
  }
}

async function showCopilotUsage(ctx: ExtensionContext): Promise<void> {
  const token = await getOAuthToken();

  if (!token) {
    ctx.ui.notify("Copilot: not logged in (run /login)", "warning");
    return;
  }

  ctx.ui.setWorkingMessage("Fetching Copilot usage...");

  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      ctx.ui.notify(`Copilot: API error ${res.status}`, "error");
      return;
    }

    const data = (await res.json()) as CopilotUser;
    const quota = data.quota_snapshots?.premium_interactions;

    if (!quota) {
      ctx.ui.notify("Copilot: no quota data available", "warning");
      return;
    }

    if (quota.unlimited) {
      ctx.ui.notify("Copilot: unlimited plan", "info");
      return;
    }

    const pct = Math.round(100 - quota.percent_remaining);
    const entitlement = quota.entitlement.toLocaleString();
    const overage = quota.overage_count > 0 ? ` (+${quota.overage_count} overage)` : "";

    // Determine remaining string and message type
    let remainingText: string;
    const isExhausted = quota.remaining <= 0;

    if (isExhausted) {
      remainingText = quota.remaining < 0 ? `${Math.abs(quota.remaining)} over limit` : "exhausted";
    } else {
      remainingText = `${quota.remaining.toLocaleString()}/${entitlement} remaining`;
    }

    // Color: red if exhausted or 90%+, yellow if 75%+, otherwise green
    const type: "info" | "warning" | "error" = isExhausted || pct >= 90 ? "error" : pct >= 75 ? "warning" : "info";

    const message = `Copilot: ${pct}% used (${remainingText})${overage}`;

    // Use widget for colored message without prefix (auto-clears after 5 seconds)
    const color = type === "error" ? "error" : type === "warning" ? "warning" : "accent";
    ctx.ui.setWidget("copilot-usage", [
        ctx.ui.theme.fg(color, message)
    ]);

    // Auto-clear after 5 seconds
    setTimeout(() => {
        ctx.ui.setWidget("copilot-usage", undefined);
    }, 5000);
  } catch {
    ctx.ui.notify("Copilot: fetch failed", "error");
  } finally {
    ctx.ui.setWorkingMessage(undefined);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copilot-usage", {
    description: "Show GitHub Copilot usage",
    handler: async (_args, ctx) => {
      await showCopilotUsage(ctx);
    },
  });
}