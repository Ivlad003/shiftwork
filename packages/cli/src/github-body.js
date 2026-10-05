/** The questions block Shiftwork writes into a GitHub issue body while work waits. */
export const QUESTIONS_START = "<!-- shiftwork:questions:start -->";
export const QUESTIONS_END = "<!-- shiftwork:questions:end -->";

/**
 * The issue body without Shiftwork's questions block. A human edit of the
 * description is this text changing; an edit of the questions block is not.
 */
export function bodyWithoutQuestions(body) {
	const text = String(body ?? "");
	const start = text.indexOf(QUESTIONS_START);
	const end = text.indexOf(QUESTIONS_END);
	if (start === -1 || end === -1 || end < start) return text.trim();
	return `${text.slice(0, start)}${text.slice(end + QUESTIONS_END.length)}`.trim();
}

/** The issue body with one questions block at the end, replaced when it is already there. */
export function upsertQuestions(body, items) {
	const stripped = bodyWithoutQuestions(body).trim();
	if (!items.length) return stripped;
	const section = [
		QUESTIONS_START,
		"## Questions for this issue",
		"",
		"Shiftwork cannot continue until these are answered. Reply in a comment, or edit the description above this section.",
		"",
		...items.map((item) => `- **Ticket ${item.number} — ${item.title}:** ${item.reason}`),
		QUESTIONS_END,
	].join("\n");
	return stripped ? `${stripped}\n\n${section}\n` : `${section}\n`;
}

/** Where a spec section ends: the next `##` heading or the tickets table, whichever comes first. */
function sectionCut(rest) {
	const heading = rest.search(/^## /m);
	const table = rest.search(/^<!-- shiftwork:tickets:start -->/m);
	const cuts = [heading, table].filter((index) => index >= 0);
	return cuts.length ? Math.min(...cuts) : rest.length;
}

/** Replace the spec's `## Issue` section. The tickets table and later headings stay. */
export function replaceIssueSection(spec, body) {
	const text = String(spec ?? "");
	const chunk = `${String(body ?? "").trim()}\n`;
	const match = /^## Issue[ \t]*$/m.exec(text);
	if (!match) return `${text.trimEnd()}\n\n## Issue\n\n${chunk}`;
	const rest = text.slice(match.index + match[0].length);
	const end = sectionCut(rest);
	const after = rest.slice(end).replace(/^\n/, "");
	return `${text.slice(0, match.index)}## Issue\n\n${chunk}\n${after}`;
}

/** Append one clarification under `## Clarifications`, above the tickets table. */
export function appendClarification(spec, { heading, text }) {
	const block = `### ${heading}\n\n${String(text ?? "").trim()}\n`;
	const section = `## Clarifications\n\n${block}`;
	const match = /^## Clarifications[ \t]*$/m.exec(spec);
	if (!match) {
		const table = spec.search(/^<!-- shiftwork:tickets:start -->/m);
		if (table === -1) return `${spec.trimEnd()}\n\n${section}`;
		return `${spec.slice(0, table).trimEnd()}\n\n${section}\n${spec.slice(table)}`;
	}
	const rest = spec.slice(match.index + match[0].length);
	const end = sectionCut(rest);
	const merged = `${rest.slice(0, end).trimEnd()}\n\n${block}`;
	const after = rest.slice(end).replace(/^\n/, "");
	return `${spec.slice(0, match.index)}## Clarifications\n\n${merged.trim()}\n\n${after}`;
}
