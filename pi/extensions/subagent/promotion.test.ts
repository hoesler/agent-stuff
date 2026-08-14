import assert from "node:assert/strict";
import test from "node:test";
import { formatPromotedGuidance } from "./promotion.ts";

const resolves = (key: string) => (key === "oracle" ? "anthropic/claude-fable-5:high" : undefined);
const resolvesNothing = () => undefined;

test("appends one section per promoted persona under a single heading", () => {
	const guidance = formatPromotedGuidance(
		[
			{ name: "advisor", promotedPrompt: "Ask it about hard bugs." },
			{ name: "planner", promotedPrompt: "Ask it to plan." },
		],
		resolvesNothing,
	);
	assert.equal(
		guidance,
		"## Subagent guidance (subagent extension)\n\n### advisor\n\nAsk it about hard bugs.\n\n### planner\n\nAsk it to plan.",
	);
});

test("returns undefined when nothing is promotable, so no heading is emitted", () => {
	assert.equal(formatPromotedGuidance([{ name: "advisor" }], resolves), undefined);
	assert.equal(formatPromotedGuidance([], resolves), undefined);
});

test("promotes a bare-key persona when the key resolves", () => {
	const guidance = formatPromotedGuidance([{ name: "advisor", model: "oracle", promotedPrompt: "Ask it." }], resolves);
	assert.match(guidance!, /### advisor/);
});

test("skips a bare-key persona when the key does not resolve", () => {
	assert.equal(
		formatPromotedGuidance([{ name: "advisor", model: "oracle", promotedPrompt: "Ask it." }], resolvesNothing),
		undefined,
	);
});

test("promotes a persona with a literal model or none, regardless of routes", () => {
	assert.match(
		formatPromotedGuidance(
			[{ name: "advisor", model: "anthropic/claude-fable-5:high", promotedPrompt: "Ask it." }],
			resolvesNothing,
		)!,
		/### advisor/,
	);
	assert.match(formatPromotedGuidance([{ name: "advisor", promotedPrompt: "Ask it." }], resolvesNothing)!, /### advisor/);
});

test("skips only the unroutable persona, keeping its promotable neighbours", () => {
	const guidance = formatPromotedGuidance(
		[
			{ name: "advisor", model: "oracle", promotedPrompt: "Ask it." },
			{ name: "planner", promotedPrompt: "Ask it to plan." },
		],
		resolvesNothing,
	);
	assert.equal(guidance, "## Subagent guidance (subagent extension)\n\n### planner\n\nAsk it to plan.");
});

test("never leaks a resolved model string into the prompt", () => {
	const guidance = formatPromotedGuidance([{ name: "advisor", model: "oracle", promotedPrompt: "Ask it." }], resolves);
	assert.doesNotMatch(guidance!, /claude-fable-5/);
});
