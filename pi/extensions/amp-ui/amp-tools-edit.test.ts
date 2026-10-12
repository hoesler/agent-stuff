/**
 * Unit tests for the `edit` and `write` result rendering logic.
 *
 * We test the pure `build*ResultText` helpers directly (the renderers are thin
 * `new Text(build…)` wrappers), driving them with a tagging theme stub
 * (`<color>…</color>` instead of ANSI). This keeps the assertions independent
 * of the `Text` component's word-wrapping/padding AND of `renderDiff`'s ANSI
 * output: the diff branch is covered by passing a pre-colored string with
 * `hasDiff: true`, exercising the exact collapse code path `renderEditResult`
 * feeds `renderDiff(...)` into.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTheme, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { buildEditResultText, buildWriteResultText, renderEditCall, renderEditResult } from "./amp-tools-edit.ts";
import type { AmpToolRenderContext, RenderTheme } from "./amp-tool-render.ts";

/** Theme stub that tags output so assertions can see which color was applied. */
const theme: RenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `*${text}*`,
};

const collapsed: ToolRenderResultOptions = { expanded: false } as ToolRenderResultOptions;
const expanded: ToolRenderResultOptions = { expanded: true } as ToolRenderResultOptions;

function nLines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

describe("buildEditResultText (plain output / no diff)", () => {
  test("collapses output to the configured 8-line preview limit", () => {
    const out = buildEditResultText(nLines(12), false, collapsed, theme);
    assert.ok(out.includes("line 1"));
    assert.ok(out.includes("line 8"));
    assert.ok(!out.includes("line 9"));
    assert.ok(out.includes("(4 more lines)"));
  });

  test("wraps the plain-output branch in the tool-output color", () => {
    const out = buildEditResultText("just text", false, collapsed, theme);
    assert.ok(out.includes("<toolOutput>just text</toolOutput>"));
  });

  test("expands to show every line with no 'more' hint", () => {
    const out = buildEditResultText(nLines(12), false, expanded, theme);
    assert.ok(out.includes("line 12"));
    assert.ok(!out.includes("more line"));
  });

  test("singular 'more line' when exactly one line is hidden", () => {
    const out = buildEditResultText(nLines(9), false, collapsed, theme);
    assert.ok(out.includes("(1 more line)"));
    assert.ok(!out.includes("more lines"));
  });

  test("reports no changes for empty content", () => {
    assert.ok(buildEditResultText("", false, collapsed, theme).includes("edit: no changes"));
  });
});

describe("buildEditResultText (diff branch)", () => {
  test("emits the pre-colored diff verbatim, never re-coloring it", () => {
    const diff = "+added\n-removed\n unchanged";
    const out = buildEditResultText(diff, true, collapsed, theme);
    assert.ok(out.includes("+added"));
    assert.ok(out.includes("-removed"));
    // The diff carries its own colors -> not wrapped in <toolOutput>.
    assert.ok(!out.includes("<toolOutput>"));
  });

  test("collapses a long diff and counts the hidden diff lines", () => {
    const out = buildEditResultText(nLines(20, "@@"), true, collapsed, theme);
    assert.ok(out.includes("@@ 8"));
    assert.ok(!out.includes("@@ 9"));
    assert.ok(out.includes("(12 more lines)"));
  });
});

describe("buildWriteResultText", () => {
  test("header reports path and line count", () => {
    const out = buildWriteResultText("/tmp/file.txt", "a\nb\nc", collapsed, theme);
    assert.ok(out.includes("wrote"));
    assert.ok(out.includes("/tmp/file.txt"));
    assert.ok(out.includes("(3 lines)"));
  });

  test("a single trailing newline does not add a phantom line", () => {
    const out = buildWriteResultText("/tmp/file.txt", "a\nb\n", collapsed, theme);
    assert.ok(out.includes("(2 lines)"));
  });

  test("singular '(1 line)' for single-line content", () => {
    const out = buildWriteResultText("/tmp/x", "only", collapsed, theme);
    assert.ok(out.includes("(1 line)"));
    assert.ok(!out.includes("(1 lines)"));
  });

  test("empty content reports 0 lines and no preview body", () => {
    const out = buildWriteResultText("/tmp/x", "", collapsed, theme);
    assert.ok(out.includes("(0 lines)"));
    assert.ok(!out.includes("<toolOutput>"));
  });

  test("collapses the content preview and reports hidden lines", () => {
    const out = buildWriteResultText("/tmp/big", nLines(12, "row"), collapsed, theme);
    assert.ok(out.includes("(12 lines)"));
    assert.ok(out.includes("row 1"));
    assert.ok(out.includes("row 8"));
    assert.ok(!out.includes("row 9"));
    // write mirrors Pi's hint, which also reports the file's total line count.
    assert.ok(out.includes("(4 more lines, 12 total)"));
  });
});

describe("edit padding", () => {
  // The result's expand hint reads pi's global theme.
  initTheme("dark", false);

  function context(outputPad: number | undefined): AmpToolRenderContext {
    return {
      args: { path: "a.ts", edits: [] },
      state: {},
      executionStarted: true,
      isPartial: false,
      isError: false,
      invalidate: () => {},
      outputPad,
    };
  }

  /** Columns before the first visible character of a rendered component. */
  function indent(component: { render(width: number): string[] }): number {
    const line = component.render(80).find((l) => l.trim().length > 0) ?? "";
    return line.length - line.trimStart().length;
  }

  test("applies the outputPad setting, since edit draws its own shell", () => {
    const args = { path: "a.ts", edits: [] };
    const result = { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    assert.equal(indent(renderEditCall(args, theme as Theme, context(3))), 3);
    assert.equal(indent(renderEditResult(result, collapsed, theme as Theme, context(3))), 3);
  });

  test("falls back to one column before pi 1.1.0", () => {
    assert.equal(indent(renderEditCall({ path: "a.ts", edits: [] }, theme as Theme, context(undefined))), 1);
  });
});
