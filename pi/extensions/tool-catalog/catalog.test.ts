import assert from "node:assert/strict";
import test from "node:test";
import {
	ACTIVE_MARK,
	buildRows,
	type CatalogTool,
	extensionName,
	formatHeader,
	INTENT_VALUES,
	layoutHeader,
	packageName,
	type ToolOverride,
} from "./catalog.ts";

/** What the catalog sees of the session: what is active, and what you pinned. */
function view(active: string[] = [], overrides: [string, ToolOverride][] = []) {
	return { active: new Set(active), overrides: new Map(overrides) };
}

const PATHS = { home: "/Users/dev" };
const REPO = "/Users/dev/Develop/agent-stuff";

function builtin(name: string, description = ""): CatalogTool {
	return {
		name,
		description,
		sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
	};
}

function sdk(name: string, description = ""): CatalogTool {
	return {
		name,
		description,
		sourceInfo: { path: `<sdk:${name}>`, source: "sdk", scope: "temporary", origin: "top-level" },
	};
}

/** A tool from an extension in the user's own checked-out package. */
function local(name: string, extension: string, description = ""): CatalogTool {
	return {
		name,
		description,
		sourceInfo: {
			path: `${REPO}/pi/extensions/${extension}/index.ts`,
			source: REPO,
			scope: "project",
			origin: "package",
			baseDir: REPO,
		},
	};
}

const GIT_BASE = "/Users/dev/.pi/agent/git/github.com/hoesler/amp-themes";

/** A tool from an extension nested inside an installed git package. */
function fromGitPackage(name: string, extension: string, description = ""): CatalogTool {
	return {
		name,
		description,
		sourceInfo: {
			path: `${GIT_BASE}/node_modules/${extension}/index.ts`,
			source: "git:github.com/hoesler/amp-themes",
			scope: "user",
			origin: "package",
			baseDir: GIT_BASE,
		},
	};
}

function rowFor(rows: ReturnType<typeof buildRows>, name: string) {
	const row = rows.find((candidate) => candidate.name === name);
	assert.ok(row, `no row for ${name}`);
	return row;
}

test("the second column names the extension that defines the tool, not its package spec", () => {
	const rows = buildRows([fromGitPackage("ls", "pi-tool-display"), local("subagent", "subagent")], view(), PATHS);

	assert.match(rowFor(rows, "ls").label, /^\s+ls\s+pi-tool-display$/);
	assert.match(rowFor(rows, "subagent").label, /^\s+subagent\s+subagent\s*$/);
});

test("a single-file extension is named by its filename", () => {
	const tool: CatalogTool = {
		name: "notes",
		description: "",
		sourceInfo: {
			path: "/Users/dev/.pi/agent/extensions/scratchpad.ts",
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	};

	assert.equal(extensionName(tool.sourceInfo), "scratchpad");
});

test("pi's own tools are named builtin and sdk rather than by a synthetic path", () => {
	assert.equal(extensionName(builtin("read").sourceInfo), "builtin");
	assert.equal(extensionName(sdk("web_search").sourceInfo), "sdk");
});

test("a git package is named by its repository, an npm package keeps its scope", () => {
	assert.equal(packageName("git:github.com/hoesler/amp-themes"), "amp-themes");
	assert.equal(packageName("npm:@acme/pi-extras"), "@acme/pi-extras");
	assert.equal(packageName(REPO), "agent-stuff");
	assert.equal(packageName("builtin"), undefined);
	assert.equal(packageName("local"), undefined);
});

test("rows are ordered builtin first, then sdk, then by extension name", () => {
	const rows = buildRows(
		[
			local("subagent", "subagent"),
			sdk("web_search"),
			fromGitPackage("ls", "pi-tool-display"),
			local("session_search", "session-search"),
			builtin("read"),
		],
		view(),
		PATHS,
	);

	assert.deepEqual(
		rows.map((row) => row.name),
		["read", "web_search", "ls", "session_search", "subagent"],
	);
});

test("tools from one extension are ordered by name", () => {
	const rows = buildRows([builtin("write"), builtin("bash"), builtin("read")], view(), PATHS);

	assert.deepEqual(
		rows.map((row) => row.name),
		["bash", "read", "write"],
	);
});

test("name and extension columns are padded to a common width so every row aligns", () => {
	const rows = buildRows([builtin("bash"), local("subagent", "subagent")], view(), PATHS);

	const widths = new Set(rows.map((row) => row.label.length));
	assert.equal(widths.size, 1, "labels must share one width");
	assert.equal(rowFor(rows, "bash").label, "  bash      builtin ");
	assert.equal(rowFor(rows, "subagent").label, "  subagent  subagent");
});

test("an over-long tool name is truncated so one MCP tool cannot skew every row", () => {
	const long = "mcp__claude_ai_Clinical_Trials__complete_authentication";
	const rows = buildRows([builtin(long), builtin("read")], view(), PATHS);

	assert.match(rowFor(rows, long).label, /^\s+mcp__claude_ai_Clinical_Tri…\s+builtin$/);
});

test("a dot marks the tools in this turn's schema", () => {
	const rows = buildRows([builtin("read"), builtin("write")], view(["read"]), PATHS);

	assert.equal(rowFor(rows, "read").active, true);
	assert.ok(rowFor(rows, "read").label.startsWith(`${ACTIVE_MARK} `));
	assert.equal(rowFor(rows, "write").active, false);
	assert.ok(rowFor(rows, "write").label.startsWith("  "));
});

test("the value column shows your intent, which is not the same as being active", () => {
	const rows = buildRows([builtin("read"), builtin("write"), builtin("bash")], view(["read", "bash"], [["read", "on"], ["write", "off"]]), PATHS);

	assert.equal(rowFor(rows, "read").value, "on");
	assert.equal(rowFor(rows, "write").value, "off");
	assert.equal(rowFor(rows, "bash").value, "auto");
});

test("intent cycles auto, on, off", () => {
	assert.deepEqual(INTENT_VALUES, ["auto", "on", "off"]);
});

test("an unpinned tool reports whether it is active and leaves the reason alone", () => {
	const rows = buildRows([builtin("read", "Read a file."), builtin("write", "Write a file.")], view(["read"]), PATHS);

	assert.equal(rowFor(rows, "read").description, "Read a file.\nauto — active\nbuiltin");
	assert.equal(rowFor(rows, "write").description, "Write a file.\nauto — not active\nbuiltin");
});

test("a pinned tool says so, so a stale pin is visible next to the dot", () => {
	const rows = buildRows(
		[builtin("read", "Read a file."), builtin("write", "Write a file.")],
		view(["read", "write"], [["read", "on"], ["write", "off"]]),
		PATHS,
	);

	assert.equal(rowFor(rows, "read").description, "Read a file.\non — pinned active\nbuiltin");
	assert.equal(rowFor(rows, "write").description, "Write a file.\noff — pinned off\nbuiltin");
});

test("a package tool spells out extension, package, and scope, then its path", () => {
	const rows = buildRows([local("subagent", "subagent", "Launch a subagent.")], view(), PATHS);

	assert.equal(
		rowFor(rows, "subagent").description,
		"Launch a subagent.\nauto — not active\nsubagent · agent-stuff · project\n~/Develop/agent-stuff/pi/extensions/subagent/index.ts",
	);
});

test("the whole path is spelled out, so a nested extension's base folder is visible", () => {
	const rows = buildRows([fromGitPackage("ls", "pi-tool-display", "List directory contents.")], view(), PATHS);

	assert.equal(
		rowFor(rows, "ls").description,
		"List directory contents.\nauto — not active\npi-tool-display · amp-themes · user\n" +
			"~/.pi/agent/git/github.com/hoesler/amp-themes/node_modules/pi-tool-display/index.ts",
	);
});

test("a builtin reports nothing beyond builtin — it has no package or path", () => {
	const rows = buildRows([builtin("read", "Read a file.")], view(), PATHS);

	assert.equal(rowFor(rows, "read").description, "Read a file.\nauto — not active\nbuiltin");
});

test("an extension outside any package still reports its scope and path", () => {
	const tool: CatalogTool = {
		name: "notes",
		description: "Take notes.",
		sourceInfo: {
			path: "/Users/dev/.pi/agent/extensions/scratchpad.ts",
			source: "local",
			scope: "user",
			origin: "top-level",
		},
	};
	const rows = buildRows([tool], view(), PATHS);

	assert.equal(rowFor(rows, "notes").description, "Take notes.\nauto — not active\nscratchpad · user\n~/.pi/agent/extensions/scratchpad.ts");
});

test("a path outside home keeps its absolute form", () => {
	const tool: CatalogTool = {
		name: "odd",
		description: "Odd.",
		sourceInfo: { path: "/opt/pi/odd.ts", source: "local", scope: "temporary", origin: "top-level" },
	};
	const rows = buildRows([tool], view(), PATHS);

	assert.equal(rowFor(rows, "odd").description, "Odd.\nauto — not active\nodd · temporary\n/opt/pi/odd.ts");
});

test("only the first paragraph survives, with its whitespace collapsed", () => {
	const description = "Runs a  command\nin the project.\n\nDo not use it for reading files.";
	const rows = buildRows([builtin("bash", description)], view(), PATHS);

	assert.equal(rowFor(rows, "bash").description, "Runs a command in the project.\nauto — not active\nbuiltin");
});

test("a summary longer than the cap ends in an ellipsis", () => {
	const rows = buildRows([builtin("verbose", "x".repeat(300))], view(), PATHS);

	const summary = rowFor(rows, "verbose").description.split("\n")[0] ?? "";
	assert.equal(summary.length, 240);
	assert.ok(summary.endsWith("…"));
});

test("a tool without a description shows only its origin", () => {
	const rows = buildRows([builtin("read")], view(), PATHS);

	assert.equal(rowFor(rows, "read").description, "auto — not active\nbuiltin");
});

test("the header counts tools and how many are active", () => {
	assert.equal(formatHeader(43, 39), "43 tools · 39 active");
});

test("the header stays grammatical for a single tool", () => {
	assert.equal(formatHeader(1, 0), "1 tool · 0 active");
});

test("the header line right-aligns the counts against the title", () => {
	const line = layoutHeader("Tool Catalog", "3 tools · 1 enabled", 40);

	assert.equal(line, "Tool Catalog         3 tools · 1 enabled");
	assert.equal(line.length, 40);
});

test("a terminal too narrow for both keeps them apart by a single space", () => {
	assert.equal(layoutHeader("Tool Catalog", "3 tools · 1 enabled", 10), "Tool Catalog 3 tools · 1 enabled");
});

test("styling wraps the title and counts but never the padding between them", () => {
	const line = layoutHeader("Catalog", "1 tool · 1 enabled", 30, {
		title: (text) => `<b>${text}</b>`,
		counts: (text) => `<dim>${text}</dim>`,
	});

	assert.equal(line, "<b>Catalog</b>     <dim>1 tool · 1 enabled</dim>");
});
