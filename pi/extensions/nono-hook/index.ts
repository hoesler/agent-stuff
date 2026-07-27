/**
 * nono-hook extension for pi
 * 
 * Detects when running inside the nono security sandbox and injects helpful
 * context when tool operations fail due to sandbox restrictions.
 * 
 * Installation:
 * - Place in ~/.pi/agent/extensions/nono-hook.ts (global, auto-loaded)
 * - Or use: pi -e ./nono-hook.ts
 * 
 * The extension automatically detects nono via the NONO_CAP_FILE environment variable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

interface NonoCapability {
    path: string;
    resolved?: string;
    access: "read" | "readwrite";
}

interface NonoCapFile {
    fs?: NonoCapability[];
    net_blocked?: boolean;
}

export default function (pi: ExtensionAPI) {
    // Check if we're inside a nono sandbox
    const capFile = process.env.NONO_CAP_FILE;

    if (!capFile) {
        // NONO_CAP_FILE is not set — not running inside the nono sandbox.
        // Prompt the user on startup so they don't accidentally run pi unsandboxed.
        pi.on("session_start", async (event, ctx) => {
            if (event.reason !== "startup") return;
            if (!ctx.hasUI) return; // headless mode — continue silently

            const ok = await ctx.ui.confirm(
                "Not in nono sandbox",
                "NONO_CAP_FILE is not set — pi is not running inside the nono security sandbox. Continue anyway?"
            );

            if (!ok) {
                ctx.shutdown();
            }
        });
        return;
    }

    if (!existsSync(capFile)) {
        return; // Cap file declared but missing — silent bail
    }

    // Read capabilities file
    let caps: NonoCapFile;
    try {
        const content = readFileSync(capFile, "utf-8");
        caps = JSON.parse(content);
    } catch {
        return; // Can't read cap file
    }

    // Build allowed paths string
    const allowedPaths = caps.fs?.map(cap => 
        `  ${cap.resolved ?? cap.path} (${cap.access})`
    ).join("\n") ?? "  (none)";

    const networkStatus = caps.net_blocked ? "blocked" : "allowed";

    // Create the context message to inject on errors
    const contextMessage = `[NONO SANDBOX - PERMISSION DENIED]

This error is LIKELY from the nono sandbox blocking the operation.

STOP. Do not try alternative approaches. This is a hard security boundary.

You are running inside the nono security sandbox. The operation you just attempted is PERMANENTLY BLOCKED for this session. There is NO workaround possible from inside this session.

ALLOWED PATHS (everything else is blocked):
${allowedPaths}
Network: ${networkStatus}

FORBIDDEN ACTIONS - DO NOT ATTEMPT:
- Trying alternative file paths
- Copying files to allowed locations
- Using sudo or changing permissions
- Suggesting the user run commands manually
- Any other workaround

REQUIRED ACTION:
Tell the user they must EXIT this pi session and restart with the needed path:

  nono run --allow /path/to/needed -- pi

This is the ONLY solution. The sandbox cannot be modified from within.`;

    // Subscribe to tool_execution_end to modify error results
    pi.on("tool_execution_end", async (event) => {
        if (!event.isError) {
            return;
        }

        const result = event.result as any;
        if (!result || !result.content) {
            return;
        }

        const textContent = result.content.find((c: any) => c.type === "text");
        if (!textContent) {
            return;
        }

        const errorText = textContent.text.toLowerCase();

        // Detect permission/sandbox errors (conservative - only definite permission errors)
        const isPermissionError = 
            errorText.includes("permission denied") ||
            errorText.includes("operation not permitted") ||
            errorText.includes("eperm") ||
            errorText.includes("eacces") ||
            errorText.includes("cannot access");

        if (!isPermissionError) {
            return;
        }

        // Modify the result in place
        textContent.text = contextMessage + "\n\n---\n\nOriginal error:\n" + textContent.text;
    });
}