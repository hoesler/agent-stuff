/**
 * Tool Catalog
 *
 * `/tools` shows every tool the session can see — its name, where it came from,
 * and what it does — and lets you toggle one off from the same list. Browsing is
 * the point; the checkbox is the afterthought.
 *
 * Selections persist as session entries, so they follow forks and survive a
 * reload of the branch they were made on.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { buildRows, CHECKED, formatHeader, layoutHeader, TOGGLE_VALUES } from "./catalog.ts";
import { restoreEnabled, TOOLS_CONFIG_ENTRY, type ToolsState } from "./state.ts";

const TITLE = "Tool Catalog";
const MAX_VISIBLE_ROWS = 15;

/** Counts are read at render time so toggling a row updates them in place. */
class CatalogHeader implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly counts: () => string,
	) {}

	render(width: number): string[] {
		return [
			layoutHeader(TITLE, this.counts(), width, {
				title: (text) => this.theme.fg("accent", this.theme.bold(text)),
				counts: (text) => this.theme.fg("muted", text),
			}),
			"",
		];
	}

	invalidate(): void {}
}

export default function toolCatalogExtension(pi: ExtensionAPI) {
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	function persistState() {
		pi.appendEntry<ToolsState>(TOOLS_CONFIG_ENTRY, { enabledTools: Array.from(enabledTools) });
	}

	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const { enabled, restored } = restoreEnabled(
			ctx.sessionManager.getBranch(),
			allTools.map((tool) => tool.name),
			pi.getActiveTools(),
		);
		enabledTools = enabled;
		// Adopting the session's own set changes nothing; rewriting it would only
		// risk clobbering a list another extension is managing.
		if (restored) applyTools();
	}

	pi.registerCommand("tools", {
		description: "Browse every tool with its source, and toggle tools on or off",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = buildRows(allTools, enabledTools).map((row) => ({
					id: row.name,
					label: row.label,
					currentValue: row.value,
					values: TOGGLE_VALUES,
					description: row.description,
				}));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length, MAX_VISIBLE_ROWS),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === CHECKED) enabledTools.add(id);
						else enabledTools.delete(id);
						applyTools();
						persistState();
						tui.requestRender();
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				const container = new Container();
				container.addChild(new CatalogHeader(theme, () => formatHeader(allTools.length, enabledTools.size)));
				container.addChild(settingsList);

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Branch navigation can land on a different selection than the one in memory.
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
