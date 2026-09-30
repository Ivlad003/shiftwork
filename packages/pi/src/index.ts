import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const text = await readFile(join(ctx.cwd, ".pi", "shiftwork.json"), "utf8");
			const config = JSON.parse(text);
			const modelId = ctx.model?.id;
			if (!modelId || !config.tiers) return;

			const skillGroups: Record<string, string[]> = config.skillGroups ?? {};
			const skillSources: Record<string, string> = config.skillSources ?? {};
			const allowed = new Set<string>();
			let matched = false;
			for (const tier of Object.values(config.tiers)) {
				if (!tier.chain?.includes(modelId)) continue;
				matched = true;
				for (const group of tier.skills ?? []) {
					for (const source of skillGroups[group] ?? []) {
						const path = skillSources[source] ?? source;
						allowed.add(isAbsolute(path) ? path : resolve(ctx.cwd, path));
					}
				}
			}
			if (!matched || allowed.size === 0) return;
			event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((skill) => allowed.has(skill.filePath));
		} catch {
			// No project config or invalid JSON: leave skill discovery untouched.
		}
	});
}
