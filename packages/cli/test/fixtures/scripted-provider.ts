// Test-only pi extension: registers provider "scripted" whose replies come from $SHIFTWORK_SCRIPT (JSON steps).
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type Step = { text?: string; tool?: { name: string; args: Record<string, unknown> }; error?: string };

export default function (pi: ExtensionAPI) {
	const steps: Step[] = JSON.parse(process.env.SHIFTWORK_SCRIPT ?? "[]");
	const faux = fauxProvider({ provider: "scripted", models: [{ id: "s1", contextWindow: 100_000, maxTokens: 8_000 }] });
	faux.setResponses(
		steps.map((s) =>
			s.error
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: s.error })
				: fauxAssistantMessage(s.tool ? [fauxToolCall(s.tool.name, s.tool.args)] : [fauxText(s.text ?? "")], {
						stopReason: s.tool ? "toolUse" : "stop",
					}),
		),
	);
	pi.registerProvider(faux.provider);

	if (process.env.SHIFTWORK_RECORD_SKILLS) {
		pi.on("before_agent_start", async (event, ctx) => {
			await writeFile(
				join(ctx.cwd, "shiftwork-skills.json"),
				JSON.stringify({ skills: event.systemPromptOptions.skills.map((s) => s.name) }),
			);
		});
	}

	if (process.env.SHIFTWORK_RECORD_SYSTEM) {
		pi.on("before_agent_start", async (event, ctx) => {
			await writeFile(join(ctx.cwd, "shiftwork-system.md"), event.systemPrompt);
		});
	}
}
