import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export function thinkingColorFor(level: string): ThemeColor {
  switch (level) {
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    default: return "thinkingOff";
  }
}
