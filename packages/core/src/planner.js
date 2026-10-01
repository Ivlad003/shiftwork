/**
 * Choose the route for a ticket's next shift. Pure.
 * Order: the ticket's Model → routing[Type] → defaultTier → top-level model.
 * Unknown or missing Types use `defaultType`, unless `classification` supplies a routed type.
 * Untyped tickets with classification.complexity=complex raise the tier by one.
 * Skill groups come from the resolved tier, adjusted by `ticket.skills`, then
 * resolved to paths from `config.skillSources`. Preloaded skills are a subset.
 * Budgets merge default → tier → budgets.models (legacy) → models[ref].budget, the union of `unlimited` lists (top-level,
 * tier, model profile and backend) is lifted from the shift budget and from the ticket budget that caps the result.
 * Thinking: the ticket type's routing → the model profile → the tier → global. A profile's contextWindow is used for context fill.
 * A provider at its `concurrency` cap (`fullProviders`) is skipped like a cooling one, but no
 * cooldown is written and there is no end time: waiting re-plans after FULL_PROVIDER_RETRY_MS.
 * @returns {object} a Route, or `{ wait: Date }` when every candidate is cooling or full
 */
export function planShift({ ticket, config, history = {}, cooldowns = [], now = new Date(), classification, fullProviders = [] } = {}) {
	const { type, typeSource } = resolveType(ticket, config, classification);
	const routing = config.routing?.[type];
	let tierName = routing?.model ? undefined : (routing?.tier ?? config.defaultTier);
	if (!ticket.type && classification?.complexity === "complex") {
		tierName = raiseTier(tierName, config);
	}
	const at = now instanceof Date ? now : new Date(now);
	const onExceed = config.onExceed ?? {};
	const blockedModels = history.blockedModels ?? [];

	if (history.exceededKind && history.previousRoute) {
		const nextModel = chooseHandoffTarget({
			previousRoute: history.previousRoute,
			kind: history.exceededKind,
			config,
			cooldowns,
			now: at,
			blockedModels,
			fullProviders,
		});
		if (nextModel) return buildRoute({ ticket, config, type, typeSource, model: nextModel, history, onExceed, capRemaining: true });
	}

	const picked = pickModel({ ticket, config, routing, tierName, cooldowns, now: at, blockedModels, fullProviders });
	if (picked.wait) return picked;
	if (picked.stop) return picked;
	if (!picked.model) {
		if (blockedModels.length) return { stop: "no eligible model: stalled models excluded" };
		throw new Error(`no route for ticket ${ticket.feature}/${ticket.number} (type "${type}")`);
	}
	// The ticket type's thinking wins; buildRoute falls back to profile → tier → global.
	const thinking = routing?.thinking;
	return buildRoute({
		ticket,
		config,
		type,
		typeSource,
		model: picked.model,
		tierName: picked.tier ?? tierName,
		thinking,
		history,
		onExceed,
	});
}

function buildRoute({ ticket, config, type, typeSource, model, modelRef, tierName, thinking, history, onExceed, capRemaining = false }) {
	const ref = modelRef ?? parseModelRef(model);
	const tier = tierName ?? tierForModel(model, config);
	const profile = config.models?.[model];
	const think = thinking ?? profile?.thinking ?? config.tiers?.[tier]?.thinking ?? config.thinking;
	const skills = resolveSkills({
		ticket,
		tier: config.tiers?.[tier],
		skillGroups: config.skillGroups ?? {},
		skillSources: config.skillSources ?? {},
	});
	const ticketBudget = resolveTicketBudget(ticket, config);
	// Lift the union of the top-level, tier, profile and backend `unlimited` lists from the
	// shift budget and from the ticket budget that caps it: that route runs without them.
	const lifted = liftedFor({ model, tier }, config);
	const budget = capBudget(
		liftLimits(mergeBudgets(config.budgets?.default, config.tiers?.[tier]?.budget, config.budgets?.models?.[model], profile?.budget), lifted),
		liftLimits(capRemaining ? capBudgetRemaining(ticketBudget, history.ticketUsage) : ticketBudget, lifted),
	);
	return {
		backend: ref.backend,
		model: ref.model,
		ref: model,
		provider: ref.provider,
		type,
		typeSource,
		tier,
		thinking: think,
		skills,
		budget,
		onExceed,
		contextWindow: profile?.contextWindow,
	};
}

/** Conventional tier ladder. Jev `complexity=complex` raises one step. */
export const TIER_ORDER = ["quick", "standard", "premium"];

function resolveType(ticket, config, classification) {
	if (ticket.type && config.routing?.[ticket.type]) return { type: ticket.type, typeSource: "ticket" };
	if (!ticket.type && classification?.type && config.routing?.[classification.type]) {
		return { type: classification.type, typeSource: "jev" };
	}
	return { type: config.defaultType, typeSource: "default" };
}

function raiseTier(tierName, config) {
	if (!tierName) return tierName;
	const idx = TIER_ORDER.indexOf(tierName);
	if (idx < 0) return tierName;
	const next = TIER_ORDER[idx + 1];
	return next && config.tiers?.[next] ? next : tierName;
}

function pickModel(args) {
	const picked = pickAnyModel(args);
	return preferWaitOverPaid(picked, args);
}

/**
 * Paid providers (`paidProviders`, pay per token) are a last resort: when a subscription provider of
 * the candidate chains frees up within `preferWaitMin`, wait for it instead of paying.
 */
function preferWaitOverPaid(picked, { config, tierName, cooldowns, now, blockedModels = [] }) {
	const paid = new Set(config.paidProviders ?? []);
	// OpenRouter-style `:free` models and local `ollama/…` models cost nothing even when
	// their provider is listed as paid.
	const isPaid = (model) => paid.has(providerOf(model)) && !isFreeModel(model);
	if (!picked.model || !isPaid(picked.model)) return picked;
	const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
	const limit = t + (config.preferWaitMin ?? 30) * 60_000;
	const candidates = [tierName, ...Object.keys(config.tiers ?? {})]
		.flatMap((name) => config.tiers?.[name]?.chain ?? [])
		.filter((model) => !isPaid(model) && !isBlocked(model, blockedModels));
	const soonest = candidates
		.map((model) => cooldownUntil(model, cooldowns))
		.filter((until) => until && until.getTime() > t && until.getTime() <= limit)
		.sort((a, b) => a - b)[0];
	return soonest ? { wait: soonest } : picked;
}

function pickAnyModel({ ticket, config, routing, tierName, cooldowns, now, blockedModels = [], fullProviders = [] }) {
	const pinned = ticket.model ?? routing?.model;
	if (pinned && !isBlocked(pinned, blockedModels)) {
		if (isCooling(pinned, cooldowns, now)) return { wait: cooldownUntil(pinned, cooldowns) };
		if (isBusy(pinned, fullProviders)) return { wait: fullRetryAt(now) };
		return { model: pinned, tier: tierName };
	}
	const chain = config.tiers?.[tierName]?.chain ?? [];
	const free = firstFree(chain, cooldowns, now, blockedModels, fullProviders);
	if (free) return { model: free, tier: tierName };
	if (chain.length) {
		const neighbour = crossTierPick(tierName, config, cooldowns, now, blockedModels, fullProviders);
		if (neighbour) return neighbour;
		const until = earliestCooldown(chain, cooldowns, now);
		if (until) return { wait: until };
		// A full provider frees a slot as soon as any shift ends, so re-plan soon instead of stopping.
		if (chain.some((model) => isBusy(model, fullProviders) && !isBlocked(model, blockedModels))) return { wait: fullRetryAt(now) };
		if (blockedModels.length) return { stop: "no eligible model: stalled models excluded" };
	}
	if (config.model && !isBlocked(config.model, blockedModels)) {
		if (isCooling(config.model, cooldowns, now)) return { wait: cooldownUntil(config.model, cooldowns) };
		if (isBusy(config.model, fullProviders)) return { wait: fullRetryAt(now) };
		return { model: config.model, tier: tierName };
	}
	if (blockedModels.length) return { stop: "no eligible model: stalled models excluded" };
	return {};
}

function isBlocked(model, blocked) {
	return (blocked ?? []).includes(model);
}

/** A model whose provider has no free concurrency slot. */
function isBusy(model, fullProviders) {
	return (fullProviders ?? []).includes(providerOf(model));
}

/** No end time is known for a full provider: re-plan after this long. */
const FULL_PROVIDER_RETRY_MS = 60_000;

function fullRetryAt(now) {
	return new Date((now instanceof Date ? now : new Date(now)).getTime() + FULL_PROVIDER_RETRY_MS);
}

function providerOf(model) {
	return parseModelRef(model).provider;
}

/** Models that never cost anything: OpenRouter `…:free` ids and local `ollama/…` models. */
function isFreeModel(model) {
	const ref = String(model);
	return ref.endsWith(":free") || providerOf(ref) === "ollama";
}

/**
 * The key a provider limit cools. Free models (`…:free`, e.g. on OpenRouter) have their own
 * per-model limits, so a 429 on one of them cools only that model; everything else cools its provider.
 */
export function cooldownKey(ref) {
	return String(ref).endsWith(":free") ? String(ref) : providerOf(ref);
}

/** Cooldowns that apply to a model: its own key, and its provider as a whole. */
function cooldownsFor(model, cooldowns) {
	const keys = new Set([providerOf(model), cooldownKey(model)]);
	return (cooldowns ?? []).filter((c) => keys.has(c.provider));
}

function isCooling(model, cooldowns, now) {
	const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
	return cooldownsFor(model, cooldowns).some((c) => new Date(c.until).getTime() > t);
}

function firstFree(chain, cooldowns, now, blocked = [], fullProviders = []) {
	return (chain ?? []).find(
		(model) => !isCooling(model, cooldowns, now) && !isBlocked(model, blocked) && !isBusy(model, fullProviders),
	);
}

function cooldownUntil(model, cooldowns) {
	const ends = cooldownsFor(model, cooldowns).map((c) => new Date(c.until).getTime());
	return ends.length ? new Date(Math.max(...ends)) : undefined;
}

function earliestCooldown(models, cooldowns, now) {
	const providers = new Set((models ?? []).map(providerOf));
	const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
	const times = (cooldowns ?? [])
		.filter((c) => providers.has(c.provider) && new Date(c.until).getTime() > t)
		.map((c) => new Date(c.until).getTime());
	if (!times.length) return undefined;
	return new Date(Math.min(...times));
}

function crossTierPick(tierName, config, cooldowns, now, blockedModels, fullProviders = []) {
	const dir = config.crossTier;
	if (dir !== "up" && dir !== "down") return undefined;
	const order = ["quick", "standard", "premium"];
	const idx = order.indexOf(tierName);
	if (idx < 0) return undefined;
	const next = order[idx + (dir === "up" ? 1 : -1)];
	if (!next) return undefined;
	const free = firstFree(config.tiers?.[next]?.chain, cooldowns, now, blockedModels, fullProviders);
	if (!free) return undefined;
	return { model: free, tier: next };
}

/** Reasons where `auto` may keep the live session (cost, tokens, turns). */
const AUTO_IN_PLACE_KINDS = new Set(["maxCostUsd", "maxTokens", "maxTurns"]);

/**
 * Pick in-place (`same-process`) vs a fresh process, and whether to compact first.
 * Fresh is the default (ADR-0005). In-place is restored only when `allowInPlace` is true,
 * the backend supports `inPlaceHandoff`, and `auto`/`same-process` would have kept the session.
 * `auto` keeps the session for cost/token/turn limits when the target window can hold current usage.
 */
const CLI_BACKENDS = ["claude", "codex", "opencode", "grok", "cursor"];

/** Every backend a model reference can name, `pi` included: the keys of a `backends` config section. */
export const BACKENDS = ["pi", ...CLI_BACKENDS];

/** Short names for budget limits, as `unlimited` and `run --no-limit` take them. */
export const LIMIT_SHORT_NAMES = {
	tokens: "maxTokens",
	cost: "maxCostUsd",
	turns: "maxTurns",
	time: "maxWallMin",
	context: "maxContextPct",
	stall: "stallTurns",
};

/**
 * Split a model reference into its backend and model id.
 * Prefixes `claude:`, `codex:`, `opencode:`, `grok:` and `cursor:` select a CLI backend.
 * A reference without a prefix goes to the pi backend and its provider is the first segment.
 * @returns {{ backend: "pi" | "claude" | "codex" | "opencode" | "grok" | "cursor", model: string, provider: string }}
 */
export function parseModelRef(ref) {
	if (!ref || typeof ref !== "string") return { backend: "pi", model: ref ?? "", provider: "" };
	for (const backend of CLI_BACKENDS) {
		const prefix = `${backend}:`;
		if (ref.startsWith(prefix)) {
			const model = ref.slice(prefix.length);
			const provider = model.includes("/") ? `${backend}:${model.split("/")[0]}` : backend;
			return { backend, model, provider };
		}
	}
	return { backend: "pi", model: ref, provider: ref.split("/")[0] };
}

export function chooseHandoffMode({
	mode,
	kind,
	allowInPlace = false,
	inPlaceHandoff = false,
	contextTokens,
	targetContextWindow,
} = {}) {
	if (!allowInPlace || !inPlaceHandoff) return { mode: "new-process", compact: false };
	const windowTooSmall =
		targetContextWindow != null && contextTokens != null && contextTokens > targetContextWindow;
	let resolved = mode ?? "new-process";
	if (mode === "auto") {
		resolved = AUTO_IN_PLACE_KINDS.has(kind) && !windowTooSmall ? "same-process" : "new-process";
	}
	if (resolved !== "same-process") return { mode: "new-process", compact: false };
	return { mode: "same-process", compact: Boolean(windowTooSmall) };
}

function mergeBudgets(...budgets) {
	const merged = {};
	for (const budget of budgets) {
		if (!budget) continue;
		for (const key of Object.keys(budget)) {
			if (budget[key] !== undefined && budget[key] !== null) merged[key] = budget[key];
		}
	}
	return merged;
}

function capBudget(base, ticketBudget) {
	if (!ticketBudget) return base;
	const out = { ...base };
	for (const key of Object.keys(ticketBudget)) {
		if (ticketBudget[key] !== undefined && ticketBudget[key] !== null) {
			out[key] = Math.min(out[key] ?? Infinity, ticketBudget[key]);
		}
	}
	return out;
}

function capBudgetRemaining(ticketBudget, usage) {
	if (!ticketBudget || !usage) return ticketBudget;
	const out = {};
	for (const key of Object.keys(ticketBudget)) {
		const limit = ticketBudget[key];
		if (limit === undefined || limit === null) continue;
		const used = usage[key] ?? 0;
		out[key] = Math.max(0, limit - used);
	}
	return out;
}

export function resolveTicketBudget(ticket, config) {
	const fromTicket = parseTicketBudget(ticket.budget);
	const fromConfig = config.budgets?.ticket;
	// Only the top-level `unlimited` (and `run --no-budget` / `--no-limit`) lifts ticket budgets
	// here: this is the no-route view. The tier, model and backend lists lift the ticket
	// budget too, but only through the route — see `liftedFor` and `buildRoute`.
	return liftLimits(mergeBudgets(fromConfig, fromTicket), config.unlimited ?? []);
}

/**
 * The `unlimited` lists that apply to a route: the union of the top-level, tier, model-profile
 * and backend lists (`backends.<backend>`, keyed by the names `parseModelRef` returns).
 * Short names (`turns`) are normalized to budget fields (`maxTurns`) here, so it also works
 * with raw, unvalidated configs (the runner does not `validateConfig` its input).
 * A route with no model (a wait/stop plan) gets only the top-level list.
 */
export function liftedFor(route, config) {
	const model = route?.ref ?? route?.model;
	const lists = [config.unlimited];
	if (model) {
		const tier = route.tier ?? tierForModel(model, config);
		lists.push(
			config.tiers?.[tier]?.unlimited,
			config.models?.[model]?.unlimited,
			config.backends?.[parseModelRef(model).backend]?.unlimited,
		);
	}
	const out = [];
	for (const list of lists) {
		const fields = list === true ? Object.values(LIMIT_SHORT_NAMES) : (list ?? []);
		for (const name of fields) {
			const field = LIMIT_SHORT_NAMES[name] ?? name;
			if (!out.includes(field)) out.push(field);
		}
	}
	return out;
}

/** Drop the given lifted limits (`unlimited` lists, `run --no-budget` / `--no-limit`). */
function liftLimits(budget, lifted) {
	if (!budget || !lifted.length) return budget;
	const out = { ...budget };
	for (const field of lifted) delete out[field];
	return out;
}

/** A unit must not run on into another letter (Unicode-aware, so Ukrainian units work too). */
const END = String.raw`(?![\p{L}\p{N}])`;
const NUM = String.raw`([0-9]+(?:\.[0-9]+)?)`;
const TOKEN_SCALE = { k: 1e3, m: 1e6 };

/**
 * Parse a ticket's `Budget:` line, e.g. `$2 · 200k tokens · 1h 30min · 50 turns · 60% context · 5 stall`.
 * Tokens take k/M suffixes; time adds up hours and minutes (`1h30m`, `1.5h`, `1 год 15 хв`).
 */
function parseTicketBudget(value) {
	if (!value) return undefined;
	const out = {};
	const cost = value.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (cost) out.maxCostUsd = Number(cost[1]);
	const tokens = value.match(new RegExp(`${NUM}\\s*([kKmM])?\\s*(?:tokens?|tok)${END}`, "u"));
	if (tokens) out.maxTokens = Math.round(Number(tokens[1]) * (TOKEN_SCALE[tokens[2]?.toLowerCase()] ?? 1));
	const turns = value.match(new RegExp(`([0-9]+)\\s*(?:turns?|hod|ход(?:ів|и|а)?)${END}`, "iu"));
	if (turns) out.maxTurns = Number(turns[1]);
	// Hours may run straight into minutes ("1h30m"), so only a letter ends them wrongly.
	const hours = value.match(new RegExp(`${NUM}\\s*(?:h|hr|hours?|год(?:ин[аи]?)?)(?!\\p{L})`, "iu"));
	// A bare "m" is minutes only when it isn't a token count ("1.5M tokens").
	const minutes = value.match(new RegExp(`${NUM}\\s*(?:min(?:utes?)?|хв(?:илин[аи]?)?|m(?!\\s*tok))${END}`, "iu"));
	if (hours || minutes) out.maxWallMin = Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0);
	const context = value.match(new RegExp(`([0-9]+)\\s*%\\s*(?:context|ctx)${END}`, "iu"));
	if (context) out.maxContextPct = Number(context[1]);
	const stall = value.match(new RegExp(`(?:stall\\s*)?([0-9]+)\\s*(?:stall|застій)`, "iu"));
	if (stall) out.stallTurns = Number(stall[1]);
	return Object.keys(out).length ? out : undefined;
}

function chooseHandoffTarget({ previousRoute, kind, config, cooldowns = [], now = new Date(), blockedModels = [], fullProviders = [] }) {
	const rule = config.onExceed?.[kind];
	if (!rule?.to) return undefined;
	const tier = config.tiers?.[previousRoute.tier];
	const chain = tier?.chain ?? [];
	const idx = chain.indexOf(previousRoute.ref ?? previousRoute.model);
	if (rule.to === "next") {
		if (idx < 0) return undefined;
		return firstFree(chain.slice(idx + 1), cooldowns, now, blockedModels, fullProviders);
	}
	if (rule.to === "same-tier") {
		if (idx < 0 || chain.length < 2) return undefined;
		for (let step = 1; step < chain.length; step++) {
			const model = chain[(idx + step) % chain.length];
			if (!isCooling(model, cooldowns, now) && !isBlocked(model, blockedModels) && !isBusy(model, fullProviders)) return model;
		}
		return undefined;
	}
	if (rule.to === "downgrade" || rule.to === "escalate") {
		// Tier order is quick < standard < premium by convention.
		const order = ["quick", "standard", "premium"];
		const currentIdx = order.indexOf(previousRoute.tier);
		const delta = rule.to === "escalate" ? 1 : -1;
		const nextTier = order[currentIdx + delta];
		if (!nextTier) return undefined;
		return firstFree(config.tiers?.[nextTier]?.chain, cooldowns, now, blockedModels, fullProviders);
	}
	return undefined;
}

function tierForModel(model, config) {
	for (const [name, tier] of Object.entries(config.tiers ?? {})) {
		if (tier.chain?.includes(model)) return name;
	}
	return undefined;
}

/**
 * Skill set for an interactive session on this model: the model's tier, no ticket adjustments.
 * A model that is not in any chain is unrestricted (the caller keeps every advertised skill).
 */
export function skillsForModel(model, config) {
	const tier = tierForModel(model, config);
	return {
		tier,
		skills: resolveSkills({
			ticket: { skills: [] },
			tier: config.tiers?.[tier],
			skillGroups: config.skillGroups ?? {},
			skillSources: config.skillSources ?? {},
		}),
	};
}

function resolveSkills({ ticket, tier, skillGroups, skillSources }) {
	const warnings = [];
	const granted = new Set(tier?.skills ?? []);

	for (const adjustment of ticket.skills ?? []) {
		if (adjustment.startsWith("+")) {
			const group = adjustment.slice(1);
			ensureGroup(group, skillGroups, ticket);
			granted.add(group);
		} else if (adjustment.startsWith("-")) {
			const group = adjustment.slice(1);
			ensureGroup(group, skillGroups, ticket);
			granted.delete(group);
		} else {
			ensureGroup(adjustment, skillGroups, ticket);
			granted.add(adjustment);
		}
	}

	const paths = groupsToPaths([...granted], skillGroups, skillSources, warnings);
	const preload = groupsToPaths(
		(tier?.preload ?? []).filter((group) => granted.has(group)),
		skillGroups,
		skillSources,
		warnings,
	);

	// Restrict the shift to this set only when skills are configured for the tier or the ticket;
	// otherwise the backend keeps its own skill discovery.
	const restricted = tier?.skills !== undefined || (ticket.skills?.length ?? 0) > 0;
	return { paths, preload, warnings, restricted };
}

function ensureGroup(group, skillGroups, ticket) {
	if (!skillGroups[group]) {
		throw new Error(`ticket ${ticket.feature}/${ticket.number}: unknown skill group "${group}"`);
	}
}

function groupsToPaths(groups, skillGroups, skillSources, warnings) {
	const seen = new Set();
	const paths = [];
	for (const group of groups) {
		for (const sourceName of skillGroups[group] ?? []) {
			if (!skillSources[sourceName]) {
				warnings.push(`unknown skill source "${sourceName}" in group "${group}"`);
				continue;
			}
			const path = skillSources[sourceName];
			if (seen.has(path)) continue;
			seen.add(path);
			paths.push(path);
		}
	}
	return paths;
}
