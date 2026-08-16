/**
 * Turns the live tool list into rows a settings list can render.
 *
 * Pure string work — no pi imports beyond the tool shape — so the layout is
 * testable without a TUI. The catalog's job is answering "what is this tool and
 * who gave it to me", so every row carries its origin; the checkbox is along
 * for the ride.
 *
 * "Who gave it to me" is the extension, not the package: `sourceInfo.source` is
 * a package spec (`git:github.com/owner/repo`) or a checkout path, neither of
 * which fits a column or reads as a name. The extension name comes from the
 * file that registered the tool, and the package spec moves to the detail line.
 */

import * as os from "node:os";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** The slice of `ToolInfo` the catalog reads. Narrow so tests need no schema. */
export type CatalogTool = Pick<ToolInfo, "name" | "description" | "sourceInfo">;
type SourceInfo = CatalogTool["sourceInfo"];

/** What you pinned. Anything unpinned is `auto` — left to whoever manages it. */
export type ToolOverride = "on" | "off";
export type ToolIntent = "auto" | ToolOverride;

/** The session as the catalog sees it: what is active, and what you pinned. */
export interface CatalogView {
	active: ReadonlySet<string>;
	overrides: ReadonlyMap<string, ToolOverride>;
}

export interface CatalogRow {
	name: string;
	/** Activity mark, name, and extension, padded so the value column lines up. */
	label: string;
	/** Your intent, shown in the value column and cycled from there. */
	value: ToolIntent;
	/** Summary, state, origin, and path — shown while the row is selected. */
	description: string;
	/** Whether the tool is in this turn's schema, which intent alone cannot say. */
	active: boolean;
}

export interface CatalogPaths {
	home: string;
}

export const ACTIVE_MARK = "●";
/** Cycling order in the settings list: the default first. */
export const INTENT_VALUES: ToolIntent[] = ["auto", "on", "off"];

/** A name past this is truncated: one MCP tool should not widen every row. */
const NAME_COLUMN_MAX = 28;
const EXTENSION_COLUMN_MAX = 20;
const SUMMARY_MAX = 240;

/** Sources pi synthesizes rather than loads from disk — their paths say nothing. */
const SYNTHETIC_SOURCES = new Set(["builtin", "sdk"]);
/** Sources that name no package: a loose file, or one passed on the command line. */
const UNPACKAGED_SOURCES = new Set(["local", "cli"]);

function truncate(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function columnWidth(values: string[], max: number): number {
	return Math.min(max, Math.max(0, ...values.map((value) => value.length)));
}

/** The activity mark shares the label, since the list styles only two columns. */
function rowLabel(active: boolean, name: string, nameWidth: number, extension: string, extensionWidth: number): string {
	const mark = active ? `${ACTIVE_MARK} ` : "  ";
	return `${mark}${name.padEnd(nameWidth)}  ${extension.padEnd(extensionWidth)}`;
}

function segments(path: string): string[] {
	return path.split("/").filter((segment) => segment.length > 0);
}

/** Rank sources so the tools you did not choose sink below the ones you did. */
function sourceRank(source: string): number {
	if (source === "builtin") return 0;
	if (source === "sdk") return 1;
	return 2;
}

/**
 * The extension that registered the tool, named after the file that defines it:
 * the directory for the usual `<extension>/index.ts`, the filename for a
 * single-file extension.
 */
export function extensionName(sourceInfo: SourceInfo): string {
	if (SYNTHETIC_SOURCES.has(sourceInfo.source)) return sourceInfo.source;
	const parts = segments(sourceInfo.path);
	const file = parts.at(-1) ?? "";
	const base = file.replace(/\.[cm]?[jt]sx?$/, "");
	if (base === "index" && parts.length > 1) return parts.at(-2) ?? base;
	return base || sourceInfo.source;
}

/** The package an extension shipped in, or nothing when it shipped alone. */
export function packageName(source: string): string | undefined {
	if (!source || SYNTHETIC_SOURCES.has(source) || UNPACKAGED_SOURCES.has(source)) return undefined;
	// An npm spec is already a name, and its scope is part of the identity.
	if (source.startsWith("npm:")) return source.slice("npm:".length) || undefined;
	const spec = source.startsWith("git:") ? source.slice("git:".length) : source;
	return segments(spec).at(-1);
}

/**
 * The whole path, collapsing only the home prefix.
 *
 * Relative forms save room but cost the answer: `node_modules/pi-tool-display`
 * says what the extension is called and nothing about where it came from, which
 * is half of what the catalog exists to tell you.
 */
export function displayPath(path: string, home: string): string {
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function formatOrigin(sourceInfo: SourceInfo, paths: CatalogPaths): string {
	if (SYNTHETIC_SOURCES.has(sourceInfo.source)) return sourceInfo.source;
	const attribution = [extensionName(sourceInfo), packageName(sourceInfo.source), sourceInfo.scope]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
	return `${attribution}\n${displayPath(sourceInfo.path, paths.home)}`;
}

/** First paragraph, collapsed to one line — the rest is for the tool's own docs. */
export function summarize(description: string): string {
	const paragraph = description.split(/\n\s*\n/)[0] ?? "";
	const collapsed = paragraph.replace(/\s+/g, " ").trim();
	return truncate(collapsed, SUMMARY_MAX);
}

export function formatHeader(total: number, active: number): string {
	return `${total} tool${total === 1 ? "" : "s"} · ${active} active`;
}

/**
 * Intent and reality on one line. They can disagree: an extension is free to
 * activate a tool you pinned off, and the catalog would rather show that than
 * pretend a pin is a guarantee.
 */
export function formatState(intent: ToolIntent, active: boolean): string {
	if (intent === "on") return "on — pinned active";
	if (intent === "off") return "off — pinned off";
	return active ? "auto — active" : "auto — not active";
}

export interface HeaderStyle {
	title?: (text: string) => string;
	counts?: (text: string) => string;
}

/**
 * Title left, counts right. Too narrow for both, they still stay apart.
 *
 * Styling happens here rather than at the call site so the gap is measured on
 * plain text — ANSI codes would count as width and push the counts off screen.
 */
export function layoutHeader(title: string, counts: string, width: number, style: HeaderStyle = {}): string {
	const gap = Math.max(1, width - title.length - counts.length);
	const styledTitle = style.title ? style.title(title) : title;
	const styledCounts = style.counts ? style.counts(counts) : counts;
	return `${styledTitle}${" ".repeat(gap)}${styledCounts}`;
}

export function buildRows(
	tools: CatalogTool[],
	view: CatalogView,
	paths: CatalogPaths = { home: os.homedir() },
): CatalogRow[] {
	const sorted = [...tools].sort((a, b) => {
		const byRank = sourceRank(a.sourceInfo.source) - sourceRank(b.sourceInfo.source);
		if (byRank !== 0) return byRank;
		const byExtension = extensionName(a.sourceInfo).localeCompare(extensionName(b.sourceInfo));
		if (byExtension !== 0) return byExtension;
		return a.name.localeCompare(b.name);
	});

	const names = sorted.map((tool) => truncate(tool.name, NAME_COLUMN_MAX));
	const extensions = sorted.map((tool) => truncate(extensionName(tool.sourceInfo), EXTENSION_COLUMN_MAX));
	const nameWidth = columnWidth(names, NAME_COLUMN_MAX);
	const extensionWidth = columnWidth(extensions, EXTENSION_COLUMN_MAX);

	return sorted.map((tool, index) => {
		const active = view.active.has(tool.name);
		const intent = view.overrides.get(tool.name) ?? "auto";
		const summary = summarize(tool.description ?? "");
		const detail = [formatState(intent, active), formatOrigin(tool.sourceInfo, paths)];
		return {
			name: tool.name,
			label: rowLabel(active, names[index] ?? "", nameWidth, extensions[index] ?? "", extensionWidth),
			value: intent,
			description: (summary ? [summary, ...detail] : detail).join("\n"),
			active,
		};
	});
}
