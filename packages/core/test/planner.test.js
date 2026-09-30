import assert from "node:assert/strict";
import { test } from "node:test";
import { planShift, validateConfig } from "../src/index.js";

const config = validateConfig({
	defaultType: "code",
	thinking: "medium",
	routing: {
		git: { tier: "quick", thinking: "low" },
		code: { tier: "standard" },
		docs: { model: "openrouter/cheap-docs", thinking: "minimal" },
	},
	tiers: {
		quick: { chain: ["opencode-go/small", "openrouter/small"], thinking: "low" },
		standard: { chain: ["anthropic/sonnet", "xai/grok"] },
		premium: { chain: ["anthropic/opus"], thinking: "high" },
	},
});

const t = (fields = {}) => ({ number: "01", feature: "f", verify: [], skills: [], ...fields });

const cases = [
	["the ticket's Model wins over routing", t({ type: "git", model: "xai/pinned" }), { model: "xai/pinned", thinking: "low", tier: "quick", type: "git" }],
	["a Type routes to its tier's first chain model", t({ type: "git" }), { model: "opencode-go/small", thinking: "low", tier: "quick", type: "git" }],
	["tier thinking is used when routing has none", t({ type: "code" }), { model: "anthropic/sonnet", thinking: "medium", tier: "standard", type: "code" }],
	["a routing model skips tiers", t({ type: "docs" }), { model: "openrouter/cheap-docs", thinking: "minimal", tier: undefined, type: "docs" }],
	["no Type falls back to defaultType", t(), { model: "anthropic/sonnet", thinking: "medium", tier: "standard", type: "code" }],
	["an unknown Type falls back to defaultType", t({ type: "poetry" }), { model: "anthropic/sonnet", thinking: "medium", tier: "standard", type: "code" }],
];

for (const [name, ticket, expected] of cases) {
	test(`planShift: ${name}`, () => {
		const route = planShift({ ticket, config });
		assert.deepEqual({ model: route.model, thinking: route.thinking, tier: route.tier, type: route.type }, expected);
		assert.equal(route.backend, "pi");
	});
}

test("planShift: a legacy top-level model is the default route", () => {
	const route = planShift({ ticket: t(), config: validateConfig({ model: "fake/m1", thinking: "low" }) });
	assert.deepEqual([route.model, route.thinking], ["fake/m1", "low"]);
});

const invalid = [
	[{ routing: { git: { tier: "fast" } }, tiers: {} }, /routing\.git\.tier: unknown tier "fast"/],
	[{ tiers: { quick: { chain: [] } } }, /tiers\.quick\.chain: must be a non-empty array/],
	[{ tiers: { quick: { chain: ["no-slash"] } } }, /tiers\.quick\.chain\[0\]: expected "provider\/model"/],
	[{ model: "CHANGE-ME/model" }, /model: replace the CHANGE-ME placeholder/],
	[{ thinking: "huge" }, /thinking: must be one of off, minimal, low, medium, high, xhigh, max/],
	[{ maxAttempts: 0 }, /maxAttempts: must be a positive integer/],
	[{ defaultType: "code", routing: {} , model: undefined, tiers: undefined }, /no route for type "code"/],
];

for (const [input, message] of invalid) {
	test(`validateConfig rejects ${message.source}`, () => assert.throws(() => validateConfig(input), message));
}
