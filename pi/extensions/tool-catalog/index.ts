/**
 * Tool Catalog
 *
 * `/tools` shows every tool the session can see — its name, where it came from,
 * and what it does — and lets you pin one on or off from the same list.
 * Browsing is the point; the pinning is the afterthought.
 *
 * pi separates registered tools from active ones, and extensions switch their
 * own tools in and out of the schema as they go. So the catalog reads the live
 * active list every time it renders or writes, and remembers only your
 * overrides. Anything left on `auto` stays exactly where its extension put it.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	ACTIVE_MARK,
	buildRows,
	formatHeader,
	INTENT_VALUES,
	layoutHeader,
	type ToolIntent,
	type ToolOverride,
} from "./catalog.ts";
import { nextActiveTools, type OverridesState, OVERRIDES_ENTRY, restoreOverrides } from "./state.ts";

const TITLE = "Tool Catalog";
const LEGEND = `${ACTIVE_MARK} = in this turn's tool schema`;
const MAX_VISIBLE_ROWS = 15;

/** Counts are read at render time so a change updates them in place. */
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
			this.theme.fg("muted", LEGEND),
			"",
		];
	}

	invalidate(): void {}
}

export default function toolCatalogExtension(pi: ExtensionAPI) {
	let overrides: Map<string, ToolOverride> = new Map();
	let allTools: ToolInfo[] = [];

	function persistOverrides() {
		pi.appendEntry<OverridesState>(OVERRIDES_ENTRY, { overrides: Object.fromEntries(overrides) });
	}

	/** Apply intent to the live list, and only when it actually changes it. */
	function applyOverrides() {
		const registered = new Set(allTools.map((tool) => tool.name));
		const next = nextActiveTools(pi.getActiveTools(), overrides, registered);
		if (next) pi.setActiveTools(next);
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		overrides = restoreOverrides(ctx.sessionManager.getBranch());
		applyOverrides();
	}

	pi.registerCommand("tools", {
		description: "Browse every tool with its source, and pin tools on or off",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = [];
				const itemsByName = new Map<string, SettingItem>();

				/** Rebuild every row from the live session, not from what we last drew. */
				function refresh() {
					const rows = buildRows(allTools, { active: new Set(pi.getActiveTools()), overrides });
					items.length = 0;
					itemsByName.clear();
					for (const row of rows) {
						const item: SettingItem = {
							id: row.name,
							label: row.label,
							currentValue: row.value,
							values: INTENT_VALUES,
							description: row.description,
						};
						items.push(item);
						itemsByName.set(row.name, item);
					}
				}

				refresh();

				const settingsList = new SettingsList(
					items,
					Math.min(items.length, MAX_VISIBLE_ROWS),
					getSettingsListTheme(),
					(id, newValue) => {
						const intent = newValue as ToolIntent;
						if (intent === "auto") overrides.delete(id);
						else overrides.set(id, intent);
						applyOverrides();
						persistOverrides();
						// Activity may have changed for this row; redraw them all in place,
						// since the list holds these item objects and not our rows.
						const active = new Set(pi.getActiveTools());
						for (const row of buildRows(allTools, { active, overrides })) {
							const item = itemsByName.get(row.name);
							if (!item) continue;
							item.label = row.label;
							item.description = row.description;
						}
						tui.requestRender();
					},
					() => done(undefined),
					{ enableSearch: true },
				);

				const container = new Container();
				container.addChild(
					new CatalogHeader(theme, () => formatHeader(allTools.length, pi.getActiveTools().length)),
				);
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

	// Branch navigation can land on different overrides than the ones in memory.
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
