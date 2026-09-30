import { dirname, join, relative } from "node:path";

/** Sent to the agent when a shift budget reaches its soft limit. Must stay in sync with WORKER_PROMPT. */
export const SOFT_LIMIT_STEER = `You are near a Shiftwork budget limit. Finish your current step, then append a \`### Handoff\` note to the ticket describing what was done, what remains, hypotheses, and files touched, then stop.`;

/** Sent to the agent when a STOP file appears during a shift. Must stay in sync with WORKER_PROMPT. */
export const STOP_STEER = `The operator asked Shiftwork to stop. Finish your current step, then append a \`### Handoff\` note to the ticket describing what was done, what remains, hypotheses, and files touched, then stop.`;

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
- If you add notes to the ticket, put them under "### Notes"; never write headings that start with "### Shift" (the runner writes those) and write "### Handoff" only when asked for a handoff.
- End with a short summary of what you changed and what, if anything, is left.
- Soft limit: when the runner sends "${SOFT_LIMIT_STEER}", you have up to 2 more turns. Finish your current step, append a \`### Handoff\` note to the ticket's Comments with what was done, what remains, hypotheses, and files touched, then stop.
- STOP: when the runner sends "${STOP_STEER}", you have up to 2 more turns. Finish your current step, append a \`### Handoff\` note to the ticket's Comments with what was done, what remains, hypotheses, and files touched, then stop.
`;

/** Appended to the backend's system prompt for every review shift. */
export const REVIEWER_PROMPT = `# Shiftwork reviewer

You are reviewing one landed ticket in a Shiftwork review shift: a fresh context with a single job.

Rules:
- Read the ticket file first, including everything under "## Comments": shift reports, verify failures and handoff notes are there. Read the feature spec and CONTEXT.md / docs/adr/ if they exist, and use their vocabulary.
- Judge the landed change against the ticket's acceptance criteria, the spec and the repo's standards, not against what you would have written yourself.
- Run the ticket's verify gate yourself before you decide.
- Change no files: a review reports, it never edits code or tickets.
- Put your findings in your final message, and end it with exactly one marker:
  <shiftwork:review verdict="accept|reopen|follow-up" reason="one sentence saying why"/>
- accept: the work is good, nothing more to do. reopen: the ticket is not done — it goes back to ready-for-agent, the landed commit stays, and the next shift fixes forward. follow-up: the work is fine but something worth doing remains — the runner files a new ticket from your reason.
- End with a short summary of what you found.
`;

/** The user prompt that starts a review shift: pointers, not copies. */
export function buildReviewPrompt(ticket, { root, landed, absolute = false }) {
	const spec = ticket.specPath ?? join(dirname(dirname(ticket.path)), "spec.md");
	const ticketPath = absolute ? ticket.path : relative(root, ticket.path);
	const specPath = absolute ? spec : relative(root, spec);
	const lines = [
		`Review the landed Shiftwork ticket ${ticket.feature}/${ticket.number}: ${ticket.title ?? ""}`.trim(),
		"",
		`- Ticket: ${ticketPath}`,
		`- Spec: ${specPath}`,
		"- Diff: the ticket's landed change in this repo — `git log -3 --oneline` and `git show <sha>` for landed commits, or `git status` and `git diff` when the work is uncommitted.",
	];
	if (landed) lines.push(`- Landed: ${landed}`);
	if (ticket.verify.length) lines.push(`- Verify gate: ${ticket.verify.map((c) => `\`${c}\``).join(" · ")}`);
	lines.push(`- End your final message with the review marker described in your instructions.`);
	return lines.join("\n");
}

/** The user prompt that starts a shift: pointers, not copies. */
export function buildShiftPrompt(ticket, { root, attempt, absolute = false }) {
	const spec = ticket.specPath ?? join(dirname(dirname(ticket.path)), "spec.md");
	const ticketPath = absolute ? ticket.path : relative(root, ticket.path);
	const specPath = absolute ? spec : relative(root, spec);
	const lines = [
		`Work Shiftwork ticket ${ticket.feature}/${ticket.number}: ${ticket.title ?? ""}`.trim(),
		"",
		`- Ticket: ${ticketPath}`,
		`- Spec: ${specPath}`,
		...(absolute
			? [
					"- You are in this ticket's own git worktree. Read and update the ticket at the path above, never the copy of .scratch/ inside the worktree.",
				]
			: []),
		`- This is attempt ${attempt}.${attempt > 1 ? " Earlier attempts failed; read the ticket's Comments before you start." : ""}`,
	];
	if (ticket.verify.length) lines.push(`- Verify gate: ${ticket.verify.map((c) => `\`${c}\``).join(" · ")}`);
	return lines.join("\n");
}
