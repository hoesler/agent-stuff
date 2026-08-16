import assert from "node:assert/strict";
import test from "node:test";
import { type BranchEntry, nextActiveTools, OVERRIDES_ENTRY, restoreOverrides } from "./state.ts";

function saved(overrides: Record<string, string>): BranchEntry {
	return { type: "custom", customType: OVERRIDES_ENTRY, data: { overrides } };
}

const REGISTERED = new Set(["read", "write", "bash", "run_experiment"]);

test("with nothing saved there are no overrides", () => {
	assert.equal(restoreOverrides([{ type: "message" }]).size, 0);
});

test("the last saved overrides in the branch win", () => {
	const overrides = restoreOverrides([saved({ read: "off" }), saved({ write: "on" })]);

	assert.deepEqual([...overrides], [["write", "on"]]);
});

test("other extensions' custom entries are ignored", () => {
	const entries: BranchEntry[] = [{ type: "custom", customType: "model-modes", data: { overrides: { read: "off" } } }];

	assert.equal(restoreOverrides(entries).size, 0);
});

test("the retired whole-list format is ignored rather than read as intent", () => {
	const legacy: BranchEntry = { type: "custom", customType: "tools-config", data: { enabledTools: ["read"] } };

	assert.equal(restoreOverrides([legacy]).size, 0);
});

test("an unrecognized intent is dropped, keeping the rest of the entry", () => {
	const overrides = restoreOverrides([saved({ read: "off", write: "maybe" })]);

	assert.deepEqual([...overrides], [["read", "off"]]);
});

test("a malformed entry does not discard the last good overrides", () => {
	const overrides = restoreOverrides([saved({ bash: "off" }), { type: "custom", customType: OVERRIDES_ENTRY, data: {} }]);

	assert.deepEqual([...overrides], [["bash", "off"]]);
});

test("with no overrides the active list is left exactly as the session has it", () => {
	assert.equal(nextActiveTools(["read", "write"], new Map(), REGISTERED), undefined);
});

test("a tool pinned off is dropped from the live list", () => {
	const next = nextActiveTools(["read", "write", "bash"], new Map([["write", "off"]]), REGISTERED);

	assert.deepEqual(next, ["read", "bash"]);
});

test("a tool pinned on is added to whatever is already live", () => {
	const next = nextActiveTools(["read"], new Map([["run_experiment", "on"]]), REGISTERED);

	assert.deepEqual(next, ["read", "run_experiment"]);
});

test("pinning on a tool another extension already activated changes nothing", () => {
	assert.equal(nextActiveTools(["read", "run_experiment"], new Map([["run_experiment", "on"]]), REGISTERED), undefined);
});

test("pinning off a tool that is not active changes nothing", () => {
	assert.equal(nextActiveTools(["read"], new Map([["write", "off"]]), REGISTERED), undefined);
});

test("an override for a tool that is no longer registered is ignored", () => {
	assert.equal(nextActiveTools(["read"], new Map([["retired_tool", "on"]]), REGISTERED), undefined);
});

test("the live order survives, so pinning does not reshuffle the schema", () => {
	const next = nextActiveTools(
		["bash", "read", "write"],
		new Map<string, "on" | "off">([
			["read", "off"],
			["run_experiment", "on"],
		]),
		REGISTERED,
	);

	assert.deepEqual(next, ["bash", "write", "run_experiment"]);
});
