/**
 * amp-ui
 *
 * Amp-inspired UI for pi: rounded editor chrome with model, thinking level,
 * context usage and working status on its borders, compact user messages,
 * Amp-style rendering for the built-in tools, and theme switching that follows
 * the device appearance. The themes themselves live in `pi/themes`.
 *
 * Forked from amp-themes (MIT, Frank); see the README. Each part stays its own
 * extension module; this one only activates them together.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ampAppearance from "./amp-appearance.ts";
import ampEditor from "./amp-editor.ts";
import ampToolDisplay from "./amp-tool-display.ts";
import ampUserMessage from "./amp-user-message.ts";

export default function (pi: ExtensionAPI): void {
  ampAppearance(pi);
  ampEditor(pi);
  ampToolDisplay(pi);
  ampUserMessage(pi);
}
