import { homedir } from "node:os";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BASH_SPINNER_FRAMES,
  BASH_SPINNER_INTERVAL_MS,
  bashTruncationHint,
  buildHeaderLine,
  collapseForPreview,
  extractTextOutput,
  formatElapsed,
  formatReadRange,
  formatSize,
  getExpandedPreviewLineLimit,
  getOrCreateSpinnerState,
  moreHint,
  previewLines,
  shortenPath,
  splitLines,
  statusColor,
  statusIcon,
  stopSpinner,
  TOOL_VERBS,
  truncationHint,
  verbFor,
  type RenderTheme,
} from "./amp-tool-render.ts";

/** A theme stub that tags output so assertions can see which color was applied. */
const theme: RenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `*${text}*`,
};

describe("extractTextOutput", () => {
  test("joins text content blocks with newlines", () => {
    const result = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    };
    assert.equal(extractTextOutput(result), "line one\nline two");
  });

  test("ignores non-text blocks and malformed entries", () => {
    const result = {
      content: [
        { type: "image", data: "..." },
        { type: "text", text: "kept" },
        { type: "text" },
        null,
        "raw string",
      ],
    };
    assert.equal(extractTextOutput(result), "kept");
  });

  test("returns empty string when content is missing or not an array", () => {
    assert.equal(extractTextOutput({}), "");
    assert.equal(extractTextOutput({ content: "nope" }), "");
  });
});

describe("shortenPath", () => {
  test("collapses the home directory to ~", () => {
    const home = homedir();
    assert.equal(shortenPath(`${home}/projects/app.ts`), "~/projects/app.ts");
  });

  test("leaves non-home paths untouched", () => {
    assert.equal(shortenPath("/etc/hosts"), "/etc/hosts");
  });

  test("returns empty string for undefined", () => {
    assert.equal(shortenPath(undefined), "");
  });
});

describe("splitLines", () => {
  test("normalises CRLF and expands tabs", () => {
    assert.deepEqual(splitLines("a\r\n\tb"), ["a", "    b"]);
  });

  test("returns empty array for empty string", () => {
    assert.deepEqual(splitLines(""), []);
  });
});

describe("previewLines", () => {
  test("reports shown lines and remaining count", () => {
    const lines = ["1", "2", "3", "4", "5"];
    const { shown, remaining } = previewLines(lines, 3);
    assert.deepEqual(shown, ["1", "2", "3"]);
    assert.equal(remaining, 2);
  });

  test("remaining is zero when all lines fit", () => {
    const { shown, remaining } = previewLines(["a", "b"], 8);
    assert.deepEqual(shown, ["a", "b"]);
    assert.equal(remaining, 0);
  });

  test("clamps a negative limit to zero", () => {
    const { shown, remaining } = previewLines(["a", "b"], -5);
    assert.deepEqual(shown, []);
    assert.equal(remaining, 2);
  });
});

describe("getExpandedPreviewLineLimit", () => {
  const lines = Array.from({ length: 100 }, (_, i) => String(i));

  test("caps at the configured max", () => {
    assert.equal(getExpandedPreviewLineLimit(lines, { expandedPreviewMaxLines: 40 }), 40);
  });

  test("never exceeds the number of available lines", () => {
    assert.equal(getExpandedPreviewLineLimit(lines, { expandedPreviewMaxLines: 4000 }), 100);
  });

  test("zero means show all lines", () => {
    assert.equal(getExpandedPreviewLineLimit(lines, { expandedPreviewMaxLines: 0 }), 100);
  });
});

describe("collapseForPreview", () => {
  const lines = Array.from({ length: 20 }, (_, i) => String(i));
  const config = { previewLines: 8, expandedPreviewMaxLines: 4000 };

  test("collapsed uses config.previewLines", () => {
    const { shown, remaining } = collapseForPreview(lines, false, config);
    assert.equal(shown.length, 8);
    assert.equal(remaining, 12);
  });

  test("expanded uses the expanded limit", () => {
    const { shown, remaining } = collapseForPreview(lines, true, {
      previewLines: 8,
      expandedPreviewMaxLines: 5,
    });
    assert.equal(shown.length, 5);
    assert.equal(remaining, 15);
  });

  test("expanded with max 0 shows all lines", () => {
    const { shown, remaining } = collapseForPreview(lines, true, {
      previewLines: 8,
      expandedPreviewMaxLines: 0,
    });
    assert.equal(shown.length, 20);
    assert.equal(remaining, 0);
  });

  test("an overridden previewLines budget is honoured when collapsed", () => {
    const { shown, remaining } = collapseForPreview(lines, false, {
      previewLines: 10,
      expandedPreviewMaxLines: 4000,
    });
    assert.equal(shown.length, 10);
    assert.equal(remaining, 10);
  });
});

describe("moreHint", () => {
  test("returns a muted hint when lines were hidden", () => {
    assert.equal(moreHint(3, theme), "<muted>… (3 more lines)</muted>");
  });

  test("singular for a single hidden line", () => {
    assert.equal(moreHint(1, theme), "<muted>… (1 more line)</muted>");
  });

  test("returns empty string when nothing was hidden", () => {
    assert.equal(moreHint(0, theme), "");
    assert.equal(moreHint(-2, theme), "");
  });

  test("appends a total segment when given", () => {
    assert.equal(moreHint(4, theme, { total: 12 }), "<muted>… (4 more lines, 12 total)</muted>");
  });

  test("appends a pre-rendered expand hint outside the muted wrap", () => {
    assert.equal(moreHint(3, theme, { expandHint: "<dim>ctrl+o</dim> to expand" }), "<muted>… (3 more lines,</muted> <dim>ctrl+o</dim> to expand<muted>)</muted>");
  });

  test("combines total and expand hint", () => {
    assert.equal(moreHint(4, theme, { total: 12, expandHint: "X" }), "<muted>… (4 more lines, 12 total,</muted> X<muted>)</muted>");
  });

  test("no hint emitted when nothing hidden, even with opts", () => {
    assert.equal(moreHint(0, theme, { total: 9, expandHint: "X" }), "");
  });
});

describe("formatReadRange", () => {
  test("whole-file read (no bounds) shows no range", () => {
    assert.equal(formatReadRange(undefined, undefined), "");
  });

  test("offset is 1-indexed and the end line is inclusive", () => {
    // Pi reads 15 lines from line 1 -> lines 1..15, not 1..16.
    assert.equal(formatReadRange(1, 15), ":1-15");
    assert.equal(formatReadRange(11, 15), ":11-25");
  });

  test("offset defaults to 1 when only a limit is given", () => {
    assert.equal(formatReadRange(undefined, 20), ":1-20");
  });

  test("open-ended read (offset, no limit) shows a bare line with no trailing dash", () => {
    assert.equal(formatReadRange(40, undefined), ":40");
  });
});

describe("verb map", () => {
  test("known tools map to their canonical verbs", () => {
    assert.equal(TOOL_VERBS.read, "read");
    assert.equal(TOOL_VERBS.bash, "$");
    assert.equal(TOOL_VERBS.mcp, "MCP");
    assert.equal(verbFor("grep"), "grep");
  });

  test("unknown tool falls back to its own name", () => {
    assert.equal(verbFor("custom_tool"), "custom_tool");
  });
});

describe("buildHeaderLine", () => {
  test("colors verb, primary, and muted suffix", () => {
    const line = buildHeaderLine("read", "src/app.ts", " :1-40", theme);
    assert.equal(line, "<toolTitle>*read*</toolTitle> <accent>src/app.ts</accent><muted> :1-40</muted>");
  });

  test("omits primary and suffix when empty", () => {
    assert.equal(buildHeaderLine("ls", "", "", theme), "<toolTitle>*ls*</toolTitle>");
  });
});

describe("formatSize", () => {
  test("bytes, KB, and MB thresholds match Pi", () => {
    assert.equal(formatSize(512), "512B");
    assert.equal(formatSize(50 * 1024), "50.0KB");
    assert.equal(formatSize(1024 * 1024), "1.0MB");
  });
});

describe("truncationHint (Pi-aligned wording)", () => {
  test("grep: matches limit, byte limit, and partial-line note join", () => {
    assert.equal(truncationHint(
        "grep",
        { matchLimitReached: 50, truncation: { truncated: true, maxBytes: 50 * 1024 }, linesTruncated: true },
        theme,
      ), "<warning>[Truncated: 50 matches limit, 50.0KB limit, some lines truncated]</warning>");
  });

  test("find: results limit only", () => {
    assert.equal(truncationHint("find", { resultLimitReached: 100 }, theme), "<warning>[Truncated: 100 results limit]</warning>");
  });

  test("ls: entries limit only", () => {
    assert.equal(truncationHint("ls", { entryLimitReached: 200 }, theme), "<warning>[Truncated: 200 entries limit]</warning>");
  });

  test("read: line-limit truncation reports shown/total and the line cap", () => {
    assert.equal(truncationHint(
        "read",
        { truncation: { truncated: true, truncatedBy: "lines", outputLines: 2000, totalLines: 5000, maxLines: 2000 } },
        theme,
      ), "<warning>[Truncated: showing 2000 of 5000 lines (2000 line limit)]</warning>");
  });

  test("read: byte-limit truncation reports lines shown and the size cap", () => {
    assert.equal(truncationHint(
        "read",
        { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 30, maxBytes: 50 * 1024 } },
        theme,
      ), "<warning>[Truncated: 30 lines shown (50.0KB limit)]</warning>");
  });

  test("read: a first line over the byte limit is called out", () => {
    assert.equal(truncationHint("read", { truncation: { truncated: true, firstLineExceedsLimit: true, maxBytes: 50 * 1024 } }, theme), "<warning>[First line exceeds 50.0KB limit]</warning>");
  });

  test("returns empty string when nothing was truncated", () => {
    assert.equal(truncationHint("read", undefined, theme), "");
    assert.equal(truncationHint("ls", { truncation: { truncated: false } }, theme), "");
    assert.equal(truncationHint("find", {}, theme), "");
  });
});

describe("bashTruncationHint", () => {
  test("joins the spill-file note and the truncation note with '. '", () => {
    assert.equal(bashTruncationHint(
        { fullOutputPath: "/tmp/out.txt", truncation: { truncated: true, truncatedBy: "lines", outputLines: 10, totalLines: 99 } },
        theme,
      ), "<warning>[Full output: /tmp/out.txt. Truncated: showing 10 of 99 lines]</warning>");
  });

  test("spill-file path is shortened to ~", () => {
    const out = bashTruncationHint({ fullOutputPath: `${homedir()}/x/out.txt` }, theme);
    assert.equal(out, "<warning>[Full output: ~/x/out.txt]</warning>");
  });

  test("byte-limit truncation reports the size cap", () => {
    assert.equal(bashTruncationHint({ truncation: { truncated: true, truncatedBy: "bytes", outputLines: 5, maxBytes: 50 * 1024 } }, theme), "<warning>[Truncated: 5 lines shown (50.0KB limit)]</warning>");
  });

  test("returns empty string when neither truncated nor spilled", () => {
    assert.equal(bashTruncationHint(undefined, theme), "");
    assert.equal(bashTruncationHint({ truncation: { truncated: false } }, theme), "");
  });
});

describe("status helpers", () => {
  test("icon reflects error state", () => {
    assert.equal(statusIcon(false), "✓");
    assert.equal(statusIcon(true), "✗");
  });

  test("color reflects error state", () => {
    assert.equal(statusColor(false), "success");
    assert.equal(statusColor(true), "error");
  });
});

describe("formatElapsed", () => {
  test("seconds under a minute", () => {
    assert.equal(formatElapsed(5_000), "5s");
    assert.equal(formatElapsed(0), "0s");
  });

  test("minutes and seconds", () => {
    assert.equal(formatElapsed(75_000), "1m 15s");
  });

  test("hours and minutes", () => {
    assert.equal(formatElapsed(3_700_000), "1h 1m");
  });

  test("clamps negatives to 0s", () => {
    assert.equal(formatElapsed(-100), "0s");
  });
});

describe("bash spinner constants", () => {
  test("ten braille frames at 80ms", () => {
    assert.equal(BASH_SPINNER_FRAMES.length, 10);
    assert.equal(BASH_SPINNER_FRAMES[0], "⠋");
    assert.equal(BASH_SPINNER_INTERVAL_MS, 80);
  });
});

describe("spinner state lifecycle", () => {
  test("creates state on a carrier object and reuses it", () => {
    const carrier: Record<string, unknown> = {};
    const first = getOrCreateSpinnerState(carrier);
    const second = getOrCreateSpinnerState(carrier);
    assert.notEqual(first, undefined);
    assert.equal(first, second);
    assert.equal(first?.frameIndex, 0);
  });

  test("returns undefined for non-object carriers", () => {
    assert.equal(getOrCreateSpinnerState(undefined), undefined);
    assert.equal(getOrCreateSpinnerState(42), undefined);
  });

  test("stopSpinner clears the timer and resets fields", () => {
    const carrier: Record<string, unknown> = {};
    const state = getOrCreateSpinnerState(carrier);
    assert.notEqual(state, undefined);
    if (!state) return;
    state.startedAt = Date.now();
    state.frameIndex = 3;
    state.timer = setInterval(() => {}, 1000);
    stopSpinner(state);
    assert.equal(state.timer, undefined);
    assert.equal(state.frameIndex, 0);
    assert.equal(state.startedAt, undefined);
  });

  test("stopSpinner is safe on undefined", () => {
    assert.doesNotThrow(() => stopSpinner(undefined));
  });
});
