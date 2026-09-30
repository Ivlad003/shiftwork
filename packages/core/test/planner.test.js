import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseHandoffMode, planShift, validateConfig } from "../src/index.js";

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

const autoCases = [
	["explicit same-process stays in place", { mode: "same-process", kind: "maxTurns", inPlaceHandoff: true }, { mode: "same-process", compact: false }],
	["explicit same-process without capability is fresh", { mode: "same-process", kind: "maxTurns", inPlaceHandoff: false }, { mode: "new-process", compact: false }],
	["explicit new-process is always fresh", { mode: "new-process", kind: "maxCostUsd", inPlaceHandoff: true }, { mode: "new-process", compact: false }],
	["explicit same-process with a smaller window still stays, but compacting first", { mode: "same-process", kind: "maxCostUsd", inPlaceHandoff: true, contextTokens: 9000, targetContextWindow: 8000 }, { mode: "same-process", compact: true }],
	["auto + cost + room in the window is in-place", { mode: "auto", kind: "maxCostUsd", inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 }, { mode: "same-process", compact: false }],
	["auto + tokens + room in the window is in-place", { mode: "auto", kind: "maxTokens", inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 }, { mode: "same-process", compact: false }],
	["auto + turns with unknown windows is in-place", { mode: "auto", kind: "maxTurns", inPlaceHandoff: true }, { mode: "same-process", compact: false }],
	["auto + turns when the target window is too small is fresh", { mode: "auto", kind: "maxTurns", inPlaceHandoff: true, contextTokens: 9000, targetContextWindow: 8000 }, { mode: "new-process", compact: false }],
	["auto + context fill is fresh", { mode: "auto", kind: "maxContextPct", inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 }, { mode: "new-process", compact: false }],
	["auto + stall is fresh", { mode: "auto", kind: "stallTurns", inPlaceHandoff: true }, { mode: "new-process", compact: false }],
	["auto + wall time is fresh", { mode: "auto", kind: "maxWallMin", inPlaceHandoff: true }, { mode: "new-process", compact: false }],
	["auto without capability is fresh", { mode: "auto", kind: "maxTurns", inPlaceHandoff: false }, { mode: "new-process", compact: false }],
	["missing mode is fresh", { kind: "maxTurns", inPlaceHandoff: true }, { mode: "new-process", compact: false }],
];

for (const [name, input, expected] of autoCases) {
	test(`chooseHandoffMode: ${name}`, () => {
		assert.deepEqual(chooseHandoffMode(input), expected);
	});
}

const far = "2099-01-01T00:00:00.000Z";
const t0 = new Date("2026-01-01T00:00:00Z");

test("planShift: skips a cooled-down provider in the chain", () => {
	const route = planShift({
		ticket: t({ type: "code" }),
		config,
		cooldowns: [{ provider: "anthropic", until: far, kind: "rate" }],
		now: t0,
	});
	assert.equal(route.model, "xai/grok");
	assert.equal(route.tier, "standard");
});

test("planShift: all-cooling with crossTier none waits for the earliest", () => {
	const plan = planShift({
		ticket: t({ type: "code" }),
		config: { ...config, crossTier: "none" },
		cooldowns: [
			{ provider: "anthropic", until: "2026-01-01T00:20:00Z", kind: "rate" },
			{ provider: "xai", until: "2026-01-01T00:10:00Z", kind: "usage" },
		],
		now: t0,
	});
	assert.equal(new Date(plan.wait).toISOString(), "2026-01-01T00:10:00.000Z");
	assert.equal(plan.model, undefined);
});

test("planShift: all-cooling with crossTier up moves to the neighbouring tier", () => {
	const cfg = {
		...config,
		crossTier: "up",
		tiers: { ...config.tiers, premium: { chain: ["openai/gpt"], thinking: "high" } },
	};
	const route = planShift({
		ticket: t({ type: "code" }),
		config: cfg,
		cooldowns: [
			{ provider: "anthropic", until: far, kind: "rate" },
			{ provider: "xai", until: far, kind: "rate" },
		],
		now: t0,
	});
	assert.equal(route.model, "openai/gpt");
	assert.equal(route.tier, "premium");
	assert.equal(route.thinking, "high");
});

test("planShift: a pinned Model whose provider is cooling waits", () => {
	const plan = planShift({
		ticket: t({ type: "code", model: "anthropic/sonnet" }),
		config,
		cooldowns: [{ provider: "anthropic", until: "2026-01-01T00:05:00Z", kind: "rate" }],
		now: t0,
	});
	assert.equal(new Date(plan.wait).toISOString(), "2026-01-01T00:05:00.000Z");
});

const stallConfig = validateConfig({
	defaultType: "code",
	thinking: "low",
	routing: { code: { tier: "standard" } },
	tiers: {
		standard: { chain: ["fake/m1", "fake/m2"], thinking: "low" },
		premium: { chain: ["fake/m3"], thinking: "high" },
	},
	onExceed: {
		stallTurns: { to: "escalate", mode: "new-process" },
		verifyFailed: { to: "escalate", mode: "new-process" },
		maxTurns: { to: "downgrade", mode: "new-process" },
	},
});

test("planShift: a stall escalates to the next tier", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: stallConfig });
	const second = planShift({
		ticket: t({ type: "code" }),
		config: stallConfig,
		history: { previousRoute: first, exceededKind: "stallTurns", blockedModels: [first.model] },
	});
	assert.equal(first.model, "fake/m1");
	assert.equal(second.model, "fake/m3");
	assert.equal(second.tier, "premium");
});

test("planShift: a stalled model is not chosen again for the ticket", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: stallConfig });
	const afterStall = planShift({
		ticket: t({ type: "code" }),
		config: stallConfig,
		history: { previousRoute: first, exceededKind: "stallTurns", blockedModels: ["fake/m1"] },
	});
	const later = planShift({
		ticket: t({ type: "code" }),
		config: stallConfig,
		history: {
			previousRoute: afterStall,
			exceededKind: "maxTurns",
			blockedModels: ["fake/m1"],
		},
	});
	assert.equal(afterStall.model, "fake/m3");
	assert.equal(later.model, "fake/m2", "downgrade skips the stalled model and takes the rest of the chain");
});

test("planShift: repeated verify failures escalate to the next tier", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: stallConfig });
	const second = planShift({
		ticket: t({ type: "code" }),
		config: stallConfig,
		history: { previousRoute: first, exceededKind: "verifyFailed", blockedModels: [first.model] },
	});
	assert.equal(second.model, "fake/m3");
	assert.equal(second.tier, "premium");
});

test("planShift: stops when every candidate has stalled", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: stallConfig });
	const plan = planShift({
		ticket: t({ type: "code" }),
		config: stallConfig,
		history: {
			previousRoute: { ...first, model: "fake/m3", tier: "premium" },
			exceededKind: "stallTurns",
			blockedModels: ["fake/m1", "fake/m2", "fake/m3"],
		},
	});
	assert.equal(plan.model, undefined);
	assert.match(plan.stop, /stalled/);
});
