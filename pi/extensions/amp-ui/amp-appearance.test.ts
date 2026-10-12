import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { detectAppearance, type AppearanceProbes, appearanceFromOscReply, readOverride, syncTheme } from "./amp-appearance.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function probes(overrides: Partial<AppearanceProbes>): AppearanceProbes {
  return { override: null, mac: () => null, osc: () => null, ...overrides };
}

describe("detectAppearance", () => {
  test("explicit override wins over everything", () => {
    assert.equal(detectAppearance(probes({ override: "light", mac: () => "dark" })), "light");
  });

  test("falls back to macOS probe when no override", () => {
    assert.equal(detectAppearance(probes({ mac: () => "light" })), "light");
    assert.equal(detectAppearance(probes({ mac: () => "dark" })), "dark");
  });

  test("falls back to OSC probe when mac probe cannot answer", () => {
    assert.equal(detectAppearance(probes({ mac: () => null, osc: () => "light" })), "light");
  });

  test("defaults to dark when nothing can answer", () => {
    assert.equal(detectAppearance(probes({})), "dark");
  });
});

describe("appearanceFromOscReply", () => {
  test("parses a dark background reply", () => {
    // OSC 11 reply form: ESC ] 11 ; rgb:RRRR/GGGG/BBBB ESC \
    assert.equal(appearanceFromOscReply("\x1b]11;rgb:0000/0000/0000\x1b\\"), "dark");
  });
  test("parses a light background reply", () => {
    assert.equal(appearanceFromOscReply("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"), "light");
  });
  test("returns null on unparseable input", () => {
    assert.equal(appearanceFromOscReply("garbage"), null);
  });
});

describe("readOverride (AMP_APPEARANCE env var)", () => {
  const original = process.env.AMP_APPEARANCE;
  afterEach(() => {
    if (original === undefined) delete process.env.AMP_APPEARANCE;
    else process.env.AMP_APPEARANCE = original;
  });

  test("reads dark/light case-insensitively", () => {
    process.env.AMP_APPEARANCE = "LIGHT";
    assert.equal(readOverride(), "light");
    process.env.AMP_APPEARANCE = "dark";
    assert.equal(readOverride(), "dark");
  });

  test("returns null when unset or invalid", () => {
    delete process.env.AMP_APPEARANCE;
    assert.equal(readOverride(), null);
    process.env.AMP_APPEARANCE = "purple";
    assert.equal(readOverride(), null);
  });
});

function fakeCtx(opts: {
  hasUI?: boolean;
  themeName?: string;
  setThemeResult?: { success: boolean; error?: string };
}) {
  const calls = { setTheme: [] as string[], notify: [] as Array<[string, string | undefined]> };
  const ctx = {
    hasUI: opts.hasUI ?? true,
    ui: {
      theme: { name: opts.themeName },
      setTheme: (name: string) => { calls.setTheme.push(name); return opts.setThemeResult ?? { success: true }; },
      notify: (msg: string, type?: string) => { calls.notify.push([msg, type]); },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

describe("syncTheme", () => {
  const originalEnv = process.env.AMP_APPEARANCE;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AMP_APPEARANCE;
    else process.env.AMP_APPEARANCE = originalEnv;
  });

  test("skips entirely when !ctx.hasUI", () => {
    process.env.AMP_APPEARANCE = "dark";
    const { ctx, calls } = fakeCtx({ hasUI: false, themeName: "amp-dark" });
    syncTheme(ctx);
    assert.equal(calls.setTheme.length, 0);
    assert.equal(calls.notify.length, 0);
  });

  test("skips when a non-amp theme is active", () => {
    process.env.AMP_APPEARANCE = "dark";
    const { ctx, calls } = fakeCtx({ hasUI: true, themeName: "some-other-theme" });
    syncTheme(ctx);
    assert.equal(calls.setTheme.length, 0);
  });

  test("switches when target differs from active", () => {
    process.env.AMP_APPEARANCE = "light";
    const { ctx, calls } = fakeCtx({ hasUI: true, themeName: "amp-dark" });
    syncTheme(ctx);
    assert.equal(calls.setTheme.length, 1);
    assert.equal(calls.setTheme[0], "amp-light");
  });

  test("no-op when already on the correct theme", () => {
    process.env.AMP_APPEARANCE = "dark";
    const { ctx, calls } = fakeCtx({ hasUI: true, themeName: "amp-dark" });
    syncTheme(ctx);
    assert.equal(calls.setTheme.length, 0);
  });

  test("notifies with warning type when setTheme fails", () => {
    process.env.AMP_APPEARANCE = "light";
    const { ctx, calls } = fakeCtx({
      hasUI: true,
      themeName: "amp-dark",
      setThemeResult: { success: false, error: "nope" },
    });
    syncTheme(ctx);
    assert.equal(calls.setTheme.length, 1);
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.notify[0]![1], "warning");
    assert.ok(calls.notify[0]![0].includes("nope"));
  });
});
