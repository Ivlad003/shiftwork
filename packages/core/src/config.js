import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCooldownDuration } from "./classify.js";
import { shiftworkPath } from "./paths.js";
import { BACKENDS, LIMIT_SHORT_NAMES, TIER_ORDER } from "./planner.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULTS = {
	defaultType: "code",
	thinking: "medium",
	maxAttempts: 3,
	maxHandoffs: 3,
	landRetries: 5,
	maxLimitRetries: 10,
	verifyTimeoutMin: 10,
	softLimitPct: 80,
	crossTier: "none",
	allowInPlace: false,
	parallel: 1,
	cooldown: { rate: "15m", usage: "5h", quota: "24h", server: "5m" },
	skillGroups: {},
	skillSources: {},
	models: {},
	backends: {},
	budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
	onExceed: {},
	jev: { enabled: true, model: "typesafe/jev-latest" },
	review: { enabled: true, when: "before-land", maxRounds: 2 },
	frozen: [],
};

/** The review shift's whole budget, when reviews run: only `review.budget` itself lifts a field of it. */
export const DEFAULT_REVIEW_BUDGET = { maxWallMin: 20, maxTurns: 60 };

// `github` is deliberately not in DEFAULTS: a github block requires labels.in,
// so only checkGitHub knows the absent-block defaults.
const GITHUB_DEFAULTS = { authors: [], pollMin: 5, autoClose: true, push: false };

/**
 * Load `.shiftwork/shiftwork.json` (legacy `.pi/shiftwork.json`, see paths.js) merged over `<userDir>/shiftwork.json` (the pi agent dir),
 * validated and defaulted. Throws with the file and field path on a bad config.
 */
export async function loadConfig(root, userDir) {
	const user = userDir ? await readJson(join(userDir, "shiftwork.json")) : undefined;
	const project = await readJson(shiftworkPath(root, "shiftwork.json"));
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
	if (typeof config.verifyTimeoutMin !== "number" || !Number.isFinite(config.verifyTimeoutMin) || config.verifyTimeoutMin <= 0) {
		fail("verifyTimeoutMin", "must be a number of minutes > 0");
	}
	if (!Number.isInteger(config.maxHandoffs) || config.maxHandoffs < 0) fail("maxHandoffs", "must be a non-negative integer");
	if (!Number.isInteger(config.landRetries) || config.landRetries < 0) fail("landRetries", "must be a non-negative integer");
	if (!Number.isInteger(config.maxLimitRetries) || config.maxLimitRetries < 1) fail("maxLimitRetries", "must be a positive integer");
	if (typeof config.softLimitPct !== "number" || config.softLimitPct < 0 || config.softLimitPct > 100) {
		fail("softLimitPct", "must be a number between 0 and 100");
	}

	checkBudgets(config.budgets, "budgets");
	config.unlimited = normalizeUnlimited(config.unlimited, "unlimited");
	config.backends = checkBackends({ ...DEFAULTS.backends, ...config.backends }, "backends");
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
	// Frozen paths every ticket adds its own `**Frozen:**` globs to: no shift may change them.
	if (!Array.isArray(config.frozen) || !config.frozen.every((g) => typeof g === "string" && g.length > 0)) {
		fail("frozen", 'must be an array of globs ("packages/*/test/fixtures/**")');
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
		if (tier.unlimited !== undefined) tier.unlimited = normalizeUnlimited(tier.unlimited, `tiers.${name}.unlimited`);
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
	config.review = checkReview(config.review, "review", tiers);
	config.dual = checkDual(config.dual, "dual", tiers);
	config.github = checkGitHub(config.github, "github", tiers);
	// `github.planTier` routes plan tickets unless the config already routes `plan`.
	// Done here, not in the importer, so every validated config carries it before a runner sees it.
	if (config.github?.planTier && !config.routing?.plan) {
		config.routing = { ...config.routing, plan: { tier: config.github.planTier } };
	}

	const worktree = config.worktree ?? {};
	if (worktree.enabled !== undefined && typeof worktree.enabled !== "boolean") fail("worktree.enabled", "must be true or false");
	if (worktree.setup !== undefined && !(Array.isArray(worktree.setup) && worktree.setup.every((c) => typeof c === "string"))) {
		fail("worktree.setup", "must be an array of shell commands");
	}

	// Parallel shifts: N frontier tickets at once, each in its own worktree (ticket 01).
	if (!Number.isInteger(config.parallel) || config.parallel < 1) fail("parallel", "must be a positive integer");
	if (config.parallel > 1 && worktree.enabled !== true) {
		fail("parallel", "parallel > 1 requires worktree.enabled: every parallel ticket needs its own worktree");
	}
	if (config.concurrency !== undefined) {
		if (!isPlainObject(config.concurrency)) fail("concurrency", "must be an object of provider → max shifts at once");
		for (const [provider, cap] of Object.entries(config.concurrency)) {
			if (!Number.isInteger(cap) || cap < 1) fail(`concurrency.${provider}`, "must be a positive integer");
		}
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

const PROFILE_FIELDS = ["contextWindow", "thinking", "budget", "unlimited"];

function checkModels(value, path) {
	if (value === undefined) return;
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const [ref, profile] of Object.entries(value)) checkProfile(profile, `${path}.${ref}`);
}

/**
 * `backends.<name>`: whole agents (CLI backends and `pi`) without limits. Keys are the
 * backend names `parseModelRef` returns (`BACKENDS`); the only field is `unlimited`,
 * normalized in place. Returns the value, normalized.
 */
function checkBackends(value, path) {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) fail(path, "must be an object of backend → { unlimited }");
	for (const [name, backend] of Object.entries(value)) {
		if (!BACKENDS.includes(name)) fail(`${path}.${name}`, `unknown backend "${name}"; expected one of ${BACKENDS.join(", ")}`);
		if (!isPlainObject(backend)) fail(`${path}.${name}`, "must be an object with an `unlimited` field");
		for (const key of Object.keys(backend)) {
			if (key !== "unlimited") fail(`${path}.${name}.${key}`, "unknown field; expected unlimited");
		}
		if (backend.unlimited !== undefined) backend.unlimited = normalizeUnlimited(backend.unlimited, `${path}.${name}.unlimited`);
	}
	return value;
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
	if (value.unlimited !== undefined) value.unlimited = normalizeUnlimited(value.unlimited, `${path}.unlimited`);
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

/** Short names for budget limits, as `unlimited` and `run --no-limit` take them. */
export const LIMIT_NAMES = LIMIT_SHORT_NAMES;

/**
 * `unlimited`: true (lift every budget limit) or a list of limits by short or full name.
 * Returns the full field names to lift; [] when nothing is lifted.
 */
export function normalizeUnlimited(value, path = "unlimited") {
	if (value === undefined || value === false || value === null) return [];
	if (value === true) return [...BUDGET_FIELDS];
	if (!Array.isArray(value)) fail(path, `must be true or a list of limits (${Object.keys(LIMIT_NAMES).join(", ")})`);
	const out = [];
	for (const name of value) {
		const field = LIMIT_NAMES[name] ?? (BUDGET_FIELDS.includes(name) ? name : undefined);
		if (!field) fail(path, `unknown limit ${JSON.stringify(name)}; expected one of ${Object.keys(LIMIT_NAMES).join(", ")}`);
		if (!out.includes(field)) out.push(field);
	}
	return out;
}

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

// `resolve` is `after-land`'s old name, still accepted as an alias.
const REVIEW_WHEN = ["before-land", "after-land", "resolve"];
// `reason` is an output of checkReview only (why reviews are off with no tier), never an operator field.
const REVIEW_FIELDS = ["enabled", "tier", "when", "maxRounds", "features", "types", "budget"];
// The conventional tier ladder strongest first: the default review tier picks the strongest configured one.
const STRONGEST_TIER_ORDER = [...TIER_ORDER].reverse();

/** Why reviews stay off when there is no tier to review on. */
export const REVIEW_NO_TIER_REASON = "no tier to review on; set review.tier";

function checkReview(value, path, tiers) {
	// `review: false` opts out entirely; `true` is every default. Anything else must be the object form.
	if (value === false) value = { enabled: false };
	if (value === true || value === undefined) value = {};
	if (!isPlainObject(value)) fail(path, "must be an object, true or false");
	// `reason` is this function's own output (why reviews are off with no tier), never an operator
	// field: re-validating a validated config (`run` does) must not fail on the value it wrote.
	// Any other `reason` is an unknown field.
	for (const key of Object.keys(value)) {
		if (key === "reason") {
			if (value.reason !== REVIEW_NO_TIER_REASON) fail(`${path}.reason`, `unknown review field; expected one of ${REVIEW_FIELDS.join(", ")}`);
		} else if (!REVIEW_FIELDS.includes(key)) {
			fail(`${path}.${key}`, `unknown review field; expected one of ${REVIEW_FIELDS.join(", ")}`);
		}
	}
	const out = { ...DEFAULTS.review, ...value };
	if (typeof out.enabled !== "boolean") fail(`${path}.enabled`, "must be true or false");
	// `resolve` is `after-land`'s old name: normalized here so a validated config always carries the new one.
	if (out.when === "resolve") out.when = "after-land";
	if (!REVIEW_WHEN.includes(out.when)) fail(`${path}.when`, `must be one of ${REVIEW_WHEN.join(", ")}`);
	if (!Number.isInteger(out.maxRounds) || out.maxRounds < 1) fail(`${path}.maxRounds`, "must be a positive integer");
	if (out.tier !== undefined && !tiers[out.tier]) fail(`${path}.tier`, `unknown tier "${out.tier}"`);
	// No explicit tier: review on the strongest configured tier, else the first declared one.
	if (out.enabled && out.tier === undefined) {
		const names = Object.keys(tiers);
		const tier = STRONGEST_TIER_ORDER.find((name) => names.includes(name)) ?? names[0];
		// No tiers at all: nothing to review on, so reviews stay off with the reason.
		if (tier === undefined) {
			out.enabled = false;
			out.reason = REVIEW_NO_TIER_REASON;
		} else {
			out.tier = tier;
		}
	}
	if (out.features !== undefined && !(Array.isArray(out.features) && out.features.every((f) => typeof f === "string" && f.length > 0))) {
		fail(`${path}.features`, "must be an array of feature names");
	}
	if (out.types !== undefined && !(Array.isArray(out.types) && out.types.every((t) => typeof t === "string" && t.length > 0))) {
		fail(`${path}.types`, "must be an array of ticket types");
	}
	// The review shift's whole budget, only when reviews can run: ticket, tier and model
	// budgets never cap it, and no `unlimited` list lifts it — only `review.budget` itself does.
	checkBudget(value.budget, `${path}.budget`);
	if (out.enabled) out.budget = reviewBudget(value.budget);
	else delete out.budget;
	return out;
}

/** The review budget over its default: `review.budget`'s fields win, a `null` field lifts its default.
 * The lift stays `null` in the output (the meter skips a null limit), so re-validating an already
 * validated config — `run` does, with CLI overrides — round-trips it instead of refilling the default. */
function reviewBudget(budget) {
	return { ...DEFAULT_REVIEW_BUDGET, ...(budget ?? {}) };
}

const DUAL_FIELDS = ["enabled", "types", "features", "models", "tiers", "mergeTier", "budget"];

/**
 * `dual`: two worker shifts on one ticket, on two models in two worktrees, then a merge shift
 * (ADR-0007). `true`/`false` are `{ enabled }`; absent stays absent. `models` (two model refs) and
 * `tiers` (two tier names) pick the two candidates' routes — one of them, never both; `mergeTier`
 * is where the merge shift runs (the review tier by default); `budget` is the merge shift's budget.
 */
function checkDual(value, path, tiers) {
	if (value === undefined) return undefined;
	if (value === true || value === false) value = { enabled: value };
	if (!isPlainObject(value)) fail(path, "must be an object, true or false");
	for (const key of Object.keys(value)) {
		if (!DUAL_FIELDS.includes(key)) fail(`${path}.${key}`, `unknown dual field; expected one of ${DUAL_FIELDS.join(", ")}`);
	}
	const out = { enabled: false, ...value };
	if (typeof out.enabled !== "boolean") fail(`${path}.enabled`, "must be true or false");
	if (out.features !== undefined && !(Array.isArray(out.features) && out.features.every((f) => typeof f === "string" && f.length > 0))) {
		fail(`${path}.features`, "must be an array of feature names");
	}
	if (out.types !== undefined && !(Array.isArray(out.types) && out.types.every((t) => typeof t === "string" && t.length > 0))) {
		fail(`${path}.types`, "must be an array of ticket types");
	}
	if (out.models !== undefined && out.tiers !== undefined) fail(path, "set models or tiers, not both");
	if (out.models !== undefined) {
		if (!Array.isArray(out.models) || out.models.length !== 2) fail(`${path}.models`, "must be two model references [A, B]");
		out.models.forEach((model, i) => checkModel(model, `${path}.models[${i}]`));
	}
	if (out.tiers !== undefined) {
		if (!Array.isArray(out.tiers) || out.tiers.length !== 2) fail(`${path}.tiers`, "must be two tier names [A, B]");
		out.tiers.forEach((tier, i) => {
			if (!tiers[tier]) fail(`${path}.tiers[${i}]`, `unknown tier ${JSON.stringify(tier)}`);
		});
	}
	if (out.mergeTier !== undefined && !tiers[out.mergeTier]) fail(`${path}.mergeTier`, `unknown tier ${JSON.stringify(out.mergeTier)}`);
	checkBudget(out.budget, `${path}.budget`);
	return out;
}

const GITHUB_FIELDS = ["repo", "authors", "labels", "pollMin", "autoClose", "push", "planTier", "gh"];
const GITHUB_LABEL_FIELDS = ["in", "working", "needsInfo", "done"];

/** Default names of the labels Shiftwork itself sets on an issue (spec: github-watch). */
export const GITHUB_LABEL_DEFAULTS = {
	working: "shiftwork:working",
	needsInfo: "shiftwork:needs-info",
	done: "shiftwork:done",
};

/** The `labels.in` problem, without the field path `fail` adds. The guide pointer stays in the message. */
const LABELS_IN_PROBLEM = 'required: the label that hands an issue to Shiftwork (see docs/guide.md "Dark-factory: labels")';

/** The error for a `github` block without `labels.in`: it is required, never silently defaulted. */
export const GITHUB_LABELS_IN_REQUIRED = `github.labels.in: ${LABELS_IN_PROBLEM}`;

/** The `github` block: the dark-factory watcher's source repo and behavior (spec: github-watch). */
function checkGitHub(value, path, tiers) {
	// No github block → no github config: filling defaults here would make a second
	// validateConfig (loadConfig validates, run re-validates with CLI overrides)
	// see the filled defaults as a github block and demand labels.in.
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) fail(path, "must be an object");
	for (const key of Object.keys(value)) {
		if (!GITHUB_FIELDS.includes(key)) fail(`${path}.${key}`, `unknown github field; expected one of ${GITHUB_FIELDS.join(", ")}`);
	}
	const out = { ...GITHUB_DEFAULTS, ...value };
	if (out.repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
		fail(`${path}.repo`, `must be "owner/name", got ${JSON.stringify(out.repo)}`);
	}
	if (out.authors !== undefined && !(Array.isArray(out.authors) && out.authors.every((a) => typeof a === "string" && a.length > 0))) {
		fail(`${path}.authors`, "must be an array of GitHub logins");
	}
	if (out.labels !== undefined && !isPlainObject(out.labels)) fail(`${path}.labels`, "must be an object");
	// `labels.in` hands an issue to Shiftwork, so it is required in every `github` block,
	// never silently defaulted; the labels Shiftwork sets itself get default names.
	const labels = { ...GITHUB_LABEL_DEFAULTS, ...(isPlainObject(out.labels) ? out.labels : undefined) };
	for (const key of Object.keys(out.labels ?? {})) {
		if (!GITHUB_LABEL_FIELDS.includes(key)) fail(`${path}.labels.${key}`, `unknown labels field; expected one of ${GITHUB_LABEL_FIELDS.join(", ")}`);
	}
	if (labels.in === undefined || labels.in === null) fail(`${path}.labels.in`, LABELS_IN_PROBLEM);
	for (const key of GITHUB_LABEL_FIELDS) {
		if (typeof labels[key] !== "string" || labels[key].length === 0) fail(`${path}.labels.${key}`, "must be a label name");
	}
	out.labels = labels;
	if (out.gh !== undefined && !(typeof out.gh === "string" && out.gh.length > 0)) {
		fail(`${path}.gh`, `must be a path to the gh binary, got ${JSON.stringify(out.gh)}`);
	}
	if (out.pollMin !== undefined && !(typeof out.pollMin === "number" && Number.isFinite(out.pollMin) && out.pollMin > 0)) {
		fail(`${path}.pollMin`, "must be a number of minutes > 0");
	}
	if (out.autoClose !== undefined && typeof out.autoClose !== "boolean") fail(`${path}.autoClose`, "must be true or false");
	if (out.push !== undefined && typeof out.push !== "boolean") fail(`${path}.push`, "must be true or false");
	if (out.planTier !== undefined && !tiers[out.planTier]) fail(`${path}.planTier`, `unknown tier "${out.planTier}"`);
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
