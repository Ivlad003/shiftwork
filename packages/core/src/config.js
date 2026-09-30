import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const DEFAULTS = { defaultType: "code", thinking: "medium", maxAttempts: 3, skillGroups: {}, skillSources: {} };

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
	if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) fail("maxAttempts", "must be a positive integer");

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
	return config;
}

function checkModel(value, path, { optional = false } = {}) {
	if (value === undefined && optional) return;
	if (typeof value !== "string" || !/^[^/\s]+\/\S+$/.test(value)) fail(path, `expected "provider/model", got ${JSON.stringify(value)}`);
	if (value.startsWith("CHANGE-ME")) fail(path, "replace the CHANGE-ME placeholder with a real provider/model (see pi --list-models)");
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
