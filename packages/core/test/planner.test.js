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
		quick: { chain: ["opencode-go/small", "openrouter/small"], thinking: "low", skills: ["core"], preload: ["core"] },
		standard: { chain: ["anthropic/sonnet", "xai/grok"], skills: ["core", "design"], preload: ["core"] },
		premium: { chain: ["anthropic/opus"], thinking: "high" },
	},
	skillGroups: {
		core: ["shiftwork"],
		design: ["design-system"],
		git: ["git-skills"],
	},
	skillSources: {
		shiftwork: "/skills/shiftwork",
		"design-system": "/skills/design-system",
		"git-skills": "/skills/git",
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

test("planShift: tier skills resolve to paths and preload is a subset", () => {
	const route = planShift({ ticket: t({ type: "code" }), config });
	assert.deepEqual(route.skills.paths, ["/skills/shiftwork", "/skills/design-system"]);
	assert.deepEqual(route.skills.preload, ["/skills/shiftwork"]);
});

test("planShift: ticket +group adds a skill group", () => {
	const route = planShift({ ticket: t({ type: "code", skills: ["+git"] }), config });
	assert.deepEqual(route.skills.paths, ["/skills/shiftwork", "/skills/design-system", "/skills/git"]);
});

test("planShift: ticket -group removes a skill group", () => {
	const route = planShift({ ticket: t({ type: "code", skills: ["-design"] }), config });
	assert.deepEqual(route.skills.paths, ["/skills/shiftwork"]);
	assert.deepEqual(route.skills.preload, ["/skills/shiftwork"]);
});

test("planShift: an unknown skill group on the ticket throws", () => {
	assert.throws(() => planShift({ ticket: t({ type: "code", skills: ["+unknown"] }), config }), /unknown skill group "unknown"/);
});

test("planShift: an unknown skill source in a group produces a warning", () => {
	const cfg = validateConfig({
		model: "fake/m1",
		thinking: "low",
		routing: { quick: { tier: "quick" } },
		tiers: { quick: { chain: ["fake/m1"], skills: ["g"] } },
		skillGroups: { g: ["missing"] },
		skillSources: {},
	});
	const route = planShift({ ticket: t({ type: "quick" }), config: cfg });
	assert.deepEqual(route.skills.paths, []);
	assert.match(route.skills.warnings.join(","), /unknown skill source "missing" in group "g"/);
});

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
	[{ model: "fake/m1", tiers: { quick: { chain: ["fake/m1"], skills: ["missing"] } } }, /tiers\.quick\.skills: unknown skill group "missing"/],

	[{ model: "fake/m1", tiers: { quick: { chain: ["fake/m1"], skills: ["g"], preload: ["other"] } }, skillGroups: { g: [], other: [] } }, /tiers\.quick\.preload: preload group "other" is not in tier skills/],
];

for (const [input, message] of invalid) {
	test(`validateConfig rejects ${message.source}`, () => assert.throws(() => validateConfig(input), message));
}

test("planShift: without skill config the shift isn't restricted, so backend discovery stays", () => {
	const route = planShift({ ticket: t(), config: validateConfig({ model: "a/b" }) });
	assert.equal(route.skills.restricted, false);
	assert.deepEqual(route.skills.paths, []);
});

const budgetConfig = validateConfig({
	model: "fake/m1",
	thinking: "low",
	routing: { code: { tier: "standard" } },
	tiers: {
		standard: { chain: ["fake/m1", "fake/m2"], budget: { maxTurns: 10, maxCostUsd: 2 } },
	},
	budgets: {
		default: { maxTurns: 20 },
		models: { "fake/m1": { maxCostUsd: 1 } },
		ticket: { maxCostUsd: 5 },
	},
	onExceed: { maxTurns: { to: "next", mode: "new-process" } },
});

test("planShift: budgets merge model over tier over default", () => {
	const route = planShift({ ticket: t({ type: "code" }), config: budgetConfig });
	assert.equal(route.budget.maxTurns, 10); // tier wins over default
	assert.equal(route.budget.maxCostUsd, 1); // model wins over tier
});

test("planShift: ticket Budget line caps the shift budget", () => {
	const route = planShift({ ticket: t({ type: "code", budget: "$0.5 · 5 turns" }), config: budgetConfig });
	assert.equal(route.budget.maxCostUsd, 0.5);
	assert.equal(route.budget.maxTurns, 5);
});

test("planShift: a handoff picks the next model in the chain", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: budgetConfig });
	const second = planShift({
		ticket: t({ type: "code" }),
		config: budgetConfig,
		history: { previousRoute: first, exceededKind: "maxTurns", ticketUsage: { maxTurns: 10 } },
	});
	assert.equal(second.model, "fake/m2");
	assert.equal(second.budget.maxTurns, 10); // new model has no override, tier budget applies
});

test("planShift: after a handoff, the remaining ticket budget caps the shift budget but never raises it", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: budgetConfig });
	const plenty = planShift({
		ticket: t({ type: "code" }),
		config: budgetConfig,
		history: { previousRoute: first, exceededKind: "maxTurns", ticketUsage: { maxCostUsd: 1 } },
	});
	const little = planShift({
		ticket: t({ type: "code" }),
		config: budgetConfig,
		history: { previousRoute: first, exceededKind: "maxTurns", ticketUsage: { maxCostUsd: 4.5 } },
	});
	assert.equal(plenty.budget.maxCostUsd, 2, "tier budget $2 stays when $4 of the ticket budget is left");
	assert.equal(little.budget.maxCostUsd, 0.5, "only $0.5 of the ticket budget is left");
});
