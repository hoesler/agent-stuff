import assert from "node:assert/strict";
import test from "node:test";
import { nextActiveTools } from "./availability.ts";

const NAMES = ["oracle", "subagent"];

test("adds the named tool when it is available and absent", () => {
	for (const name of NAMES) {
		assert.deepEqual(nextActiveTools(name, true, ["read", "bash"]), ["read", "bash", name]);
	}
});

test("removes the named tool when it is unavailable and present", () => {
	for (const name of NAMES) {
		assert.deepEqual(nextActiveTools(name, false, ["read", name, "bash"]), ["read", "bash"]);
	}
});

test("returns undefined when the list is already correct", () => {
	for (const name of NAMES) {
		assert.equal(nextActiveTools(name, true, ["read", name]), undefined);
		assert.equal(nextActiveTools(name, false, ["read", "bash"]), undefined);
	}
});

test("preserves every other tool, in order, in both directions", () => {
	// setActiveTools replaces the whole list, so deriving the result from
	// anywhere but `current` would clobber another extension's toggling.
	for (const name of NAMES) {
		const others = ["read", "grep", "find", "ls", "bash"];
		assert.deepEqual(nextActiveTools(name, true, others)?.slice(0, -1), others);
		assert.deepEqual(nextActiveTools(name, false, [...others, name]), others);
	}
});

test("touches only the named tool when both are present", () => {
	assert.deepEqual(nextActiveTools("oracle", false, ["subagent", "oracle"]), ["subagent"]);
	assert.deepEqual(nextActiveTools("subagent", false, ["subagent", "oracle"]), ["oracle"]);
});

test("an empty list is handled in both directions", () => {
	for (const name of NAMES) {
		assert.deepEqual(nextActiveTools(name, true, []), [name]);
		assert.equal(nextActiveTools(name, false, []), undefined);
	}
});
