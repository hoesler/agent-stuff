import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resolveModelReference, resolveRoute } from "./routes.ts";

type Resolver = (key: string) => string | undefined;
const global = globalThis as { __piModelRouteResolvers?: Set<Resolver> };

function publish(...fns: Resolver[]): void {
	global.__piModelRouteResolvers = new Set(fns);
}

afterEach(() => {
	delete global.__piModelRouteResolvers;
});

test("a value containing a slash is a model reference and bypasses lookup", () => {
	publish(() => {
		throw new Error("must not be consulted");
	});
	assert.equal(resolveModelReference("anthropic/claude-fable-5:high"), "anthropic/claude-fable-5:high");
});

test("a bare value resolves through a publisher", () => {
	publish((key) => (key === "oracle" ? "anthropic/claude-fable-5:high" : undefined));
	assert.equal(resolveModelReference("oracle"), "anthropic/claude-fable-5:high");
});

test("an unresolved bare value passes through unchanged", () => {
	publish(() => undefined);
	assert.equal(resolveModelReference("oracle"), "oracle");
});

test("no publisher registered is a no-op", () => {
	assert.equal(resolveModelReference("oracle"), "oracle");
	assert.equal(resolveRoute("oracle"), undefined);
});

test("undefined stays undefined", () => {
	assert.equal(resolveModelReference(undefined), undefined);
});

test("a throwing publisher is skipped", () => {
	publish(
		() => {
			throw new Error("boom");
		},
		() => "anthropic/claude-fable-5:high",
	);
	assert.equal(resolveRoute("oracle"), "anthropic/claude-fable-5:high");
});

test("the first non-empty answer wins", () => {
	publish(
		() => undefined,
		() => "first",
		() => "second",
	);
	assert.equal(resolveRoute("oracle"), "first");
});
