import { dirname, join, relative } from "node:path";

/** Appended to the backend's system prompt for every shift. */
export const WORKER_PROMPT = `# Shiftwork worker

You are working one ticket in a Shiftwork shift: a fresh context with a single job.

Rules:
- Read the ticket file first, including everything under "## Comments": earlier shifts, verify failures and handoff notes are there.
- Read the feature spec it belongs to when you need the bigger picture. Read CONTEXT.md and docs/adr/ if they exist, and use their vocabulary.
- Do only what this ticket asks. Keep changes small and consistent with the surrounding code.
- The ticket's Verify commands decide whether the ticket is done, not you. Run them yourself before you finish.
- Never edit the ticket's "Status:" line. You may tick checkboxes you completed.
- If you can't continue without information only a human has, stop and write exactly:
  <shiftwork:needs-info reason="one sentence saying what you need"/>
- End with a short summary of what you changed and what, if anything, is left.
`;

/** The user prompt that starts a shift: pointers, not copies. */
export function buildShiftPrompt(ticket, { root, attempt }) {
	const ticketPath = relative(root, ticket.path);
	const specPath = relative(root, join(dirname(dirname(ticket.path)), "spec.md"));
	const lines = [
		`Work Shiftwork ticket ${ticket.feature}/${ticket.number}: ${ticket.title ?? ""}`.trim(),
		"",
		`- Ticket: ${ticketPath}`,
		`- Spec: ${specPath}`,
		`- This is attempt ${attempt}.${attempt > 1 ? " Earlier attempts failed; read the ticket's Comments before you start." : ""}`,
	];
	if (ticket.verify.length) lines.push(`- Verify gate: ${ticket.verify.map((c) => `\`${c}\``).join(" · ")}`);
	return lines.join("\n");
}
