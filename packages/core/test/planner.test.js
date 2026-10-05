import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseHandoffMode, parseModelRef, planShift, resolveTicketBudget, skillsForModel, validateConfig } from "../src/index.js";

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

test("planShift: classified type is used for an untyped ticket", () => {
	const route = planShift({ ticket: t(), config, classification: { type: "git", complexity: "standard" } });
	assert.deepEqual({ model: route.model, thinking: route.thinking, tier: route.tier, type: route.type, typeSource: route.typeSource }, {
		model: "opencode-go/small",
		thinking: "low",
		tier: "quick",
		type: "git",
		typeSource: "jev",
	});
});

test("planShift: complexity=complex raises the classified type's tier by one", () => {
	const route = planShift({ ticket: t(), config, classification: { type: "git", complexity: "complex" } });
	assert.equal(route.type, "git");
	assert.equal(route.typeSource, "jev");
	assert.equal(route.tier, "standard");
	assert.equal(route.model, "anthropic/sonnet");
});

test("planShift: complexity=complex on a standard type raises to premium", () => {
	const route = planShift({ ticket: t(), config, classification: { type: "code", complexity: "complex" } });
	assert.equal(route.type, "code");
	assert.equal(route.tier, "premium");
	assert.equal(route.model, "anthropic/opus");
});

test("planShift: a ticket Type wins over classification and is not raised", () => {
	const route = planShift({
		ticket: t({ type: "git" }),
		config,
		classification: { type: "code", complexity: "complex" },
	});
	assert.equal(route.type, "git");
	assert.equal(route.typeSource, "ticket");
	assert.equal(route.tier, "quick");
});

test("planShift: a null classification uses defaultType", () => {
	const route = planShift({ ticket: t(), config, classification: null });
	assert.equal(route.type, "code");
	assert.equal(route.typeSource, "default");
	assert.equal(route.tier, "standard");
});

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
	[{ model: "fake/m1", jev: { model: "no-slash" } }, /jev\.model: expected "provider\/model"/],
	[{ model: "fake/m1", allowInPlace: "yes" }, /allowInPlace: must be true or false/],
	[{ model: "fake/m1", models: "nope" }, /models: must be an object/],
	[{ model: "fake/m1", models: { "fake/m1": { thinking: "huge" } } }, /models\.fake\/m1\.thinking: must be one of/],
	[{ model: "fake/m1", models: { "fake/m1": { contextWindow: 0 } } }, /models\.fake\/m1\.contextWindow: must be a positive finite number/],
	[{ model: "fake/m1", models: { "fake/m1": { budget: { nope: 1 } } } }, /models\.fake\/m1\.budget\.nope: unknown budget field/],
	[{ model: "fake/m1", models: { "fake/m1": { extra: 1 } } }, /models\.fake\/m1\.extra: unknown profile field/],
];

for (const [input, message] of invalid) {
	test(`validateConfig rejects ${message.source}`, () => assert.throws(() => validateConfig(input), message));
}

test("planShift: without skill config the shift isn't restricted, so backend discovery stays", () => {
	const route = planShift({ ticket: t(), config: validateConfig({ model: "a/b" }) });
	assert.equal(route.skills.restricted, false);
	assert.deepEqual(route.skills.paths, []);
});

test("skillsForModel: a model in a tier gets that tier's skill paths", () => {
	const { tier, skills } = skillsForModel("anthropic/sonnet", config);
	assert.equal(tier, "standard");
	assert.deepEqual(skills.paths, ["/skills/shiftwork", "/skills/design-system"]);
	assert.equal(skills.restricted, true);
});

test("skillsForModel: a model without a tier is unrestricted", () => {
	const { tier, skills } = skillsForModel("openrouter/unknown", config);
	assert.equal(tier, undefined);
	assert.equal(skills.restricted, false);
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

test("planShift: budgets merge default → tier → budgets.models → models.budget", () => {
	const cfg = validateConfig({
		model: "fake/m1",
		thinking: "low",
		routing: { code: { tier: "standard" } },
		tiers: {
			standard: { chain: ["fake/m1"], budget: { maxTurns: 10, maxCostUsd: 2, maxTokens: 1000 } },
		},
		budgets: {
			default: { maxTurns: 20, maxCostUsd: 5, maxTokens: 5000, maxWallMin: 45 },
			models: { "fake/m1": { maxCostUsd: 1, maxTokens: 800 } },
		},
		models: {
			"fake/m1": { budget: { maxCostUsd: 0.25 } },
		},
	});
	const route = planShift({ ticket: t({ type: "code" }), config: cfg });
	assert.equal(route.budget.maxTurns, 10, "tier wins over default");
	assert.equal(route.budget.maxTokens, 800, "legacy budgets.models wins over tier");
	assert.equal(route.budget.maxCostUsd, 0.25, "models.budget wins over legacy budgets.models");
	assert.equal(route.budget.maxWallMin, 45, "default remains when nothing overrides it");
});

test("planShift: models.budget is still capped by the ticket Budget line", () => {
	const cfg = validateConfig({
		model: "fake/m1",
		thinking: "low",
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], budget: { maxCostUsd: 2, maxTurns: 10 } } },
		models: { "fake/m1": { budget: { maxCostUsd: 1, maxTurns: 8 } } },
	});
	const route = planShift({ ticket: t({ type: "code", budget: "$0.5 · 5 turns" }), config: cfg });
	assert.equal(route.budget.maxCostUsd, 0.5);
	assert.equal(route.budget.maxTurns, 5);
});

test("planShift: a model without a profile keeps default and tier budgets", () => {
	const cfg = validateConfig({
		model: "fake/m2",
		thinking: "low",
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m2"], budget: { maxTurns: 10 } } },
		budgets: { default: { maxWallMin: 45 }, models: { "fake/m1": { maxCostUsd: 1 } } },
		models: { "fake/m1": { budget: { maxCostUsd: 0.25 } } },
	});
	const route = planShift({ ticket: t({ type: "code" }), config: cfg });
	assert.equal(route.budget.maxTurns, 10);
	assert.equal(route.budget.maxWallMin, 45);
	assert.equal(route.budget.maxCostUsd, undefined);
});

test("planShift: profile thinking wins over the tier's", () => {
	const cfg = validateConfig({
		model: "fake/m1",
		thinking: "low",
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "high" } },
		models: { "fake/m1": { thinking: "max" } },
	});
	const route = planShift({ ticket: t({ type: "code" }), config: cfg });
	assert.equal(route.thinking, "max");
});

test("planShift: profile contextWindow is on the route", () => {
	const cfg = validateConfig({
		model: "fake/m1",
		thinking: "low",
		models: { "fake/m1": { contextWindow: 32000 } },
	});
	const route = planShift({ ticket: t(), config: cfg });
	assert.equal(route.contextWindow, 32000);
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

const FRESH = { mode: "new-process", compact: false };
const HANDOFF_KINDS = ["maxTokens", "maxCostUsd", "maxTurns", "maxWallMin", "maxContextPct", "stallTurns", "verifyFailed"];
const HANDOFF_MODES = ["same-process", "new-process", "auto", undefined];
const capable = { inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 };

const autoCases = [
	["explicit same-process stays in place", { mode: "same-process", kind: "maxTurns", allowInPlace: true, inPlaceHandoff: true }, { mode: "same-process", compact: false }],
	["explicit same-process without capability is fresh", { mode: "same-process", kind: "maxTurns", allowInPlace: true, inPlaceHandoff: false }, FRESH],
	["explicit new-process is always fresh", { mode: "new-process", kind: "maxCostUsd", allowInPlace: true, inPlaceHandoff: true }, FRESH],
	["explicit same-process with a smaller window still stays, but compacting first", { mode: "same-process", kind: "maxCostUsd", allowInPlace: true, inPlaceHandoff: true, contextTokens: 9000, targetContextWindow: 8000 }, { mode: "same-process", compact: true }],
	["auto + cost + room in the window is in-place", { mode: "auto", kind: "maxCostUsd", allowInPlace: true, inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 }, { mode: "same-process", compact: false }],
	["auto + tokens + room in the window is in-place", { mode: "auto", kind: "maxTokens", allowInPlace: true, inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 }, { mode: "same-process", compact: false }],
	["auto + turns with unknown windows is in-place", { mode: "auto", kind: "maxTurns", allowInPlace: true, inPlaceHandoff: true }, { mode: "same-process", compact: false }],
	["auto + turns when the target window is too small is fresh", { mode: "auto", kind: "maxTurns", allowInPlace: true, inPlaceHandoff: true, contextTokens: 9000, targetContextWindow: 8000 }, FRESH],
	["auto + context fill is fresh", { mode: "auto", kind: "maxContextPct", allowInPlace: true, inPlaceHandoff: true, contextTokens: 1000, targetContextWindow: 8000 }, FRESH],
	["auto + stall is fresh", { mode: "auto", kind: "stallTurns", allowInPlace: true, inPlaceHandoff: true }, FRESH],
	["auto + wall time is fresh", { mode: "auto", kind: "maxWallMin", allowInPlace: true, inPlaceHandoff: true }, FRESH],
	["auto without capability is fresh", { mode: "auto", kind: "maxTurns", allowInPlace: true, inPlaceHandoff: false }, FRESH],
	["missing mode is fresh", { kind: "maxTurns", allowInPlace: true, inPlaceHandoff: true }, FRESH],
];

for (const [name, input, expected] of autoCases) {
	test(`chooseHandoffMode: ${name}`, () => {
		assert.deepEqual(chooseHandoffMode(input), expected);
	});
}

for (const kind of HANDOFF_KINDS) {
	for (const mode of HANDOFF_MODES) {
		const label = mode ?? "missing";
		test(`chooseHandoffMode: without allowInPlace, ${label} + ${kind} is fresh`, () => {
			assert.deepEqual(chooseHandoffMode({ mode, kind, ...capable }), FRESH);
		});
	}
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

test("planShift: a paid provider is used only when no subscription provider frees up within preferWaitMin", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["sub/a", "paid/b"] } },
		paidProviders: ["paid"],
		preferWaitMin: 30,
	});
	const now = new Date("2026-01-01T00:00:00Z");
	const soon = [{ provider: "sub", until: "2026-01-01T00:05:00Z", kind: "server" }];
	const late = [{ provider: "sub", until: "2026-01-01T05:00:00Z", kind: "usage" }];

	const waiting = planShift({ ticket: t({ type: "code" }), config: cfg, cooldowns: soon, now });
	const paying = planShift({ ticket: t({ type: "code" }), config: cfg, cooldowns: late, now });

	assert.equal(new Date(waiting.wait).toISOString(), "2026-01-01T00:05:00.000Z", "a 5-minute server cooldown is waited out");
	assert.equal(paying.model, "paid/b", "a 5-hour usage limit falls through to the paid provider");
});

test("planShift: thinking order is ticket type routing → model profile → tier → global", () => {
	const cfg = validateConfig({
		thinking: "medium",
		routing: { git: { tier: "std", thinking: "low" }, code: { tier: "std" } },
		tiers: { std: { chain: ["p/m1"], thinking: "minimal" } },
		models: { "p/m1": { thinking: "high" } },
	});
	assert.equal(planShift({ ticket: t({ type: "git" }), config: cfg }).thinking, "low", "the git type asks for low");
	assert.equal(planShift({ ticket: t({ type: "code" }), config: cfg }).thinking, "high", "the model profile beats the tier");
});

const refCases = [
	["pi provider/model", "anthropic/sonnet", { backend: "pi", model: "anthropic/sonnet", provider: "anthropic" }],
	["claude prefix", "claude:sonnet", { backend: "claude", model: "sonnet", provider: "claude" }],
	["codex prefix", "codex:gpt-5.6-terra", { backend: "codex", model: "gpt-5.6-terra", provider: "codex" }],
	["opencode prefix with slash", "opencode:opencode-go/kimi-k3", { backend: "opencode", model: "opencode-go/kimi-k3", provider: "opencode:opencode-go" }],
	["grok prefix", "grok:grok-4.7", { backend: "grok", model: "grok-4.7", provider: "grok" }],
	["cursor prefix", "cursor:claude-sonnet-4", { backend: "cursor", model: "claude-sonnet-4", provider: "cursor" }],
	["empty ref", "", { backend: "pi", model: "", provider: "" }],
];

for (const [name, ref, expected] of refCases) {
	test(`parseModelRef: ${name}`, () => {
		assert.deepEqual(parseModelRef(ref), expected);
	});
}

test("planShift: a claude model ref sets backend and provider", () => {
	const cfg = validateConfig({
		thinking: "low",
		routing: { code: { model: "claude:sonnet" } },
	});
	const route = planShift({ ticket: t({ type: "code" }), config: cfg });
	assert.equal(route.backend, "claude");
	assert.equal(route.model, "sonnet");
	assert.equal(route.provider, "claude");
});

test("planShift: a cooled cli backend is skipped", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["claude:sonnet", "anthropic/sonnet"] } },
	});
	const route = planShift({
		ticket: t({ type: "code" }),
		config: cfg,
		cooldowns: [{ provider: "claude", until: "2099-01-01T00:00:00Z", kind: "usage" }],
	});
	assert.equal(route.backend, "pi");
	assert.equal(route.model, "anthropic/sonnet");
	assert.equal(route.provider, "anthropic");
});

test("planShift: an ollama model is never paid, even when its provider is listed as paid", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "quick" } },
		tiers: { quick: { chain: ["sub/a", "ollama/llama3.2:latest"] } },
		paidProviders: ["ollama"],
		preferWaitMin: 30,
	});
	const now = new Date("2026-01-01T00:00:00Z");
	const soon = [{ provider: "sub", until: "2026-01-01T00:05:00Z", kind: "server" }];
	const plan = planShift({ ticket: t({ type: "code" }), config: cfg, cooldowns: soon, now });
	assert.equal(plan.model, "ollama/llama3.2:latest", "local models are used instead of waiting for a subscription model");
	assert.ok(!plan.wait);
});

test("planShift: a ':free' model of a paid provider is used without waiting", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "quick" } },
		tiers: { quick: { chain: ["sub/a", "paid/model:free"] } },
		paidProviders: ["paid"],
		preferWaitMin: 30,
	});
	const now = new Date("2026-01-01T00:00:00Z");
	const soon = [{ provider: "sub", until: "2026-01-01T00:05:00Z", kind: "server" }];
	assert.equal(planShift({ ticket: t({ type: "code" }), config: cfg, cooldowns: soon, now }).model, "paid/model:free");
});

test("planShift: a free model's cooldown skips only that model; a provider-wide cooldown still covers free models", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "quick" } },
		tiers: { quick: { chain: ["or/a:free", "or/b:free", "or/paid"] } },
	});
	const now = new Date("2026-01-01T00:00:00Z");
	const oneModel = [{ provider: "or/a:free", until: "2026-01-01T01:00:00Z", kind: "rate" }];
	const wholeProvider = [{ provider: "or", until: "2026-01-01T01:00:00Z", kind: "usage" }];

	assert.equal(planShift({ ticket: t({ type: "code" }), config: cfg, cooldowns: oneModel, now }).model, "or/b:free");
	assert.ok(planShift({ ticket: t({ type: "code" }), config: cfg, cooldowns: wholeProvider, now }).wait);
});

test("Budget lines understand k/M token and h time shorthands, and Ukrainian units", () => {
	const cases = {
		"$2 · 200k tokens · 1h": { maxCostUsd: 2, maxTokens: 200_000, maxWallMin: 60 },
		"1.5M tokens": { maxTokens: 1_500_000 },
		"200000 tokens": { maxTokens: 200_000 },
		"1h 30min": { maxWallMin: 90 },
		"1h30m": { maxWallMin: 90 },
		"1.5h": { maxWallMin: 90 },
		"2 hours": { maxWallMin: 120 },
		"45m · 50 turns": { maxWallMin: 45, maxTurns: 50 },
		"30 хв": { maxWallMin: 30 },
		"1 год 15 хв": { maxWallMin: 75 },
		"10 ходів": { maxTurns: 10 },
		"$1.5 · 40 turns · 60% context · 5 stall": { maxCostUsd: 1.5, maxTurns: 40, maxContextPct: 60, stallTurns: 5 },
	};
	for (const [line, expected] of Object.entries(cases)) {
		assert.deepEqual(resolveTicketBudget({ budget: line }, {}), expected, line);
	}
});

test("planShift: a provider at its concurrency cap is skipped for the next chain model", () => {
	const route = planShift({ ticket: t({ type: "code" }), config, fullProviders: ["anthropic"] });
	assert.deepEqual({ model: route.model, tier: route.tier }, { model: "xai/grok", tier: "standard" });
});

test("planShift: a full provider writes no cooldown and an all-full chain waits to re-plan", () => {
	const now = new Date("2026-01-01T00:00:00Z");
	const chain = planShift({ ticket: t({ type: "code" }), config, fullProviders: ["anthropic", "xai"], now });
	assert.equal(chain.wait?.getTime(), now.getTime() + 60_000, "no end time is known: re-plan after a minute");
	const pinned = planShift({ ticket: t({ type: "docs" }), config, fullProviders: ["openrouter"], now });
	assert.equal(pinned.wait?.getTime(), now.getTime() + 60_000, "a pinned model on a full provider waits too");
});

const cliConfig = validateConfig({
	routing: { code: { tier: "standard" } },
	tiers: {
		standard: { chain: ["claude:sonnet", "codex:gpt-5", "fake/m2"] },
		premium: { chain: ["claude:opus"] },
	},
	onExceed: {
		maxTurns: { to: "next", mode: "new-process" },
		maxContextPct: { to: "same-tier", mode: "new-process" },
		stallTurns: { to: "same-tier", mode: "new-process" },
	},
});

test("planShift: a route carries the full model ref, backend prefix included", () => {
	const route = planShift({ ticket: t({ type: "code" }), config: cliConfig });
	assert.equal(route.backend, "claude");
	assert.equal(route.model, "sonnet");
	assert.equal(route.ref, "claude:sonnet");
	assert.equal(planShift({ ticket: t({ type: "code" }), config: budgetConfig }).ref, "fake/m1");
});

test("planShift: `next` and `same-tier` handoffs move along a chain of CLI models", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: cliConfig });
	const next = planShift({ ticket: t({ type: "code" }), config: cliConfig, history: { previousRoute: first, exceededKind: "maxTurns" } });
	assert.equal(next.ref, "codex:gpt-5");
	const sameTier = planShift({ ticket: t({ type: "code" }), config: cliConfig, history: { previousRoute: next, exceededKind: "maxContextPct" } });
	assert.equal(sameTier.ref, "fake/m2");
});

test("planShift: a stalled CLI model is not chosen again", () => {
	const first = planShift({ ticket: t({ type: "code" }), config: cliConfig });
	const plan = planShift({
		ticket: t({ type: "code" }),
		config: cliConfig,
		history: { previousRoute: first, exceededKind: "stallTurns", blockedModels: [first.ref, "codex:gpt-5"] },
	});
	assert.equal(plan.ref, "fake/m2");
	const fresh = planShift({ ticket: t({ type: "code" }), config: cliConfig, history: { blockedModels: [first.ref] } });
	assert.equal(fresh.ref, "codex:gpt-5");
});

const limitedConfig = (extra = {}) =>
	validateConfig({
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], budget: { maxTurns: 10, maxTokens: 1000 } } },
		budgets: { default: { maxWallMin: 45, stallTurns: 5 }, ticket: { maxCostUsd: 8 } },
		models: { "fake/m1": { budget: { maxContextPct: 70 } } },
		...extra,
	});

test("unlimited: true lifts every shift and ticket limit, including the ticket's Budget line", () => {
	const ticket = t({ type: "code", budget: "$2 · 50 turns" });
	const cfg = limitedConfig({ unlimited: true });
	assert.deepEqual(planShift({ ticket, config: cfg }).budget, {});
	assert.deepEqual(resolveTicketBudget(ticket, cfg), {});
});

test("unlimited as a list lifts only those limits, by short or full name", () => {
	const ticket = t({ type: "code", budget: "200k tokens · 1h" });
	const cfg = limitedConfig({ unlimited: ["tokens", "maxWallMin"] });
	const budget = planShift({ ticket, config: cfg }).budget;
	assert.equal(budget.maxTokens, undefined);
	assert.equal(budget.maxWallMin, undefined);
	assert.equal(budget.maxTurns, 10);
	assert.equal(budget.stallTurns, 5);
	assert.equal(budget.maxContextPct, 70);
	assert.deepEqual(resolveTicketBudget(ticket, cfg), { maxCostUsd: 8 });
});

test("unlimited rejects unknown limit names", () => {
	assert.throws(() => limitedConfig({ unlimited: ["tokens", "speed"] }), /unlimited.*speed/);
	assert.throws(() => limitedConfig({ unlimited: "yes" }), /unlimited/);
});

test("tier unlimited lifts only that tier's shift limits", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "free" }, docs: { tier: "standard" } },
		tiers: {
			free: { chain: ["fake/m1"], budget: { maxTurns: 10, maxTokens: 1000 }, unlimited: ["turns", "time"] },
			standard: { chain: ["fake/m1"], budget: { maxTurns: 10, maxTokens: 1000 } },
		},
		budgets: { default: { maxWallMin: 45, stallTurns: 5 }, ticket: { maxCostUsd: 8 } },
		models: { "fake/m1": { budget: { maxContextPct: 70 } } },
	});
	assert.deepEqual(planShift({ ticket: t({ type: "code" }), config: cfg }).budget, {
		maxTokens: 1000,
		stallTurns: 5,
		maxContextPct: 70,
		maxCostUsd: 8,
	});
	assert.deepEqual(planShift({ ticket: t({ type: "docs" }), config: cfg }).budget, {
		maxTurns: 10,
		maxTokens: 1000,
		maxWallMin: 45,
		stallTurns: 5,
		maxContextPct: 70,
		maxCostUsd: 8,
	});
});

test("a model profile's unlimited: true lifts every limit for that model only", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], budget: { maxTurns: 10, maxTokens: 1000 } } },
		budgets: { default: { maxWallMin: 45, stallTurns: 5 }, ticket: { maxCostUsd: 8 } },
		models: { "fake/m2": { budget: { maxContextPct: 70 }, unlimited: true } },
	});
	const lifted = planShift({ ticket: t({ type: "code", model: "fake/m2" }), config: cfg }).budget;
	assert.deepEqual(lifted, {}, "the ticket budget is lifted too");
	const capped = planShift({ ticket: t({ type: "code" }), config: cfg }).budget;
	assert.deepEqual(capped, { maxTurns: 10, maxTokens: 1000, maxWallMin: 45, stallTurns: 5, maxCostUsd: 8 });
});

test("shift limits lifted are the union of the top-level, tier and profile lists", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "standard" } },
		unlimited: ["turns"],
		tiers: { standard: { chain: ["fake/m1"], budget: { maxTurns: 10, maxTokens: 1000 }, unlimited: ["time"] } },
		budgets: { default: { maxWallMin: 45, stallTurns: 5 } },
		models: { "fake/m1": { unlimited: ["stall"] } },
	});
	assert.deepEqual(planShift({ ticket: t({ type: "code" }), config: cfg }).budget, { maxTokens: 1000 });
});

test("tier unlimited lifts the ticket's Budget line too; another tier keeps it", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "free" }, docs: { tier: "standard" } },
		tiers: {
			free: { chain: ["fake/m1"], budget: { maxTurns: 10 }, unlimited: ["turns"] },
			standard: { chain: ["fake/m1"], budget: { maxTokens: 1000 } },
		},
	});
	const ticket = (type) => t({ type, budget: "50 turns" });
	assert.equal(planShift({ ticket: ticket("code"), config: cfg }).budget.maxTurns, undefined, "lifted on the unlimited tier");
	assert.equal(planShift({ ticket: ticket("docs"), config: cfg }).budget.maxTurns, 50, "the ticket's own budget still caps");
});

test("backends.claude.unlimited: true lifts every limit for claude models and for no pi model", () => {
	const cfg = validateConfig({
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "claude:sonnet"], budget: { maxTurns: 10, maxTokens: 1000 } } },
		budgets: { default: { maxWallMin: 45 }, ticket: { maxCostUsd: 8 } },
		backends: { claude: { unlimited: true } },
		models: { "fake/m1": { budget: { maxContextPct: 70 } } },
	});
	const claude = planShift({ ticket: t({ type: "code", model: "claude:sonnet", budget: "50 turns" }), config: cfg }).budget;
	assert.deepEqual(claude, {}, "the whole backend runs without limits, ticket budget included");
	const pi = planShift({ ticket: t({ type: "code", budget: "50 turns" }), config: cfg }).budget;
	assert.deepEqual(pi, { maxTurns: 10, maxTokens: 1000, maxWallMin: 45, maxCostUsd: 8, maxContextPct: 70 });
});

test("planShift: the remaining ticket budget caps every shift, not only rule-targeted handoffs", () => {
	const fresh = planShift({ ticket: t({ type: "code" }), config: budgetConfig, history: { ticketUsage: { maxCostUsd: 4.5 } } });
	assert.equal(fresh.budget.maxCostUsd, 0.5);
});
