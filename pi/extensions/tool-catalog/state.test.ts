import assert from "node:assert/strict";
import test from "node:test";
import { type BranchEntry, restoreEnabled, TOOLS_CONFIG_ENTRY } from "./state.ts";

function saved(enabledTools: string[]): BranchEntry {
	return { type: "custom", customType: TOOLS_CONFIG_ENTRY, data: { enabledTools } };
}

const ALL = ["read", "write", "bash"];

test("with nothing saved the session's active tools are adopted as-is", () => {
	const { enabled } = restoreEnabled([{ type: "message" }], ALL, ["read", "bash"]);

	assert.deepEqual([...enabled].sort(), ["bash", "read"]);
});

test("the last saved selection in the branch wins", () => {
	const { enabled } = restoreEnabled([saved(["read"]), saved(["write", "bash"])], ALL, ["read"]);

	assert.deepEqual([...enabled].sort(), ["bash", "write"]);
});

test("tools that no longer exist are dropped from a saved selection", () => {
	const { enabled } = restoreEnabled([saved(["read", "retired_tool"])], ALL, []);

	assert.deepEqual([...enabled], ["read"]);
});

test("a saved selection that disabled everything is honored, not mistaken for no state", () => {
	const { enabled } = restoreEnabled([saved([])], ALL, ["read", "write"]);

	assert.deepEqual([...enabled], []);
});

test("other extensions' custom entries are ignored", () => {
	const { enabled } = restoreEnabled(
		[{ type: "custom", customType: "model-modes", data: { enabledTools: ["write"] } }],
		ALL,
		["read"],
	);

	assert.deepEqual([...enabled], ["read"]);
});

test("a restored selection is flagged so the caller re-applies it to the session", () => {
	assert.equal(restoreEnabled([saved(["read"])], ALL, []).restored, true);
});

test("falling back to the active tools reports nothing restored, so nothing is rewritten", () => {
	assert.equal(restoreEnabled([{ type: "message" }], ALL, ["read"]).restored, false);
});

test("a malformed entry does not discard the last good selection", () => {
	const { enabled } = restoreEnabled(
		[saved(["bash"]), { type: "custom", customType: TOOLS_CONFIG_ENTRY, data: {} }],
		ALL,
		["read"],
	);

	assert.deepEqual([...enabled], ["bash"]);
});
