/**
 * Choose the route for a ticket's next shift. Pure.
 * Order: the ticket's Model → routing[Type] → defaultTier → top-level model.
 * Unknown or missing Types use `defaultType`.
 * Skill groups come from the resolved tier, adjusted by `ticket.skills`, then
 * resolved to paths from `config.skillSources`. Preloaded skills are a subset.
 * @returns {{ backend: "pi", type, tier?, model, thinking, skills: { paths: string[], preload: string[], warnings: string[] } }}
 */
export function planShift({ ticket, config }) {
	const type = ticket.type && config.routing?.[ticket.type] ? ticket.type : config.defaultType;
	const routing = config.routing?.[type];
	const tierName = routing?.model ? undefined : (routing?.tier ?? config.defaultTier);
	const tier = tierName ? config.tiers?.[tierName] : undefined;

	const model = ticket.model ?? routing?.model ?? tier?.chain[0] ?? config.model;
	if (!model) throw new Error(`no route for ticket ${ticket.feature}/${ticket.number} (type "${type}")`);
	const thinking = routing?.thinking ?? tier?.thinking ?? config.thinking;
	const skills = resolveSkills({ ticket, tier, skillGroups: config.skillGroups ?? {}, skillSources: config.skillSources ?? {} });

	return { backend: "pi", type, tier: tierName, model, thinking, skills };
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

	return { paths, preload, warnings };
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
