/**
 * Choose the route for a ticket's next shift. Pure.
 * Order: the ticket's Model → routing[Type] → defaultTier → top-level model.
 * Unknown or missing Types use `defaultType`.
 * @returns {{ backend: "pi", type, tier?, model, thinking }}
 */
export function planShift({ ticket, config }) {
	const type = ticket.type && config.routing?.[ticket.type] ? ticket.type : config.defaultType;
	const routing = config.routing?.[type];
	const tierName = routing?.model ? undefined : (routing?.tier ?? config.defaultTier);
	const tier = tierName ? config.tiers?.[tierName] : undefined;

	const model = ticket.model ?? routing?.model ?? tier?.chain[0] ?? config.model;
	if (!model) throw new Error(`no route for ticket ${ticket.feature}/${ticket.number} (type "${type}")`);
	const thinking = routing?.thinking ?? tier?.thinking ?? config.thinking;

	return { backend: "pi", type, tier: tierName, model, thinking };
}
