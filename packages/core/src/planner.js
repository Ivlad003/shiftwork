/**
 * Choose the route for a ticket's next shift. Pure.
 * Order: the ticket's Model → routing[Type] → defaultTier → top-level model.
 * Unknown or missing Types use `defaultType`.
 * Skill groups come from the resolved tier, adjusted by `ticket.skills`, then
 * resolved to paths from `config.skillSources`. Preloaded skills are a subset.
 * Budgets merge model → tier → default, then are capped by the ticket budget.
 * @returns {{ backend: "pi", type, tier?, model, thinking, skills: { paths: string[], preload: string[], warnings: string[], restricted: boolean }, budget: object, onExceed: object }}
 */
export function planShift({ ticket, config, history = {} }) {
	const type = ticket.type && config.routing?.[ticket.type] ? ticket.type : config.defaultType;
	const routing = config.routing?.[type];
	const tierName = routing?.model ? undefined : (routing?.tier ?? config.defaultTier);
	const tier = tierName ? config.tiers?.[tierName] : undefined;

	const model = ticket.model ?? routing?.model ?? tier?.chain[0] ?? config.model;
	if (!model) throw new Error(`no route for ticket ${ticket.feature}/${ticket.number} (type "${type}")`);
	const thinking = routing?.thinking ?? tier?.thinking ?? config.thinking;
	const skills = resolveSkills({ ticket, tier, skillGroups: config.skillGroups ?? {}, skillSources: config.skillSources ?? {} });

	const baseBudget = mergeBudgets(
		config.budgets?.default,
		tier?.budget,
		config.budgets?.models?.[model],
	);
	const ticketBudget = resolveTicketBudget(ticket, config);
	const budget = capBudget(baseBudget, ticketBudget);

	const onExceed = config.onExceed ?? {};
	if (history.exceededKind && history.previousRoute) {
		const nextModel = chooseHandoffTarget({ previousRoute: history.previousRoute, kind: history.exceededKind, config });
		if (nextModel) {
			const nextTier = tierForModel(nextModel, config);
			return {
				backend: "pi",
				type,
				tier: nextTier,
				model: nextModel,
				thinking: config.tiers?.[nextTier]?.thinking ?? thinking,
				skills: resolveSkills({ ticket, tier: config.tiers?.[nextTier], skillGroups: config.skillGroups ?? {}, skillSources: config.skillSources ?? {} }),
				budget: capBudget(
					mergeBudgets(config.budgets?.default, config.tiers?.[nextTier]?.budget, config.budgets?.models?.[nextModel]),
					capBudgetRemaining(ticketBudget, history.ticketUsage),
				),
				onExceed,
			};
		}
	}

	return { backend: "pi", type, tier: tierName, model, thinking, skills, budget, onExceed };
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
	return mergeBudgets(fromConfig, fromTicket);
}

function parseTicketBudget(value) {
	if (!value) return undefined;
	const out = {};
	const cost = value.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (cost) out.maxCostUsd = Number(cost[1]);
	const tokens = value.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:tokens?|tok)\b/i);
	if (tokens) out.maxTokens = Number(tokens[1]);
	const turns = value.match(/([0-9]+)\s*(?:turns?|hod|ход(?:ів|а|и)?)\b/i);
	if (turns) out.maxTurns = Number(turns[1]);
	const minutes = value.match(/([0-9]+)\s*(?:min|minutes?|хв)\b/i);
	if (minutes) out.maxWallMin = Number(minutes[1]);
	const context = value.match(/([0-9]+)\s*%\s*(?:context|ctx)\b/i);
	if (context) out.maxContextPct = Number(context[1]);
	const stall = value.match(/(?:stall\s*)?([0-9]+)\s*(?:stall|застій)/i);
	if (stall) out.stallTurns = Number(stall[1]);
	return Object.keys(out).length ? out : undefined;
}

function chooseHandoffTarget({ previousRoute, kind, config }) {
	const rule = config.onExceed?.[kind];
	if (!rule?.to) return undefined;
	const tier = config.tiers?.[previousRoute.tier];
	const chain = tier?.chain ?? [];
	const idx = chain.indexOf(previousRoute.model);
	if (rule.to === "next") {
		if (idx >= 0 && idx + 1 < chain.length) return chain[idx + 1];
		return undefined;
	}
	if (rule.to === "same-tier") {
		if (idx >= 0 && chain.length > 1) {
			return chain[(idx + 1) % chain.length];
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
		return config.tiers?.[nextTier]?.chain?.[0];
	}
	return undefined;
}

function tierForModel(model, config) {
	for (const [name, tier] of Object.entries(config.tiers ?? {})) {
		if (tier.chain?.includes(model)) return name;
	}
	return undefined;
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
