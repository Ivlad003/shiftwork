import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCooldownDuration } from "./classify.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULTS = {
	defaultType: "code",
	thinking: "medium",
	maxAttempts: 3,
	maxHandoffs: 3,
	softLimitPct: 80,
	crossTier: "none",
	allowInPlace: false,
	cooldown: { rate: "15m", usage: "5h", quota: "24h", server: "5m" },
	skillGroups: {},
	skillSources: {},
	models: {},
	budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
	onExceed: {},
	jev: { enabled: true, model: "typesafe/jev-latest" },
};

/**
 * Load `.pi/shiftwork.json` merged over `<userDir>/shiftwork.json` (the pi agent dir),
 * validated and defaulted. Throws with the file and field path on a bad config.
 */
export async function loadConfig(root, userDir) {
	const user = userDir ? await readJson(join(userDir, "shiftwork.json")) : undefined;
	const project = await readJson(join(root, ".pi", "shiftwork.json"));
	const merged = merge(merge({}, user?.data ?? {}), project?.data ?? {});
	try {
		return validateConfig(merged);
	} catch (error) {
		const files = [user?.path, project?.path].filter(Boolean).join(" + ") || "defaults";
		throw new Error(`${files}: ${error.message}`);
	}
}

/** Validate and default a config object. Throws `field.path: problem`. */
export function validateConfig(input) {
	const config = { ...DEFAULTS, ...stripUndefined(input) };
	const tiers = config.tiers ?? {};
	const skillGroups = config.skillGroups ?? {};
	const skillSources = config.skillSources ?? {};

	checkModel(config.model, "model", { optional: true });
	checkThinking(config.thinking, "thinking");
	if (config.tracker !== undefined && !["scratch", "openspec"].includes(config.tracker)) {
		fail("tracker", 'must be "scratch" or "openspec"');
	}
	checkOpenSpec(config.openspec, "openspec");
	if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) fail("maxAttempts", "must be a positive integer");
	if (!Number.isInteger(config.maxHandoffs) || config.maxHandoffs < 0) fail("maxHandoffs", "must be a non-negative integer");
	if (typeof config.softLimitPct !== "number" || config.softLimitPct < 0 || config.softLimitPct > 100) {
		fail("softLimitPct", "must be a number between 0 and 100");
	}

	checkBudgets(config.budgets, "budgets");
	checkModels(config.models, "models");
	checkOnExceed(config.onExceed, "onExceed");
	checkCrossTier(config.crossTier, "crossTier");
	if (typeof config.allowInPlace !== "boolean") fail("allowInPlace", "must be true or false");
	if (config.paidProviders !== undefined && !(Array.isArray(config.paidProviders) && config.paidProviders.every((p) => typeof p === "string"))) {
		fail("paidProviders", "must be an array of provider names");
	}
	if (config.probeEveryMin !== undefined && !(typeof config.probeEveryMin === "number" && config.probeEveryMin > 0)) {
		fail("probeEveryMin", "must be a number of minutes > 0");
	}
	if (config.probeBeforeTicket !== undefined && typeof config.probeBeforeTicket !== "boolean") fail("probeBeforeTicket", "must be true or false");
	if (config.preferWaitMin !== undefined && !(typeof config.preferWaitMin === "number" && config.preferWaitMin >= 0)) {
		fail("preferWaitMin", "must be a number of minutes ≥ 0");
	}
	config.cooldown = checkCooldown({ ...DEFAULTS.cooldown, ...config.cooldown }, "cooldown");
	config.jev = checkJev(config.jev, "jev");

	for (const [name, sources] of Object.entries(skillGroups)) {
		if (!Array.isArray(sources) || !sources.every((s) => typeof s === "string")) {
			fail(`skillGroups.${name}`, "must be an array of skill source names");
		}
	}
	for (const [name, source] of Object.entries(skillSources)) {
		if (typeof source !== "string" || source.length === 0) fail(`skillSources.${name}`, "must be a non-empty path string");
	}

	for (const [name, tier] of Object.entries(tiers)) {
		if (!Array.isArray(tier.chain) || tier.chain.length === 0) fail(`tiers.${name}.chain`, "must be a non-empty array of \"provider/model\"");
		tier.chain.forEach((model, i) => checkModel(model, `tiers.${name}.chain[${i}]`));
		checkThinking(tier.thinking, `tiers.${name}.thinking`, { optional: true });
		checkSkillGroups(tier.skills, `tiers.${name}.skills`, skillGroups);
		checkSkillGroups(tier.preload, `tiers.${name}.preload`, skillGroups);
		checkBudget(tier.budget, `tiers.${name}.budget`);
		for (const group of tier.preload ?? []) {
			if (!(tier.skills ?? []).includes(group)) fail(`tiers.${name}.preload`, `preload group "${group}" is not in tier skills`);
		}
	}
	for (const [type, route] of Object.entries(config.routing ?? {})) {
		if (route.tier !== undefined && !tiers[route.tier]) fail(`routing.${type}.tier`, `unknown tier "${route.tier}"`);
		checkModel(route.model, `routing.${type}.model`, { optional: true });
		checkThinking(route.thinking, `routing.${type}.thinking`, { optional: true });
		if (!route.tier && !route.model) fail(`routing.${type}`, "needs a tier or a model");
	}
	if (config.defaultTier !== undefined && !tiers[config.defaultTier]) fail("defaultTier", `unknown tier "${config.defaultTier}"`);

	const worktree = config.worktree ?? {};
	if (worktree.enabled !== undefined && typeof worktree.enabled !== "boolean") fail("worktree.enabled", "must be true or false");
	if (worktree.setup !== undefined && !(Array.isArray(worktree.setup) && worktree.setup.every((c) => typeof c === "string"))) {
		fail("worktree.setup", "must be an array of shell commands");
	}

	const fallback = config.routing?.[config.defaultType];
	if (!fallback && !config.defaultTier && !config.model) {
		fail("routing", `no route for type "${config.defaultType}": add routing.${config.defaultType}, defaultTier or model`);
	}

	// Propagate tier budgets into tier objects so planners can read them in one place.
	for (const [name, tier] of Object.entries(tiers)) {
		const tierBudget = config.budgets?.tiers?.[name];
		if (tierBudget && tier.budget === undefined) tier.budget = tierBudget;
	}

	return config;
}

function checkOpenSpec(value, path) {
	if (value === undefined) return;
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const key of Object.keys(value)) {
		if (key !== "verify") fail(`${path}.${key}`, "unknown openspec field; expected verify");
	}
	if (value.verify !== undefined && !(Array.isArray(value.verify) && value.verify.every((c) => typeof c === "string" && c.length > 0))) {
		fail(`${path}.verify`, "must be an array of shell commands");
	}
}

const PROFILE_FIELDS = ["contextWindow", "thinking", "budget"];

function checkModels(value, path) {
	if (value === undefined) return;
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const [ref, profile] of Object.entries(value)) checkProfile(profile, `${path}.${ref}`);
}

function checkProfile(value, path) {
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const key of Object.keys(value)) {
		if (!PROFILE_FIELDS.includes(key)) fail(`${path}.${key}`, `unknown profile field; expected one of ${PROFILE_FIELDS.join(", ")}`);
	}
	if (value.contextWindow !== undefined && value.contextWindow !== null) {
		if (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow) || value.contextWindow <= 0) {
			fail(`${path}.contextWindow`, "must be a positive finite number");
		}
	}
	checkThinking(value.thinking, `${path}.thinking`, { optional: true });
	checkBudget(value.budget, `${path}.budget`);
}

function checkBudgets(value, path) {
	if (value === undefined) return;
	if (!isPlainObject(value)) fail(path, "must be an object");
	checkBudget(value.default, `${path}.default`);
	checkBudget(value.ticket, `${path}.ticket`);
	if (value.tiers !== undefined) {
		if (!isPlainObject(value.tiers)) fail(`${path}.tiers`, "must be an object");
		for (const [name, budget] of Object.entries(value.tiers)) checkBudget(budget, `${path}.tiers.${name}`);
	}
	if (value.models !== undefined) {
		if (!isPlainObject(value.models)) fail(`${path}.models`, "must be an object");
		for (const [name, budget] of Object.entries(value.models)) checkBudget(budget, `${path}.models.${name}`);
	}
}

const BUDGET_FIELDS = ["maxTokens", "maxCostUsd", "maxTurns", "maxWallMin", "maxContextPct", "stallTurns"];

function checkBudget(value, path) {
	if (value === undefined) return;
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const key of Object.keys(value)) {
		if (!BUDGET_FIELDS.includes(key)) fail(`${path}.${key}`, `unknown budget field; expected one of ${BUDGET_FIELDS.join(", ")}`);
	}
	for (const key of BUDGET_FIELDS) {
		const v = value[key];
		if (v === undefined || v === null) continue;
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`${path}.${key}`, "must be a non-negative finite number");
	}
}

const ON_EXCEED_KINDS = [...BUDGET_FIELDS, "verifyFailed"];
const ON_EXCEED_TARGETS = ["next", "downgrade", "escalate", "same-tier"];
const ON_EXCEED_MODES = ["same-process", "new-process", "auto"];
const CROSS_TIER = ["none", "up", "down"];
const COOLDOWN_KINDS = ["rate", "usage", "quota", "server"];

function checkOnExceed(value, path) {
	if (value === undefined) return;
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const [kind, rule] of Object.entries(value)) {
		if (!ON_EXCEED_KINDS.includes(kind)) fail(`${path}.${kind}`, `unknown kind; expected one of ${ON_EXCEED_KINDS.join(", ")}`);
		if (!isPlainObject(rule)) fail(`${path}.${kind}`, "must be an object");
		if (rule.to !== undefined && !ON_EXCEED_TARGETS.includes(rule.to)) {
			fail(`${path}.${kind}.to`, `must be one of ${ON_EXCEED_TARGETS.join(", ")}`);
		}
		if (rule.mode !== undefined && !ON_EXCEED_MODES.includes(rule.mode)) {
			fail(`${path}.${kind}.mode`, `must be one of ${ON_EXCEED_MODES.join(", ")}`);
		}
	}
}

function checkCrossTier(value, path) {
	if (value === undefined) return;
	if (!CROSS_TIER.includes(value)) fail(path, `must be one of ${CROSS_TIER.join(", ")}`);
}

function checkJev(value, path) {
	if (value === undefined) return { ...DEFAULTS.jev };
	if (!isPlainObject(value)) fail(path, "must be an object");
	const out = { ...DEFAULTS.jev, ...value };
	if (typeof out.enabled !== "boolean") fail(`${path}.enabled`, "must be true or false");
	const models = Array.isArray(out.model) ? out.model : out.model !== undefined ? [out.model] : [];
	if (models.length === 0) fail(`${path}.model`, "must be a model or a non-empty list");
	models.forEach((model, i) => checkModel(model, Array.isArray(out.model) ? `${path}.model[${i}]` : `${path}.model`));
	return out;
}

function checkCooldown(value, path) {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) fail(path, "must be an object");
	const out = {};
	for (const key of Object.keys(value)) {
		if (!COOLDOWN_KINDS.includes(key)) fail(`${path}.${key}`, `unknown cooldown kind; expected one of ${COOLDOWN_KINDS.join(", ")}`);
	}
	for (const kind of COOLDOWN_KINDS) {
		const raw = value[kind];
		if (raw === undefined || raw === null) continue;
		if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
			out[kind] = raw;
			continue;
		}
		const ms = parseCooldownDuration(raw);
		if (ms == null) fail(`${path}.${kind}`, `expected a duration like "15m" or milliseconds, got ${JSON.stringify(raw)}`);
		out[kind] = ms;
	}
	return out;
}

function checkModel(value, path, { optional = false } = {}) {
	if (value === undefined && optional) return;
	const cliPrefix = /^(claude|codex|opencode|grok|cursor):/;
	const isCli = cliPrefix.test(value);
	const validPi = /^[^/\s]+\/\S+$/.test(value);
	if (typeof value !== "string" || (!isCli && !validPi)) fail(path, `expected "provider/model" or "backend:model", got ${JSON.stringify(value)}`);
	if (!isCli && value.startsWith("CHANGE-ME")) fail(path, "replace the CHANGE-ME placeholder with a real provider/model (see pi --list-models)");
}

function checkSkillGroups(value, path, groups, { optional = true } = {}) {
	if (value === undefined && optional) return;
	if (!Array.isArray(value) || !value.every((g) => typeof g === "string")) fail(path, "must be an array of skill group names");
	for (const group of value) {
		if (!groups[group]) fail(path, `unknown skill group "${group}"`);
	}
}

function checkThinking(value, path, { optional = false } = {}) {
	if (value === undefined && optional) return;
	if (!THINKING_LEVELS.includes(value)) fail(path, `must be one of ${THINKING_LEVELS.join(", ")}`);
}

function fail(path, problem) {
	throw new Error(`${path}: ${problem}`);
}

async function readJson(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return { path, data: JSON.parse(text) };
	} catch (error) {
		throw new Error(`${path}: ${error.message}`);
	}
}

function merge(base, over) {
	for (const [key, value] of Object.entries(over)) {
		base[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge({ ...base[key] }, value) : value;
	}
	return base;
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripUndefined(object) {
	return Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => v !== undefined));
}
