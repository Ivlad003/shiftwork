import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { readIssueState, writeIssueState } from "./github-import.js";

const run = promisify(execFile);

const CLAIMED = "claimed";
const RESOLVED = "resolved";
const NEEDS_INFO = "needs-info";
const READY = "ready-for-agent";

// The labels Shiftwork sets itself (spec: github-watch). `labels.in` hands an
// issue over, so it is never needed here; names come defaulted for a config
// that was not validated (labels.in is only required to *start* dark-factory).
const LABEL_DEFAULTS = { working: "shiftwork:working", needsInfo: "shiftwork:needs-info", done: "shiftwork:done" };

/** The last runner shift report in a ticket: `### Shift N — <backend> <model> (<thinking>)` and its bullets. */
const SHIFT_HEADING = /^### Shift \d+ — \S+ \S+ \([^)]*\)$/gm;

/** The reason of the newest needs-info outcome: `- Outcome: needs-info: …` or `- Stopped: …`. */
const REASON_LINE = /^- (?:Outcome: needs-info|Stopped): (.+)$/gm;

/**
 * Report ticket progress back to the GitHub issue (spec: github-watch, ticket 04).
 *
 * For every imported issue in `.pi/shiftwork-github.json`, compare its feature's
 * tickets with what was already posted (`posted` keys on the issue's state
 * entry) and post only the difference — never re-post, never delete anything:
 *
 * - `working` label + a "Work started" comment when a ticket is first `claimed`;
 * - per resolved ticket, a comment with its title, its latest `### Shift`
 *   report and the landed commits (`git log --grep "shiftwork: <feature>/<NN>"`)
 *   as commit links when `github.push` is on, else the short sha;
 * - a needs-info ticket's reason as a question comment + the `needsInfo` label;
 * - a collaborator's reply after a question: appended to the ticket as
 *   `### Reply from @<login>`, the ticket back to `ready-for-agent`, the
 *   `needsInfo` label removed;
 * - when every ticket is resolved and `autoClose` is on: a summary comment,
 *   the `done` label (dropping `working`) and the issue closed — once.
 *
 * Labels are never created here (they are checked at dark-factory start), and
 * the only labels ever removed are `needsInfo` and `working` (with `done`).
 * Every post is recorded (state written) before the next one, so a crash
 * re-posts at most one comment.
 *
 * @returns {Promise<{ posted: { number: number, key: string }[] }>} the posts made this sync
 */
export async function syncIssues({ root, github, config, tracker, git } = {}) {
	const githubConfig = config?.github ?? {};
	const labels = { ...LABEL_DEFAULTS, ...(githubConfig.labels ?? {}) };
	const autoClose = githubConfig.autoClose ?? true;
	const push = githubConfig.push ?? false;
	const extraAuthors = new Set(githubConfig.authors ?? []);
	const runGit =
		git ?? (async (args) => (await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout);

	const state = await readIssueState(root);
	const posted = [];

	for (const entry of Object.values(state.issues)) {
		const tickets = (await tracker.list())
			.filter((t) => t.feature === entry.feature && t.number && t.path)
			.sort((a, b) => Number(a.number) - Number(b.number));
		if (!tickets.length) continue;

		const wasPosted = (key) => entry.posted.includes(key);
		const post = async (key) => {
			entry.posted.push(key);
			await writeIssueState(root, state);
			posted.push({ number: entry.number, key });
		};

		// A collaborator's reply to a needs-info question (d): the ticket goes back
		// to ready-for-agent with the reply under its `## Comments`.
		for (const t of tickets.filter((t) => t.status === NEEDS_INFO && wasPosted(`needs-info:${t.number}`) && !wasPosted(`replied:${t.number}`))) {
			const comments = await github.issueComments(entry.number);
			const fresh = comments.slice(entry.commentsSeen ?? 0);
			if (!fresh.length) continue;
			for (const reply of fresh) {
				if (!reply.author) continue;
				// Only collaborators and configured authors may steer the work (spec 1).
				const allowed = new Set([...(await github.collaborators()), ...extraAuthors]);
				if (!allowed.has(reply.author)) continue;
				await tracker.appendComment(t, `### Reply from @${reply.author}\n\n${String(reply.body ?? "").trim()}`);
				await tracker.setStatus(t, READY);
				await github.removeLabel(entry.number, labels.needsInfo);
				await post(`replied:${t.number}`);
			}
			// Replies are only ever fresh once, whoever wrote them: remember how far we read.
			entry.commentsSeen = comments.length;
			await writeIssueState(root, state);
		}

		// Work started (a): the working label once, then a comment per first-claimed ticket.
		for (const t of tickets.filter((t) => t.status === CLAIMED && !wasPosted(`started:${t.number}`))) {
			if (!wasPosted("working")) {
				await github.addLabels(entry.number, [labels.working]);
				await post("working");
			}
			await github.comment(entry.number, `**Work started** — ticket ${t.number}: ${t.title}`);
			await post(`started:${t.number}`);
		}

		// Resolved tickets (b): title, latest shift report, landed commits.
		for (const t of tickets.filter((t) => t.status === RESOLVED && !wasPosted(`resolved:${t.number}`))) {
			const markdown = await readFile(t.path, "utf8");
			const repo = push ? (githubConfig.repo ?? (typeof github.repo === "function" ? await github.repo() : undefined)) : undefined;
			const shas = await landedCommits(runGit, entry.feature, t.number);
			await github.comment(entry.number, resolvedComment(t, markdown, shas, repo));
			await post(`resolved:${t.number}`);
		}

		// The needs-info question (c): count the comments first, so the question
		// itself is never mistaken for a reply to it.
		for (const t of tickets.filter((t) => t.status === NEEDS_INFO && !wasPosted(`needs-info:${t.number}`))) {
			const markdown = await readFile(t.path, "utf8");
			entry.commentsSeen = (await github.issueComments(entry.number)).length;
			await writeIssueState(root, state);
			const reason = needsInfoReason(markdown) ?? "the ticket needs information from a collaborator";
			await github.comment(entry.number, `**Ticket ${t.number} needs information: ${t.title}**\n\n${reason}`);
			await post(`needs-info:${t.number}`);
			await github.addLabels(entry.number, [labels.needsInfo]);
		}

		// Everything resolved (e): summary, done label (dropping working), close — once.
		if (autoClose && !wasPosted("done") && tickets.every((t) => t.status === RESOLVED)) {
			await github.close(entry.number, summaryComment(tickets));
			await post("done");
			await github.addLabels(entry.number, [labels.done]);
			if (wasPosted("working")) await github.removeLabel(entry.number, labels.working);
		}
	}

	// The time of the last sync, for the TUI's GitHub tab: written on every
	// sync, posted or not, so a quiet watcher still shows a fresh sync time.
	state.syncedAt = new Date().toISOString();
	await writeIssueState(root, state);

	return { posted };
}

/** The landed commits of one ticket: `git log --grep "shiftwork: <feature>/<NN>" --format=%H`, newest first. */
async function landedCommits(runGit, feature, number) {
	const out = await runGit(["log", "--grep", `shiftwork: ${feature}/${number}`, "--format=%H"]);
	return String(out)
		.split("\n")
		.map((sha) => sha.trim())
		.filter(Boolean);
}

/** The "ticket resolved" comment: the title, the latest shift report and the landed commits. */
function resolvedComment(ticket, markdown, shas, repo) {
	const report = latestShiftReport(markdown);
	const lines = [`**Ticket ${ticket.number} resolved: ${ticket.title}**`, ""];
	if (report) lines.push(report, "");
	lines.push("Landed commits:");
	if (!shas.length) lines.push("- none found");
	for (const sha of shas) {
		lines.push(repo ? `- [${sha.slice(0, 7)}](https://github.com/${repo}/commit/${sha})` : `- \`${sha.slice(0, 7)}\``);
	}
	return lines.join("\n");
}

/** The closing summary comment when every ticket of the issue is resolved. */
function summaryComment(tickets) {
	return ["All tickets of this issue are resolved — closing.", "", ...tickets.map((t) => `- Ticket ${t.number}: ${t.title}`)].join("\n");
}

/**
 * The ticket's latest `### Shift` report: its heading and everything up to the
 * next heading (a later `### Handoff`/`### Notes` block, `## Comments` or the
 * end of the file). Undefined when the ticket has no shift report.
 */
export function latestShiftReport(markdown) {
	const text = String(markdown ?? "");
	const last = [...text.matchAll(SHIFT_HEADING)].at(-1);
	if (!last) return undefined;
	const rest = text.slice(last.index + last[0].length);
	const nextHeading = rest.search(/^#{1,3} /m);
	return `${last[0]}\n${nextHeading === -1 ? rest : rest.slice(0, nextHeading)}`.trim();
}

/** The reason of the ticket's newest needs-info outcome, as written by the runner's shift report. */
export function needsInfoReason(markdown) {
	return [...String(markdown ?? "").matchAll(REASON_LINE)].at(-1)?.[1]?.trim();
}
