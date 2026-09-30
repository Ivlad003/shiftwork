import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { frontier, loadTickets } from "shiftwork-core";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("shift", {
		description: "Shiftwork: show tickets and the frontier of ready ones",
		handler: async (_args, ctx) => {
			const tickets = await loadTickets(ctx.cwd);
			if (tickets.length === 0) {
				ctx.ui.notify("Shiftwork: no tickets in .scratch/<feature>/issues/*.md", "info");
				return;
			}
			const ready = frontier(tickets);
			const lines = ready.map((t) => `→ ${t.feature}/${t.number} ${t.title ?? ""}`);
			ctx.ui.notify(`Shiftwork: ${ready.length} ready of ${tickets.length}\n${lines.join("\n")}`, "info");
		},
	});
}
