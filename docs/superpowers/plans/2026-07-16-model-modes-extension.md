# Model Modes Pi Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi extension that selects a required user-defined provider/model/thinking-level mapping as one mode, with direct selection, ordered cycling, exact active-state detection, environment-selected configuration, fresh-session defaults, and diagnostics.

**Architecture:** Keep JSON loading and validation, pure mode-state logic, model application, diagnostics, and Pi wiring in separate modules under `pi/extensions/model-modes`. Pi's actual model and thinking level are authoritative; the extension never writes configuration or persists a separate active mode. Configuration is strict and reloadable, while shortcut changes take effect only after `/reload`.

**Tech Stack:** TypeScript, Node.js 26 built-in test runner and type stripping, `@earendil-works/pi-ai` 0.80.7+, `@earendil-works/pi-coding-agent` 0.80.7+, `@earendil-works/pi-tui` 0.80.7+.

## Global Constraints

- Version 1 changes only provider/model and Pi thinking level; it does not modify tools or system prompts.
- Every mode comes from user-authored JSON; do not ship implicit Low/Medium/High/Ultra mappings.
- Resolve `PI_MODEL_MODES_CONFIG` first; otherwise use `~/.pi/agent/model-modes.json`; never merge files.
- Treat `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` as the complete thinking-level set.
- Keep `/mode` as the only command namespace.
- Apply `defaultMode` only to genuinely fresh startup or `/new` sessions.
- Infer a named mode only from an exact provider/model/effective-thinking-level match; otherwise show `custom`.
- Never write the selected mapping file or persist a separate active mode.
- An invalid changed file disables mode operations instead of retaining stale mappings.
- Use TDD for every behavior and commit after each independently testable task.
- Do not repair unrelated legacy `@mariozechner/*` imports; the feature-specific TypeScript project intentionally includes only `pi/extensions/model-modes`.

---

## File Map

### Create

- `pi/extensions/model-modes/types.ts` — configuration, load-result, state, application, and diagnostic contracts.
- `pi/extensions/model-modes/config.ts` — source-path resolution, strict JSON validation, file fingerprinting, and reload cache.
- `pi/extensions/model-modes/config.test.ts` — configuration and reload tests.
- `pi/extensions/model-modes/mode-state.ts` — exact matching, cycle order, and fresh-session classification.
- `pi/extensions/model-modes/mode-state.test.ts` — pure state tests.
- `pi/extensions/model-modes/apply-mode.ts` — preflight, activation, read-back, and rollback.
- `pi/extensions/model-modes/apply-mode.test.ts` — fake-runtime application tests.
- `pi/extensions/model-modes/doctor.ts` — compatibility checks and deterministic report formatting.
- `pi/extensions/model-modes/doctor.test.ts` — report tests.
- `pi/extensions/model-modes/index.ts` — extension factory, command/shortcut/event registration, picker, status, and startup flow.
- `pi/extensions/model-modes/index.test.ts` — extension wiring tests using a fake `ExtensionAPI`.
- `pi/extensions/model-modes/README.md` — configuration and command documentation.
- `pi/extensions/model-modes/example.json` — non-loaded example mapping.
- `pi/extensions/model-modes/tsconfig.json` — focused strict type-check project.

### Modify

- `package.json` — upgrade Pi development packages to `^0.80.7` and add focused test/typecheck scripts.
- `package-lock.json` — lock the updated development packages.

---

### Task 1: Configuration Contract and Strict Loader

**Files:**
- Create: `pi/extensions/model-modes/types.ts`
- Create: `pi/extensions/model-modes/config.ts`
- Create: `pi/extensions/model-modes/config.test.ts`
- Create: `pi/extensions/model-modes/tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `ThinkingLevel`, `ModeDefinition`, `ModeConfig`, `ConfigError`, `ConfigSnapshot`.
- Produces: `resolveConfigPath(options): string`.
- Produces: `parseModeConfig(value): ModeConfig`.
- Produces: `ModeConfigLoader.refresh(force?): Promise<ConfigSnapshot>` and `ModeConfigLoader.current`.
- Consumers in later tasks must not read JSON or inspect file timestamps directly.

- [ ] **Step 1: Update development dependencies and add focused scripts**

Change the relevant `package.json` fields to:

```json
{
  "scripts": {
    "test": "node --test pi/extensions/model-modes/*.test.ts",
    "typecheck": "tsc -p pi/extensions/model-modes/tsconfig.json"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "^0.80.7",
    "@earendil-works/pi-coding-agent": "^0.80.7",
    "@earendil-works/pi-tui": "^0.80.7",
    "@types/node": "^24.12.0",
    "typescript": "^6.0.3"
  }
}
```

Preserve all unrelated package metadata and dependencies. Then run:

```bash
npm install
```

Expected: `package-lock.json` resolves the three Pi packages at `0.80.7` or a newer compatible `0.80.x` release, and exits 0.

Create `pi/extensions/model-modes/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["./**/*.ts"]
}
```

- [ ] **Step 2: Define the shared types**

Create `pi/extensions/model-modes/types.ts`:

```ts
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModeDefinition {
  id: string;
  label: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  description?: string;
}

export interface ModeConfig {
  version: 1;
  defaultMode: string;
  cycleShortcut?: string;
  modes: ModeDefinition[];
}

export interface ConfigError {
  path: string;
  message: string;
}

export type ConfigSnapshot =
  | {
      ok: true;
      path: string;
      fromEnvironment: boolean;
      fingerprint: string;
      config: ModeConfig;
    }
  | {
      ok: false;
      path: string;
      fromEnvironment: boolean;
      fingerprint: string;
      errors: ConfigError[];
    };

export type ActiveMode = { kind: "named"; mode: ModeDefinition }
  | { kind: "custom" }
  | { kind: "error" };

export interface ModeModel {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export type ApplyFailureStage = "preflight" | "model" | "thinking" | "rollback";

export type ApplyResult =
  | { ok: true; mode: ModeDefinition }
  | {
      ok: false;
      mode: ModeDefinition;
      stage: ApplyFailureStage;
      message: string;
      stateChanged: boolean;
      rollbackSucceeded: boolean;
    };
```

- [ ] **Step 3: Write failing configuration tests**

Create `pi/extensions/model-modes/config.test.ts` with Node's built-in test APIs. Include these concrete cases:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModeConfigLoader,
  parseModeConfig,
  resolveConfigPath,
} from "./config.ts";

const valid = {
  version: 1,
  defaultMode: "medium",
  cycleShortcut: "f8",
  modes: [
    {
      id: "medium",
      label: "Medium",
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "medium",
      description: "Balanced",
    },
  ],
};

test("environment config path overrides the global path", () => {
  assert.equal(
    resolveConfigPath({ envPath: "/tmp/team.json", startupCwd: "/repo", agentDir: "/agent" }),
    "/tmp/team.json",
  );
  assert.equal(
    resolveConfigPath({ envPath: "profiles/team.json", startupCwd: "/repo", agentDir: "/agent" }),
    "/repo/profiles/team.json",
  );
  assert.equal(
    resolveConfigPath({ envPath: "  ", startupCwd: "/repo", agentDir: "/agent" }),
    "/agent/model-modes.json",
  );
});

test("parser normalizes optional presentation fields", () => {
  const parsed = parseModeConfig({
    ...valid,
    modes: [{ id: "medium", provider: "openai", model: "gpt", thinkingLevel: "max" }],
  });
  assert.equal(parsed.modes[0]?.label, "medium");
  assert.equal(parsed.modes[0]?.thinkingLevel, "max");
});

test("parser rejects all invalid input instead of loading a subset", () => {
  assert.throws(() => parseModeConfig({ ...valid, extra: true }), /root\.extra: unknown property/);
  assert.throws(() => parseModeConfig({ ...valid, defaultMode: "missing" }), /root\.defaultMode/);
  assert.throws(() => parseModeConfig({ ...valid, modes: [] }), /root\.modes/);
  assert.throws(
    () => parseModeConfig({ ...valid, modes: [valid.modes[0], valid.modes[0]] }),
    /duplicate mode id "medium"/,
  );
  for (const id of ["next", "previous", "doctor", "help", "two words"]) {
    assert.throws(
      () => parseModeConfig({ ...valid, defaultMode: id, modes: [{ ...valid.modes[0], id }] }),
      /reserved|whitespace/,
    );
  }
});

test("loader disables stale config and recovers after the file is fixed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-modes-"));
  const path = join(dir, "modes.json");
  try {
    await writeFile(path, JSON.stringify(valid));
    const loader = new ModeConfigLoader(path, false);
    const initial = await loader.refresh(true);
    assert.equal(initial.ok, true);
    if (initial.ok) assert.equal(initial.config.cycleShortcut, "f8");

    await writeFile(path, "{");
    const broken = await loader.refresh(true);
    assert.equal(broken.ok, false);

    await writeFile(path, JSON.stringify({ ...valid, cycleShortcut: "f9" }));
    const fixed = await loader.refresh(true);
    assert.equal(fixed.ok, true);
    if (fixed.ok) assert.equal(fixed.config.cycleShortcut, "f9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Add separate assertions for wrong version, unknown mode property, empty required strings, unsupported thinking level, malformed shortcut, missing file, and invalid JSON. For each rejected document, assert that the thrown message contains the exact JSON path.

- [ ] **Step 4: Run the configuration tests and verify RED**

Run:

```bash
node --test pi/extensions/model-modes/config.test.ts
```

Expected: FAIL because `./config.ts` does not exist.

- [ ] **Step 5: Implement strict parsing and reload caching**

Create `pi/extensions/model-modes/config.ts` with these exported signatures:

```ts
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  THINKING_LEVELS,
  type ConfigError,
  type ConfigSnapshot,
  type ModeConfig,
  type ModeDefinition,
  type ThinkingLevel,
} from "./types.ts";

const RESERVED_IDS = new Set(["next", "previous", "doctor", "help"]);
const SHORTCUT = /^(?:(?:ctrl|shift|alt)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2])|escape|enter|tab|space|backspace|delete|home|end|pageUp|pageDown|up|down|left|right)$/i;
const ROOT_KEYS = new Set(["version", "defaultMode", "cycleShortcut", "modes"]);
const MODE_KEYS = new Set(["id", "label", "provider", "model", "thinkingLevel", "description"]);

export interface ConfigPathOptions {
  envPath: string | undefined;
  startupCwd: string;
  agentDir: string;
}

export function resolveConfigPath(options: ConfigPathOptions): string {
  const selected = options.envPath?.trim();
  if (!selected) return join(options.agentDir, "model-modes.json");
  return isAbsolute(selected) ? selected : resolve(options.startupCwd, selected);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}: expected non-empty string`);
  }
  return value.trim();
}

function rejectUnknown(input: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key}: unknown property`);
  }
}

function parseMode(value: unknown, index: number): ModeDefinition {
  const path = `root.modes[${index}]`;
  const input = record(value, path);
  rejectUnknown(input, MODE_KEYS, path);
  const id = requiredString(input.id, `${path}.id`);
  if (/\s/.test(id)) throw new Error(`${path}.id: whitespace is not allowed`);
  if (RESERVED_IDS.has(id)) throw new Error(`${path}.id: reserved mode id "${id}"`);
  const thinking = requiredString(input.thinkingLevel, `${path}.thinkingLevel`);
  if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`${path}.thinkingLevel: unsupported value "${thinking}"`);
  }
  const mode: ModeDefinition = {
    id,
    label: input.label === undefined ? id : requiredString(input.label, `${path}.label`),
    provider: requiredString(input.provider, `${path}.provider`),
    model: requiredString(input.model, `${path}.model`),
    thinkingLevel: thinking as ThinkingLevel,
  };
  if (input.description !== undefined) {
    mode.description = requiredString(input.description, `${path}.description`);
  }
  return mode;
}

export function parseModeConfig(value: unknown): ModeConfig {
  const input = record(value, "root");
  rejectUnknown(input, ROOT_KEYS, "root");
  if (input.version !== 1) throw new Error("root.version: expected 1");
  const defaultMode = requiredString(input.defaultMode, "root.defaultMode");
  if (!Array.isArray(input.modes) || input.modes.length === 0) {
    throw new Error("root.modes: expected non-empty array");
  }
  const modes = input.modes.map(parseMode);
  const ids = new Set<string>();
  for (const mode of modes) {
    if (ids.has(mode.id)) throw new Error(`root.modes: duplicate mode id "${mode.id}"`);
    ids.add(mode.id);
  }
  if (!ids.has(defaultMode)) throw new Error("root.defaultMode: must reference a configured mode");
  const cycleShortcut = input.cycleShortcut === undefined
    ? undefined
    : requiredString(input.cycleShortcut, "root.cycleShortcut");
  if (cycleShortcut !== undefined && !SHORTCUT.test(cycleShortcut)) {
    throw new Error("root.cycleShortcut: invalid Pi shortcut");
  }
  return { version: 1, defaultMode, ...(cycleShortcut ? { cycleShortcut } : {}), modes };
}

function error(_filePath: string, cause: unknown): ConfigError {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const parsed = /^(root(?:\.[^:]+)?):\s*(.*)$/.exec(raw);
  return parsed
    ? { path: parsed[1]!, message: parsed[2]! }
    : { path: "root", message: raw };
}

export class ModeConfigLoader {
  public readonly path: string;
  public readonly fromEnvironment: boolean;
  public current: ConfigSnapshot;

  public constructor(path: string, fromEnvironment: boolean) {
    this.path = path;
    this.fromEnvironment = fromEnvironment;
    this.current = {
      ok: false,
      path,
      fromEnvironment,
      fingerprint: "unread",
      errors: [{ path: "root", message: "configuration has not been loaded" }],
    };
  }

  public async refresh(force = false): Promise<ConfigSnapshot> {
    let fingerprint = "missing";
    try {
      const info = await stat(this.path);
      fingerprint = `${info.mtimeMs}:${info.size}`;
      if (!force && fingerprint === this.current.fingerprint) return this.current;
      const parsed = parseModeConfig(JSON.parse(await readFile(this.path, "utf8")));
      this.current = {
        ok: true,
        path: this.path,
        fromEnvironment: this.fromEnvironment,
        fingerprint,
        config: parsed,
      };
    } catch (cause) {
      this.current = {
        ok: false,
        path: this.path,
        fromEnvironment: this.fromEnvironment,
        fingerprint,
        errors: [error(this.path, cause)],
      };
    }
    return this.current;
  }
}
```

If tests expose ambiguous parser messages, change only the messages needed to make each property path deterministic; do not introduce permissive fallback behavior.

- [ ] **Step 6: Run tests and typecheck to verify GREEN**

Run:

```bash
node --test pi/extensions/model-modes/config.test.ts
npm run typecheck
```

Expected: configuration tests PASS; focused TypeScript check exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json pi/extensions/model-modes/types.ts pi/extensions/model-modes/config.ts pi/extensions/model-modes/config.test.ts pi/extensions/model-modes/tsconfig.json
git commit -m "feat(model-modes): add strict config loader"
```

---

### Task 2: Pure Active-State, Cycling, and Fresh-Session Logic

**Files:**
- Create: `pi/extensions/model-modes/mode-state.ts`
- Create: `pi/extensions/model-modes/mode-state.test.ts`

**Interfaces:**
- Consumes: `ModeConfig`, `ModeDefinition`, `ThinkingLevel`, and `ActiveMode` from `types.ts`.
- Produces: `inferActiveMode(config, selection): ActiveMode`.
- Produces: `cycleOrder(config, active, direction): ModeDefinition[]`.
- Produces: `isFreshSession(event, entries): boolean`.

- [ ] **Step 1: Write failing pure-state tests**

Create `pi/extensions/model-modes/mode-state.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { cycleOrder, inferActiveMode, isFreshSession } from "./mode-state.ts";
import type { ModeConfig } from "./types.ts";

const config: ModeConfig = {
  version: 1,
  defaultMode: "medium",
  modes: [
    { id: "low", label: "Low", provider: "zai", model: "glm", thinkingLevel: "low" },
    { id: "medium", label: "Medium", provider: "openai", model: "sol", thinkingLevel: "medium" },
    { id: "high", label: "High", provider: "openai", model: "sol", thinkingLevel: "high" },
  ],
};

test("active mode requires an exact model and effort triple", () => {
  assert.equal(
    inferActiveMode(config, { provider: "openai", model: "sol", thinkingLevel: "high" }).kind,
    "named",
  );
  assert.deepEqual(
    inferActiveMode(config, { provider: "openai", model: "sol", thinkingLevel: "low" }),
    { kind: "custom" },
  );
});

test("first duplicate triple wins", () => {
  const duplicate: ModeConfig = { ...config, modes: [...config.modes, { ...config.modes[2]!, id: "ultra" }] };
  const active = inferActiveMode(duplicate, { provider: "openai", model: "sol", thinkingLevel: "high" });
  assert.equal(active.kind === "named" ? active.mode.id : "", "high");
});

test("cycle order wraps and custom starts at the nearest edge", () => {
  const medium = { kind: "named" as const, mode: config.modes[1]! };
  assert.deepEqual(cycleOrder(config, medium, 1).map((m) => m.id), ["high", "low", "medium"]);
  assert.deepEqual(cycleOrder(config, medium, -1).map((m) => m.id), ["low", "high", "medium"]);
  assert.deepEqual(cycleOrder(config, { kind: "custom" }, 1).map((m) => m.id), ["low", "medium", "high"]);
  assert.deepEqual(cycleOrder(config, { kind: "custom" }, -1).map((m) => m.id), ["high", "medium", "low"]);
});

test("only startup without conversation and new sessions are fresh", () => {
  assert.equal(isFreshSession({ reason: "new" }, []), true);
  assert.equal(isFreshSession({ reason: "startup" }, [{ type: "model_change" }, { type: "thinking_level_change" }]), true);
  assert.equal(isFreshSession({ reason: "startup" }, [{ type: "message" }]), false);
  for (const reason of ["reload", "resume", "fork"] as const) {
    assert.equal(isFreshSession({ reason }, []), false);
  }
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --test pi/extensions/model-modes/mode-state.test.ts
```

Expected: FAIL because `mode-state.ts` does not exist.

- [ ] **Step 3: Implement the pure state functions**

Create `pi/extensions/model-modes/mode-state.ts`:

```ts
import type { ActiveMode, ModeConfig, ModeDefinition, ThinkingLevel } from "./types.ts";

export interface ActualSelection {
  provider?: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
}

export function inferActiveMode(config: ModeConfig, selection: ActualSelection): ActiveMode {
  const mode = config.modes.find(
    (candidate) =>
      candidate.provider === selection.provider &&
      candidate.model === selection.model &&
      candidate.thinkingLevel === selection.thinkingLevel,
  );
  return mode ? { kind: "named", mode } : { kind: "custom" };
}

export function cycleOrder(
  config: ModeConfig,
  active: ActiveMode,
  direction: 1 | -1,
): ModeDefinition[] {
  if (active.kind !== "named") {
    return direction === 1 ? [...config.modes] : [...config.modes].reverse();
  }
  const index = config.modes.findIndex((mode) => mode.id === active.mode.id);
  const ordered: ModeDefinition[] = [];
  for (let offset = 1; offset <= config.modes.length; offset += 1) {
    const position = (index + direction * offset + config.modes.length) % config.modes.length;
    ordered.push(config.modes[position]!);
  }
  return ordered;
}

export interface SessionStartLike {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SessionEntryLike {
  type: string;
}

export function isFreshSession(event: SessionStartLike, entries: readonly SessionEntryLike[]): boolean {
  if (event.reason === "new") return true;
  if (event.reason !== "startup") return false;
  let modelChanges = 0;
  let thinkingChanges = 0;
  for (const entry of entries) {
    if (entry.type === "model_change") modelChanges += 1;
    else if (entry.type === "thinking_level_change") thinkingChanges += 1;
    else return false;
  }
  return modelChanges <= 1 && thinkingChanges <= 1;
}
```

- [ ] **Step 4: Run tests and typecheck to verify GREEN**

Run:

```bash
node --test pi/extensions/model-modes/mode-state.test.ts
npm run typecheck
```

Expected: state tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/model-modes/mode-state.ts pi/extensions/model-modes/mode-state.test.ts
git commit -m "feat(model-modes): add mode state logic"
```

---

### Task 3: Guarded Mode Application and Rollback

**Files:**
- Create: `pi/extensions/model-modes/apply-mode.ts`
- Create: `pi/extensions/model-modes/apply-mode.test.ts`

**Interfaces:**
- Consumes: `ModeDefinition`, `ModeModel`, `ThinkingLevel`, and `ApplyResult` from `types.ts`.
- Produces: `preflightMode(runtime, mode): string | undefined`.
- Produces: `applyMode(runtime, mode): Promise<ApplyResult>`.
- The runtime adapter in `index.ts` will bind these calls to `ctx.modelRegistry`, `ctx.model`, `pi.setModel`, `pi.setThinkingLevel`, and `pi.getThinkingLevel`.

- [ ] **Step 1: Write failing application tests with a fake runtime**

Create `pi/extensions/model-modes/apply-mode.test.ts`. Use a reusable fake:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyMode, type ApplyRuntime } from "./apply-mode.ts";
import type { ModeDefinition, ModeModel, ThinkingLevel } from "./types.ts";

const oldModel: ModeModel = { provider: "openai", id: "old", reasoning: true };
const targetModel: ModeModel = { provider: "openai", id: "sol", reasoning: true };
const mode: ModeDefinition = {
  id: "high",
  label: "High",
  provider: "openai",
  model: "sol",
  thinkingLevel: "high",
};

function fake(overrides: Partial<ApplyRuntime> = {}): ApplyRuntime {
  let currentModel = oldModel;
  let thinking: ThinkingLevel = "medium";
  return {
    findModel: (provider, id) => provider === "openai" && id === "sol" ? targetModel : undefined,
    getCurrentModel: () => currentModel,
    getThinkingLevel: () => thinking,
    setModel: async (model) => { currentModel = model; return true; },
    setThinkingLevel: (level) => { thinking = level; },
    ...overrides,
  };
}

test("applies model before thinking and verifies the effective level", async () => {
  const calls: string[] = [];
  let thinking: ThinkingLevel = "medium";
  const result = await applyMode(fake({
    setModel: async () => { calls.push("model"); return true; },
    setThinkingLevel: (level) => { calls.push(`thinking:${level}`); thinking = level; },
    getThinkingLevel: () => thinking,
  }), mode);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["model", "thinking:high"]);
});

test("model auth failure never changes thinking", async () => {
  let thinkingSet = false;
  const result = await applyMode(fake({
    setModel: async () => false,
    setThinkingLevel: () => { thinkingSet = true; },
  }), mode);
  assert.equal(result.ok, false);
  assert.equal(thinkingSet, false);
});

test("rejects missing, non-reasoning, and explicitly unsupported models", async () => {
  assert.match((await applyMode(fake({ findModel: () => undefined }), mode)).message, /not found/);
  assert.match((await applyMode(fake({ findModel: () => ({ ...targetModel, reasoning: false }) }), mode)).message, /does not support reasoning/);
  assert.match((await applyMode(fake({ findModel: () => ({ ...targetModel, thinkingLevelMap: { high: null } }) }), mode)).message, /does not support thinking level high/);
});
```

Add tests for:

- `setModel` throwing.
- Effective thinking clamped to another value.
- Successful rollback restores model and effort.
- Failed rollback returns `stage: "rollback"`, `stateChanged: true`, and `rollbackSucceeded: false`.
- `off` is accepted for a non-reasoning model.

- [ ] **Step 2: Run application tests to verify RED**

Run:

```bash
node --test pi/extensions/model-modes/apply-mode.test.ts
```

Expected: FAIL because `apply-mode.ts` does not exist.

- [ ] **Step 3: Implement preflight, activation, and rollback**

Create `pi/extensions/model-modes/apply-mode.ts`:

```ts
import type {
  ApplyResult,
  ModeDefinition,
  ModeModel,
  ThinkingLevel,
} from "./types.ts";

export interface ApplyRuntime {
  findModel(provider: string, id: string): ModeModel | undefined;
  getCurrentModel(): ModeModel | undefined;
  getThinkingLevel(): ThinkingLevel;
  setModel(model: ModeModel): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
}

export function preflightMode(runtime: ApplyRuntime, mode: ModeDefinition): string | undefined {
  const model = runtime.findModel(mode.provider, mode.model);
  if (!model) return `model not found: ${mode.provider}/${mode.model}`;
  if (!model.reasoning && mode.thinkingLevel !== "off") {
    return `${mode.provider}/${mode.model} does not support reasoning`;
  }
  if (model.thinkingLevelMap?.[mode.thinkingLevel] === null) {
    return `${mode.provider}/${mode.model} does not support thinking level ${mode.thinkingLevel}`;
  }
  return undefined;
}

export async function applyMode(runtime: ApplyRuntime, mode: ModeDefinition): Promise<ApplyResult> {
  const preflight = preflightMode(runtime, mode);
  if (preflight) {
    return { ok: false, mode, stage: "preflight", message: preflight, stateChanged: false, rollbackSucceeded: true };
  }

  const target = runtime.findModel(mode.provider, mode.model)!;
  const previousModel = runtime.getCurrentModel();
  const previousThinking = runtime.getThinkingLevel();

  try {
    if (!(await runtime.setModel(target))) {
      return {
        ok: false,
        mode,
        stage: "model",
        message: `model unavailable or authentication failed: ${mode.provider}/${mode.model}`,
        stateChanged: false,
        rollbackSucceeded: true,
      };
    }
  } catch (cause) {
    return {
      ok: false,
      mode,
      stage: "model",
      message: cause instanceof Error ? cause.message : String(cause),
      stateChanged: false,
      rollbackSucceeded: true,
    };
  }

  runtime.setThinkingLevel(mode.thinkingLevel);
  const effectiveThinking = runtime.getThinkingLevel();
  if (effectiveThinking === mode.thinkingLevel) return { ok: true, mode };

  let rollbackSucceeded = previousModel !== undefined;
  if (previousModel !== undefined) {
    try {
      rollbackSucceeded = await runtime.setModel(previousModel);
      if (rollbackSucceeded) {
        runtime.setThinkingLevel(previousThinking);
        rollbackSucceeded = runtime.getThinkingLevel() === previousThinking;
      }
    } catch {
      rollbackSucceeded = false;
    }
  }

  return {
    ok: false,
    mode,
    stage: rollbackSucceeded ? "thinking" : "rollback",
    message: `thinking level ${mode.thinkingLevel} was clamped to ${effectiveThinking}`,
    stateChanged: !rollbackSucceeded,
    rollbackSucceeded,
  };
}
```

- [ ] **Step 4: Run tests and typecheck to verify GREEN**

Run:

```bash
node --test pi/extensions/model-modes/apply-mode.test.ts
npm run typecheck
```

Expected: application tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/model-modes/apply-mode.ts pi/extensions/model-modes/apply-mode.test.ts
git commit -m "feat(model-modes): apply modes with rollback"
```

---

### Task 4: Diagnostics and Compatibility Report

**Files:**
- Create: `pi/extensions/model-modes/doctor.ts`
- Create: `pi/extensions/model-modes/doctor.test.ts`

**Interfaces:**
- Consumes: `ConfigSnapshot`, `ModeConfig`, and `ModeModel`.
- Produces: `inspectConfig(snapshot, registry, registeredShortcut): DoctorReport`.
- Produces: `formatDoctorReport(report): string`.
- Produces: `formatModeList(config): string` for non-interactive `/mode`.

- [ ] **Step 1: Write failing diagnostic tests**

Create `pi/extensions/model-modes/doctor.test.ts` with tests that assert exact report sections:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorReport, inspectConfig } from "./doctor.ts";
import type { ConfigSnapshot, ModeModel } from "./types.ts";

const snapshot: ConfigSnapshot = {
  ok: true,
  path: "/tmp/modes.json",
  fromEnvironment: true,
  fingerprint: "1:1",
  config: {
    version: 1,
    defaultMode: "high",
    cycleShortcut: "f9",
    modes: [
      { id: "high", label: "High", provider: "openai", model: "sol", thinkingLevel: "high" },
      { id: "bad", label: "Bad", provider: "zai", model: "missing", thinkingLevel: "low" },
    ],
  },
};

test("doctor reports source, order, shortcut reload, and missing models", () => {
  const model: ModeModel = { provider: "openai", id: "sol", reasoning: true };
  const report = formatDoctorReport(inspectConfig(snapshot, {
    find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
    available: () => [model],
  }, "f8"));
  assert.match(report, /Source: \/tmp\/modes\.json \(PI_MODEL_MODES_CONFIG\)/);
  assert.match(report, /Default: high/);
  assert.match(report, /Cycle: high -> bad/);
  assert.match(report, /Shortcut: f9 \(reload required; registered: f8\)/);
  assert.match(report, /missing model zai\/missing/);
});

test("doctor prints load errors without pretending config is usable", () => {
  const report = formatDoctorReport(inspectConfig({
    ok: false,
    path: "/tmp/modes.json",
    fromEnvironment: false,
    fingerprint: "missing",
    errors: [{ path: "root", message: "invalid JSON" }],
  }, { find: () => undefined, available: () => [] }, undefined));
  assert.match(report, /Status: ERROR/);
  assert.match(report, /invalid JSON/);
  assert.doesNotMatch(report, /Default:/);
});
```

Add cases for non-reasoning incompatibility, `thinkingLevelMap[level] === null`, and a model that exists but is absent from `available()`.

- [ ] **Step 2: Run diagnostic tests to verify RED**

Run:

```bash
node --test pi/extensions/model-modes/doctor.test.ts
```

Expected: FAIL because `doctor.ts` does not exist.

- [ ] **Step 3: Implement deterministic inspection and formatting**

Create `pi/extensions/model-modes/doctor.ts` with these contracts:

```ts
import { preflightMode } from "./apply-mode.ts";
import type { ConfigSnapshot, ModeConfig, ModeModel } from "./types.ts";

export interface DoctorRegistry {
  find(provider: string, id: string): ModeModel | undefined;
  available(): ModeModel[];
}

export interface DoctorReport {
  status: "OK" | "ERROR";
  source: string;
  fromEnvironment: boolean;
  defaultMode?: string;
  cycle?: string[];
  configuredShortcut?: string;
  registeredShortcut?: string;
  shortcutNeedsReload: boolean;
  issues: string[];
}

export function inspectConfig(
  snapshot: ConfigSnapshot,
  registry: DoctorRegistry,
  registeredShortcut: string | undefined,
): DoctorReport {
  if (!snapshot.ok) {
    return {
      status: "ERROR",
      source: snapshot.path,
      fromEnvironment: snapshot.fromEnvironment,
      registeredShortcut,
      shortcutNeedsReload: false,
      issues: snapshot.errors.map((item) => `${item.path}: ${item.message}`),
    };
  }
  const available = new Set(registry.available().map((model) => `${model.provider}/${model.id}`));
  const issues: string[] = [];
  for (const mode of snapshot.config.modes) {
    const model = registry.find(mode.provider, mode.model);
    if (!model) {
      issues.push(`${mode.id}: missing model ${mode.provider}/${mode.model}`);
      continue;
    }
    if (!available.has(`${model.provider}/${model.id}`)) {
      issues.push(`${mode.id}: model is registered but currently unavailable ${model.provider}/${model.id}`);
    }
    const compatibility = preflightMode({
      findModel: () => model,
      getCurrentModel: () => undefined,
      getThinkingLevel: () => "off",
      setModel: async () => false,
      setThinkingLevel: () => undefined,
    }, mode);
    if (compatibility) issues.push(`${mode.id}: ${compatibility}`);
  }
  return {
    status: issues.length === 0 ? "OK" : "ERROR",
    source: snapshot.path,
    fromEnvironment: snapshot.fromEnvironment,
    defaultMode: snapshot.config.defaultMode,
    cycle: snapshot.config.modes.map((mode) => mode.id),
    configuredShortcut: snapshot.config.cycleShortcut,
    registeredShortcut,
    shortcutNeedsReload: registeredShortcut !== snapshot.config.cycleShortcut,
    issues,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "model-modes doctor",
    `Status: ${report.status}`,
    `Source: ${report.source}${report.fromEnvironment ? " (PI_MODEL_MODES_CONFIG)" : ""}`,
  ];
  if (report.defaultMode) lines.push(`Default: ${report.defaultMode}`);
  if (report.cycle) lines.push(`Cycle: ${report.cycle.join(" -> ")}`);
  if (report.configuredShortcut) {
    const suffix = report.shortcutNeedsReload
      ? ` (reload required; registered: ${report.registeredShortcut ?? "none"})`
      : "";
    lines.push(`Shortcut: ${report.configuredShortcut}${suffix}`);
  } else {
    lines.push("Shortcut: disabled");
  }
  lines.push("", report.issues.length === 0 ? "Issues: none" : `Issues:\n- ${report.issues.join("\n- ")}`);
  return `${lines.join("\n")}\n`;
}

export function formatModeList(config: ModeConfig): string {
  return config.modes
    .map((mode) => `${mode.id}: ${mode.provider}/${mode.model} · thinking:${mode.thinkingLevel}`)
    .join("\n");
}
```

- [ ] **Step 4: Run tests and typecheck to verify GREEN**

Run:

```bash
node --test pi/extensions/model-modes/doctor.test.ts
npm run typecheck
```

Expected: doctor tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/model-modes/doctor.ts pi/extensions/model-modes/doctor.test.ts
git commit -m "feat(model-modes): add configuration doctor"
```

---

### Task 5: Pi Extension Wiring, Picker, Status, Startup, and Cycling

**Files:**
- Create: `pi/extensions/model-modes/index.ts`
- Create: `pi/extensions/model-modes/index.test.ts`

**Interfaces:**
- Consumes all earlier modules.
- Exports the default async Pi extension factory.
- Registers only `/mode` plus the optional configured cycle shortcut.
- Uses `ctx.ui.setStatus("model-modes", ...)` and clears/replaces only that status key.

- [ ] **Step 1: Write a fake ExtensionAPI harness and failing wiring tests**

Create `pi/extensions/model-modes/index.test.ts`. The harness records commands, shortcuts, and event handlers, then invokes the default factory against a temporary valid config selected through `PI_MODEL_MODES_CONFIG`.

The tests must cover these observable contracts:

```ts
assert.deepEqual([...registeredCommands.keys()], ["mode"]);
assert.equal(registeredShortcuts.has("f8"), true);
assert.equal(events.has("session_start"), true);
assert.equal(events.has("model_select"), true);
assert.equal(events.has("thinking_level_select"), true);
```

Add tests that invoke recorded handlers and assert:

- `/mode high` applies exactly that mode.
- `/mode next` skips a missing model and reaches the next usable mode.
- `/mode previous` uses reverse order.
- Cycling stops after a failed rollback instead of attempting another model.
- `/mode doctor` opens `ctx.ui.editor()` in TUI mode and logs the report in print mode.
- `/mode help` includes the resolved source path and every subcommand.
- `/mode` opens a `SelectList` picker in TUI mode.
- `/mode` lists modes without opening custom UI in print mode.
- Manual `model_select` followed by `thinking_level_select` results in `mode:custom` unless the exact triple matches.
- Intermediate events while `applying` do not publish transient status.
- Fresh startup and `/new` apply `defaultMode`.
- `resume`, `fork`, and `reload` only infer state.
- Invalid config sets `mode:error` and blocks switching.

Use structural fakes and cast only the final harness object to `ExtensionAPI`; do not use live Pi or provider credentials.

- [ ] **Step 2: Run wiring tests to verify RED**

Run:

```bash
node --test pi/extensions/model-modes/index.test.ts
```

Expected: FAIL because `index.ts` does not exist.

- [ ] **Step 3: Implement the extension factory and runtime adapter**

Create `pi/extensions/model-modes/index.ts` with this structure:

```ts
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { applyMode, type ApplyRuntime } from "./apply-mode.ts";
import { ModeConfigLoader, resolveConfigPath } from "./config.ts";
import { formatDoctorReport, formatModeList, inspectConfig } from "./doctor.ts";
import { cycleOrder, inferActiveMode, isFreshSession } from "./mode-state.ts";
import type { ActiveMode, ConfigSnapshot, ModeConfig, ModeDefinition, ModeModel, ThinkingLevel } from "./types.ts";

export default async function modelModesExtension(pi: ExtensionAPI): Promise<void> {
  const startupCwd = process.cwd();
  const envPath = process.env.PI_MODEL_MODES_CONFIG;
  const path = resolveConfigPath({ envPath, startupCwd, agentDir: getAgentDir() });
  const loader = new ModeConfigLoader(path, Boolean(envPath?.trim()));
  const initial = await loader.refresh(true);
  const registeredShortcut = initial.ok ? initial.config.cycleShortcut : undefined;
  let active: ActiveMode = { kind: "error" };
  let applying = false;

  const asModeModel = (model: Model<Api>): ModeModel => ({
    provider: model.provider,
    id: model.id,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  });

  const runtime = (ctx: ExtensionContext): ApplyRuntime => ({
    findModel: (provider, id) => {
      const model = ctx.modelRegistry.find(provider, id);
      return model ? asModeModel(model) : undefined;
    },
    getCurrentModel: () => ctx.model ? asModeModel(ctx.model) : undefined,
    getThinkingLevel: () => pi.getThinkingLevel() as ThinkingLevel,
    setModel: async (model) => {
      const target = ctx.modelRegistry.find(model.provider, model.id);
      return target ? pi.setModel(target) : false;
    },
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
  });

  const updateStatus = (ctx: ExtensionContext, snapshot: ConfigSnapshot = loader.current): void => {
    if (!snapshot.ok) active = { kind: "error" };
    else active = inferActiveMode(snapshot.config, {
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
    });
    const label = active.kind === "named" ? active.mode.id : active.kind;
    ctx.ui.setStatus("model-modes", ctx.ui.theme.fg(active.kind === "error" ? "error" : "accent", `mode:${label}`));
  };

  const activate = async (ctx: ExtensionContext, mode: ModeDefinition, quiet = false) => {
    applying = true;
    const result = await applyMode(runtime(ctx), mode);
    applying = false;
    updateStatus(ctx);
    if (!quiet) {
      if (result.ok) ctx.ui.notify(`Mode: ${mode.label}${mode.description ? ` — ${mode.description}` : ""}`, "info");
      else ctx.ui.notify(`Mode ${mode.id} failed: ${result.message}`, "warning");
    }
    return result;
  };

  const refresh = async (ctx: ExtensionContext): Promise<ConfigSnapshot> => {
    const snapshot = await loader.refresh();
    updateStatus(ctx, snapshot);
    return snapshot;
  };

  const activateById = async (ctx: ExtensionContext, id: string): Promise<void> => {
    const snapshot = loader.current;
    if (!snapshot.ok) return;
    const mode = snapshot.config.modes.find((item) => item.id === id);
    if (!mode) {
      ctx.ui.notify(`Unknown mode "${id}"`, "warning");
      return;
    }
    await activate(ctx, mode);
  };

  const cycle = async (ctx: ExtensionContext, direction: 1 | -1): Promise<void> => {
    const snapshot = await refresh(ctx);
    if (!snapshot.ok) {
      ctx.ui.notify("Model modes unavailable; run /mode doctor", "warning");
      return;
    }
    const failures: string[] = [];
    for (const mode of cycleOrder(snapshot.config, active, direction)) {
      const result = await activate(ctx, mode, true);
      if (result.ok) {
        ctx.ui.notify(`Mode: ${mode.label}${mode.description ? ` — ${mode.description}` : ""}`, "info");
        return;
      }
      failures.push(`${mode.id}: ${result.message}`);
      if (!result.rollbackSucceeded) break;
    }
    ctx.ui.notify(`No usable mode: ${failures.join("; ")}`, "warning");
  };

  const showPicker = async (ctx: ExtensionContext, config: ModeConfig): Promise<void> => {
    const items: SelectItem[] = config.modes.map((mode) => ({
      value: mode.id,
      label: active.kind === "named" && active.mode.id === mode.id ? `${mode.label} (active)` : mode.label,
      description: `${mode.provider}/${mode.model} · thinking:${mode.thinkingLevel}${mode.description ? ` · ${mode.description}` : ""}`,
    }));
    const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Select Mode")), 1, 0));
      const list = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = (item) => done(String(item.value));
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
      };
    });
    if (selected) await activateById(ctx, selected);
  };

  const doctorRegistry = (ctx: ExtensionContext) => ({
    find: (provider: string, id: string) => {
      const model = ctx.modelRegistry.find(provider, id);
      return model ? asModeModel(model) : undefined;
    },
    available: () => ctx.modelRegistry.getAvailable().map(asModeModel),
  });

  const showDoctor = async (ctx: ExtensionContext): Promise<void> => {
    const report = formatDoctorReport(inspectConfig(loader.current, doctorRegistry(ctx), registeredShortcut));
    if (ctx.mode === "tui") await ctx.ui.editor("model-modes doctor", report);
    else console.log(report);
  };

  const showHelp = async (ctx: ExtensionContext): Promise<void> => {
    const help = [
      "/mode — pick a mode",
      "/mode <id> — activate a mode",
      "/mode next — cycle forward",
      "/mode previous — cycle backward",
      "/mode doctor — inspect configuration",
      "/mode help — show this help",
      `Config: ${loader.path}`,
    ].join("\n");
    if (ctx.mode === "tui") await ctx.ui.editor("model-modes help", help);
    else console.log(help);
  };

```

Register the optional initial shortcut before session events:

```ts
if (registeredShortcut) {
  pi.registerShortcut(registeredShortcut, {
    description: "Cycle model and thinking mode",
    handler: async (ctx) => { await cycle(ctx, 1); },
  });
}
```

Register exactly one command:

```ts
pi.registerCommand("mode", {
  description: "Select a model and thinking mode",
  handler: async (args, ctx) => {
    const snapshot = await refresh(ctx);
    const command = args.trim();
    if (command === "doctor") return showDoctor(ctx);
    if (command === "help") return showHelp(ctx);
    if (!snapshot.ok) {
      ctx.ui.notify(`Model modes unavailable; run /mode doctor`, "warning");
      return;
    }
    if (command === "next") return cycle(ctx, 1);
    if (command === "previous") return cycle(ctx, -1);
    if (command.length > 0) return activateById(ctx, command);
    if (ctx.mode !== "tui") {
      console.log(formatModeList(snapshot.config));
      return;
    }
    return showPicker(ctx, snapshot.config);
  },
});
```

Register state synchronization:

```ts
pi.on("session_start", async (event, ctx) => {
  const snapshot = await loader.refresh();
  updateStatus(ctx, snapshot);
  if (snapshot.ok && isFreshSession(event, ctx.sessionManager.getEntries())) {
    const mode = snapshot.config.modes.find((item) => item.id === snapshot.config.defaultMode)!;
    await activate(ctx, mode);
  }
});

pi.on("model_select", async (_event, ctx) => {
  if (!applying) updateStatus(ctx);
});

pi.on("thinking_level_select", async (_event, ctx) => {
  if (!applying) updateStatus(ctx);
});
```


- [ ] **Step 4: Run wiring tests and typecheck to verify GREEN**

Run:

```bash
node --test pi/extensions/model-modes/index.test.ts
npm run typecheck
```

Expected: wiring tests PASS; typecheck exits 0.

- [ ] **Step 5: Run the complete test suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: every `model-modes` test passes; focused strict typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add pi/extensions/model-modes/index.ts pi/extensions/model-modes/index.test.ts
git commit -m "feat(model-modes): wire mode selection into Pi"
```

---

### Task 6: User Documentation, Example Mapping, and Final Verification

**Files:**
- Create: `pi/extensions/model-modes/README.md`
- Create: `pi/extensions/model-modes/example.json`
- Verify: all files created in Tasks 1–5

**Interfaces:**
- Documents the exact schema and runtime behavior implemented by earlier tasks.
- The example file is not auto-loaded and contains illustrative provider/model IDs only.

- [ ] **Step 1: Write the example mapping**

Create `pi/extensions/model-modes/example.json`:

```json
{
  "version": 1,
  "defaultMode": "medium",
  "cycleShortcut": "f8",
  "modes": [
    {
      "id": "low",
      "label": "Low",
      "provider": "zai",
      "model": "glm-5.2",
      "thinkingLevel": "low",
      "description": "Fast, low-cost mode for small, well-defined tasks"
    },
    {
      "id": "medium",
      "label": "Medium",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "medium",
      "description": "Balanced intelligence, speed, and cost"
    },
    {
      "id": "high",
      "label": "High",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "high",
      "description": "Deep reasoning for hard tasks"
    },
    {
      "id": "ultra",
      "label": "Ultra",
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "thinkingLevel": "max",
      "description": "Maximum effort for hard, open-ended tasks"
    }
  ]
}
```

State clearly in the README that these IDs are examples and are never used unless the user copies the file to a selected configuration path.

- [ ] **Step 2: Write the extension README**

Create `pi/extensions/model-modes/README.md` with these sections and exact facts:

```markdown
# Model Modes

Select a provider, model, and Pi thinking level as one named mode.

## Configuration

Create `~/.pi/agent/model-modes.json`, or set `PI_MODEL_MODES_CONFIG` to an absolute path or a path relative to Pi's startup directory. The environment-selected file replaces the global file; files are never merged.

[Include the complete example JSON.]

Every mode is user-defined. The extension does not supply fallback modes and never writes this file.

## Commands

- `/mode` — open the picker
- `/mode <id>` — select a mode
- `/mode next` — cycle forward
- `/mode previous` — cycle backward
- `/mode doctor` — validate config and model compatibility
- `/mode help` — show usage and resolved config path

## Reload behavior

Mapping edits are detected before the next command or shortcut action. Changing `cycleShortcut` requires `/reload`.

## Startup and Custom State

`defaultMode` applies only to fresh startup and `/new` sessions. Resumed, forked, and reloaded sessions keep their Pi state. `mode:custom` means the actual provider/model/thinking triple does not exactly match a configured mode.
```

Replace the bracketed instruction with the literal JSON from `example.json`; do not leave bracket text in the file.

- [ ] **Step 3: Verify documentation examples parse through the production loader**

Add this test to `config.test.ts`:

```ts
import { readFile } from "node:fs/promises";

// ...
test("documented example is a valid configuration", async () => {
  const raw = JSON.parse(await readFile(new URL("./example.json", import.meta.url), "utf8"));
  const parsed = parseModeConfig(raw);
  assert.deepEqual(parsed.modes.map((mode) => mode.id), ["low", "medium", "high", "ultra"]);
  assert.equal(parsed.modes[3]?.thinkingLevel, "max");
});
```

- [ ] **Step 4: Run final automated verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected:

- All model-mode tests pass with zero failures.
- Focused TypeScript check exits 0.
- `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Perform a temporary manual smoke test**

Create a temporary mapping using model IDs returned by the local Pi installation:

```bash
pi --list-models
```

Start Pi with the extension package and temporary config:

```bash
PI_MODEL_MODES_CONFIG=/tmp/model-modes-smoke.json pi -e .
```

Verify interactively:

1. `/mode doctor` reports `Status: OK`.
2. `/mode` opens the picker.
3. Selecting a mode changes both the footer model and thinking level.
4. The configured shortcut cycles to the next mode.
5. Manually changing thinking produces `mode:custom`.
6. Restoring the exact triple restores the named status.
7. Editing a model mapping is detected on the next `/mode` action.
8. Editing the shortcut makes doctor report that `/reload` is required.

Delete `/tmp/model-modes-smoke.json` after the smoke test.

- [ ] **Step 6: Commit**

```bash
git add pi/extensions/model-modes/README.md pi/extensions/model-modes/example.json pi/extensions/model-modes/config.test.ts
git commit -m "docs(model-modes): add configuration guide"
```

---

## Final Review Checklist

- [ ] Compare every requirement in `docs/superpowers/specs/2026-07-16-model-modes-extension-design.md` against Tasks 1–6.
- [ ] Confirm a case-insensitive scan for unfinished implementation markers under `pi/extensions/model-modes` returns no matches.
- [ ] Confirm `git grep -n '@mariozechner/' -- pi/extensions/model-modes` returns no matches.
- [ ] Confirm the extension registers exactly one command namespace, `mode`.
- [ ] Confirm no production path calls `writeFile`, `appendFile`, or otherwise mutates the mapping file.
- [ ] Confirm failed rollback stops cycling.
- [ ] Confirm `npm test`, `npm run typecheck`, and `git diff --check` all exit 0 in fresh output.
- [ ] Use the requesting-code-review skill before merging or creating a pull request.
