/**
 * Unit tests for the bash call header: the live elapsed time while running and
 * the recorded duration once the command finished.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { buildBashCallText, renderBashCall } from "./amp-tools-bash.ts";
import type { AmpToolRenderContext, RenderTheme } from "./amp-tool-render.ts";

/** Theme stub that tags output so assertions can see which color was applied. */
const theme: RenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `*${text}*`,
};

function finished(durationMs: number | undefined): AmpToolRenderContext {
  return {
    args: { command: "make" },
    state: {},
    executionStarted: true,
    isPartial: false,
    isError: false,
    invalidate: () => {},
    durationMs,
  };
}

/** The header line of a rendered call, without padding. */
function header(context: AmpToolRenderContext): string {
  const text = renderBashCall({ command: "make" }, theme as Theme, context) as Text;
  return text.render(200).map((line) => line.trim()).filter(Boolean).join("\n");
}

describe("buildBashCallText", () => {
  test("appends the elapsed time when given", () => {
    assert.equal(
      buildBashCallText({ command: "make" }, theme, undefined, 65_000),
      "<toolTitle>*$*</toolTitle> <accent>make</accent><muted> · 1m 5s</muted>",
    );
  });

  test("shows no time when none is given", () => {
    assert.equal(
      buildBashCallText({ command: "make" }, theme, undefined, undefined),
      "<toolTitle>*$*</toolTitle> <accent>make</accent>",
    );
  });
});

describe("renderBashCall once finished", () => {
  test("shows the recorded duration", () => {
    assert.match(header(finished(12_400)), /<muted> · 12s<\/muted>$/);
  });

  test("leaves out durations under a second", () => {
    assert.doesNotMatch(header(finished(400)), /·/);
  });

  test("shows no duration when none was recorded", () => {
    assert.doesNotMatch(header(finished(undefined)), /·/);
  });
});
