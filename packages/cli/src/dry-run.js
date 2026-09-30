import { planShift } from "shiftwork-core";

/** Plan each frontier ticket, classifying untyped ones, and print the route. Spends nothing besides classify. */
export async function dryRunFrontier({ tickets, config, cooldowns = [], classifyTicket, log = console.log }) {
	if (!tickets.length) log("Nothing to do: the frontier is empty.");
	for (const ticket of tickets) {
		const classification = await classifyUntyped(ticket, config, classifyTicket);
		const route = planShift({ ticket, config, classification, cooldowns });
		log(formatDryRunLine(ticket, route));
	}
}

export async function classifyUntyped(ticket, config, classifyTicket) {
	if (ticket.type || !classifyTicket || config.jev?.enabled === false) return undefined;
	try {
		return (await classifyTicket(ticket)) ?? null;
	} catch {
		return null;
	}
}

export function formatDryRunLine(ticket, route) {
	if (route.wait) {
		return `${ticket.feature}/${ticket.number}  wait until ${new Date(route.wait).toISOString()}  ${ticket.title ?? ""}`;
	}
	const source = ticket.type ? "" : route.typeSource === "jev" ? " (jev)" : " (default)";
	return `${ticket.feature}/${ticket.number}  type=${route.type}${source}  tier=${route.tier ?? "-"}  model=${route.model}  thinking=${route.thinking}  ${ticket.title ?? ""}`;
}
