import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const requiredColorTokens = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

const extensionDir = dirname(fileURLToPath(import.meta.url));
const themesDir = join(extensionDir, "..", "..", "themes");

type ThemeFile = {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
};

function readTheme(fileName: string): ThemeFile {
  return JSON.parse(readFileSync(join(themesDir, fileName), "utf8")) as ThemeFile;
}

test("extension source imports Pi packages from the current namespace", () => {
  const extensionFiles = readdirSync(extensionDir)
    .filter((fileName) => fileName.endsWith(".ts"))
    .filter((fileName) => !fileName.endsWith(".test.ts"));

  for (const fileName of extensionFiles) {
    const source = readFileSync(join(extensionDir, fileName), "utf8");

    assert.ok(!source.includes("@mariozechner/pi-coding-agent"), fileName);
    assert.ok(!source.includes("@mariozechner/pi-tui"), fileName);
  }
});

for (const [fileName, expectedName] of [
  ["amp-dark.json", "amp-dark"],
  ["amp-light.json", "amp-light"],
  ["amp-gruvbox-dark-hard.json", "amp-gruvbox-dark-hard"],
]) {
  test(`${fileName} defines every required Pi color token`, () => {
    const theme = readTheme(fileName);

    assert.equal(theme.name, expectedName);
    assert.deepEqual(Object.keys(theme.colors).sort(), [...requiredColorTokens].sort());

    for (const [token, value] of Object.entries(theme.colors)) {
      assert.notEqual(value, "", `${fileName}:${token}`);
    }
  });
}


test("amp-gruvbox-dark-hard uses the canonical Gruvbox dark hard palette", () => {
  const theme = readTheme("amp-gruvbox-dark-hard.json");

  assert.deepEqual(theme.vars, {
    "gruvbox-bg0-hard": "#1d2021",
    "gruvbox-bg0": "#282828",
    "gruvbox-bg0-soft": "#32302f",
    "gruvbox-bg1": "#3c3836",
    "gruvbox-bg2": "#504945",
    "gruvbox-bg3": "#665c54",
    "gruvbox-bg4": "#7c6f64",
    "gruvbox-gray": "#928374",
    "gruvbox-fg0-hard": "#f9f5d7",
    "gruvbox-fg0": "#fbf1c7",
    "gruvbox-fg0-soft": "#f2e5bc",
    "gruvbox-fg1": "#ebdbb2",
    "gruvbox-fg2": "#d5c4a1",
    "gruvbox-fg3": "#bdae93",
    "gruvbox-fg4": "#a89984",
    "gruvbox-red": "#fb4934",
    "gruvbox-green": "#b8bb26",
    "gruvbox-yellow": "#fabd2f",
    "gruvbox-blue": "#83a598",
    "gruvbox-purple": "#d3869b",
    "gruvbox-aqua": "#8ec07c",
    "gruvbox-orange": "#fe8019",
    "gruvbox-neutral-red": "#cc241d",
    "gruvbox-neutral-green": "#98971a",
    "gruvbox-neutral-yellow": "#d79921",
    "gruvbox-neutral-blue": "#458588",
    "gruvbox-neutral-purple": "#b16286",
    "gruvbox-neutral-aqua": "#689d6a",
    "gruvbox-neutral-orange": "#d65d0e",
  });
});

test("amp-gruvbox-dark-hard maps Pi tokens to Gruvbox roles", () => {
  const theme = readTheme("amp-gruvbox-dark-hard.json");

  assert.partialDeepStrictEqual(theme.colors, {
    accent: "gruvbox-green",
    border: "gruvbox-bg4",
    borderAccent: "gruvbox-green",
    borderMuted: "gruvbox-bg3",
    text: "gruvbox-fg1",
    thinkingText: "gruvbox-fg3",
    muted: "gruvbox-fg4",
    dim: "gruvbox-gray",
    selectedBg: "gruvbox-bg1",
    error: "gruvbox-red",
    warning: "gruvbox-orange",
    success: "gruvbox-green",
    syntaxComment: "gruvbox-gray",
    syntaxKeyword: "gruvbox-red",
    syntaxFunction: "gruvbox-green",
    syntaxVariable: "gruvbox-blue",
    syntaxString: "gruvbox-green",
    syntaxNumber: "gruvbox-purple",
    syntaxType: "gruvbox-yellow",
    syntaxOperator: "gruvbox-fg1",
    syntaxPunctuation: "gruvbox-fg4",
    thinkingOff: "gruvbox-bg3",
    thinkingMinimal: "gruvbox-fg4",
    thinkingLow: "gruvbox-green",
    thinkingMedium: "gruvbox-yellow",
    thinkingHigh: "gruvbox-orange",
    thinkingXhigh: "gruvbox-red",
    bashMode: "gruvbox-orange",
  });
});
