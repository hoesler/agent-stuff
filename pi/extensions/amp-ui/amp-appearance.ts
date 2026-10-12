import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Appearance = "dark" | "light";

export interface AppearanceProbes {
  /** Explicit user setting; wins when set. */
  override: Appearance | null;
  /** macOS system setting, or null when not macOS. */
  mac: () => Appearance | null;
  /** OSC 11 terminal-background result, or null when unavailable. */
  osc: () => Appearance | null;
}

export function detectAppearance(probes: AppearanceProbes): Appearance {
  return probes.override ?? probes.mac() ?? probes.osc() ?? "dark";
}

const OSC11_REPLY = /\x1b\]11;rgb:([0-9a-f]{2,4})\/([0-9a-f]{2,4})\/([0-9a-f]{2,4})/i;

function channel(hex: string): number {
  // Normalize 1-4 hex digits to 0..1.
  const max = (1 << (hex.length * 4)) - 1;
  return parseInt(hex, 16) / max;
}

export function appearanceFromOscReply(reply: string): Appearance | null {
  const m = OSC11_REPLY.exec(reply);
  if (!m) return null;
  // Rec. 601 luma; >0.5 is a light background.
  const luma = 0.299 * channel(m[1]!) + 0.587 * channel(m[2]!) + 0.114 * channel(m[3]!);
  return luma > 0.5 ? "light" : "dark";
}

export function oscAppearanceProbe(): Appearance | null {
  // Pi owns stdin in raw mode, so a live OSC 11 round-trip is unsafe for now.
  // This stays a no-op stub until a safe stdin-observer path lands; the parser
  // (appearanceFromOscReply) is unit-tested and ready for it.
  return null;
}

/** macOS: `defaults read -g AppleInterfaceStyle` prints "Dark" in dark mode and
 * errors (key absent) in light mode. Returns null off macOS. */
export function macAppearanceProbe(): Appearance | null {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
    return out === "Dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const THEME_FOR: Record<Appearance, string> = { dark: "amp-dark", light: "amp-light" };
const AMP_THEMES = new Set(Object.values(THEME_FOR));

/** Explicit manual override via the AMP_APPEARANCE env var ("dark"|"light"). */
export function readOverride(): Appearance | null {
  const raw = process.env.AMP_APPEARANCE?.trim().toLowerCase();
  return raw === "dark" || raw === "light" ? raw : null;
}

export function syncTheme(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  // Only manage the theme when an amp theme is active; never override a user who
  // explicitly picked a non-amp theme.
  const active = ctx.ui.theme?.name;
  if (active && !AMP_THEMES.has(active)) return;

  const appearance = detectAppearance({
    override: readOverride(),
    mac: macAppearanceProbe,
    osc: oscAppearanceProbe,
  });
  const target = THEME_FOR[appearance];
  if (active !== target) {
    const result = ctx.ui.setTheme(target);
    if (!result.success) {
      ctx.ui.notify(`amp-appearance: could not switch to ${target}${result.error ? `: ${result.error}` : ""}`, "warning");
    }
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => syncTheme(ctx));
  pi.on("before_agent_start", (_event, ctx) => syncTheme(ctx));
}
