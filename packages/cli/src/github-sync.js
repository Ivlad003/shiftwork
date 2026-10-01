import { readFile } from "node:fs/promises";

import { CLAIMED, GITHUB_LABEL_DEFAULTS, READY, RESOLVED } from "shiftwork-core";

import { execIn } from "./exec.js";
import { readIssueState, writeIssueState } from "./github-import.js";
import { parsePostKey, postKey } from "./github-post.js";
import { SHIFTWORK_MARKER } from "./github.js";

const NEEDS_INFO = "needs-info";

/** The last runner shift report in a ticket: `### Shift N — <backend> <model> (<thinking>)` and its bullets. */
const SHIFT_HEADING = /^### Shift \d+ — \S+ \S+ \([^)]*\)$/gm;

/** The reason of the newest needs-info outcome: `- Outcome: needs-info: …` or `- Stopped: …`. */
const REASON_LINE = /^- (?:Outcome: needs-info|Stopped): (.+)$/gm;

/** `#NN` or `NN:` at the start of a reply names the ticket it is for. */
const TICKET_REF = /^\s*(?:#(\d+)(?!\d)|(\d+):(?!\d))/;

/**
 * Report ticket progress back to the GitHub issue (spec: github-watch, ticket 04).
 *
 * For every imported issue in `.pi/shiftwork-github.json`, compare its feature's
 * tickets with what was already posted (`posted` keys on the issue's state
 * entry) and post only the difference — never re-post, never delete anything:
 *
 * - `working` label + a "Work started" comment when a ticket is first `claimed`;
 * - per resolved ticket, a comment with its title, its latest `### Shift`
 *   report and the landed commits (`git log --grep "shiftwork: <feature>/<NN>"`):
 *   each commit a link only when the local remote-tracking refs show it on the
 *   remote (`git branch -r --contains <sha>`, no fetch), else the short sha;
 * - a needs-info ticket's reason as a question comment + the `needsInfo` label,
 *   once per occurrence (`needs-info:NN:<k>`), so a ticket that needs
 *   information again asks again; the question never moves the reply floor;
 * - a collaborator's reply after a question: appended to the ticket (or to
 *   every ticket of the issue that waits on a question, or to the one the
 *   reply names with `#NN`/`NN:` — naming a ticket that isn't waiting gets one
 *   comment back, changing nothing), the ticket back to `ready-for-agent`, and
 *   the `needsInfo` label removed once no ticket of the issue waits any more;
 * - when every ticket is resolved and `autoClose` is on: a summary comment,
 *   the issue closed, the `done` label (dropping `working`) — each its own
 *   key, so a failed close or label is retried without re-posting the comment.
 *
 * Comments are tracked by id (`lastCommentId`), not by count: deleting an
 * earlier comment cannot hide a later reply. The floor moves only when
 * comments are consumed in the reply loop — never when a question is posted —
 * so a reply that lands between two questions of one sync is still seen by
 * the next. Shiftwork's own comments never count as replies: their ids are
 * recorded (`ownComments`) and they end with the hidden `<!-- shiftwork -->`
 * marker. Labels are never created here (they are checked at dark-factory
 * start), and the only labels ever removed are `needsInfo` and `working` (with
 * `done`). Every post is recorded (state written) before the next one, so a
 * crash re-posts at most one comment.
 *
 * @returns {Promise<{ posted: { number: number, key: string }[] }>} the posts made this sync
 */
export async function syncIssues({ root, github, config, tracker, git } = {}) {
	const githubConfig = config?.github ?? {};
	// A validated config already has the label names; the defaults cover a caller
	// that passed labels partially (`labels.in` is only required to start dark-factory).
	const labels = { ...GITHUB_LABEL_DEFAULTS, ...(githubConfig.labels ?? {}) };
	const autoClose = githubConfig.autoClose;
	const extraAuthors = new Set(githubConfig.authors ?? []);
	const runGit = git ?? ((args) => execIn(root)(["git", ...args]));
	// Collaborators are fetched at most once per sync, however many replies arrive.
	let collaborators;
	const allowedAuthors = async () => {
		collaborators ??= new Set([...(await github.collaborators()), ...extraAuthors]);
		return collaborators;
	};

	const state = await readIssueState(root);
	const posted = [];

	for (const entry of Object.values(state.issues)) {
		if (!Array.isArray(entry.ownComments)) entry.ownComments = [];

		// A legacy `commentsSeen` count migrates to `lastCommentId`: every
		// comment that exists now counts as seen.
		if (entry.commentsSeen !== undefined) {
			delete entry.commentsSeen;
			if (entry.lastCommentId == null) entry.lastCommentId = maxCommentId(await github.issueComments(entry.number)) ?? 0;
			await writeIssueState(root, state);
		}

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
		/** Post a comment and remember its id, so Shiftwork's own comments never count as replies. */
		const postComment = async (body) => {
			const id = await github.comment(entry.number, body);
			if (Number.isFinite(Number(id))) entry.ownComments.push(Number(id));
			return id;
		};
		// Questions and replies are keyed per occurrence (`needs-info:NN:<k>` /
		// `replied:NN:<k>`): a ticket that needs information again asks again.
		const occurrences = (kind, ticket) =>
			entry.posted.filter((key) => {
				const parsed = parsePostKey(key);
				return parsed.kind === kind && parsed.ticket === ticket && parsed.n !== undefined;
			}).length;
		const questions = (t) => occurrences("needs-info", t.number);
		const answers = (t) => occurrences("replied", t.number);
		const waiting = () => tickets.filter((t) => t.status === NEEDS_INFO && questions(t) > answers(t));

		// A collaborator's reply to a needs-info question (d): every ticket of the
		// issue that waits on a question gets it, or the one it names with
		// `#NN`/`NN:`; each goes back to ready-for-agent with the reply under its
		// `## Comments`.
		if (waiting().length) {
			const comments = await github.issueComments(entry.number);
			const own = (c) => entry.ownComments.includes(Number(c.id)) || String(c.body ?? "").includes(SHIFTWORK_MARKER);
			for (const reply of comments.filter((c) => Number(c.id) > (entry.lastCommentId ?? 0))) {
				if (own(reply) || !reply.author) continue;
				// Only collaborators and configured authors may steer the work (spec 1).
				const allowed = await allowedAuthors();
				if (!allowed.has(reply.author)) continue;
				const named = parseTicketRef(reply.body);
				const targets = named === undefined ? waiting() : waiting().filter((t) => Number(t.number) === named);
				// A reply naming a ticket that isn't waiting: one comment back, no ticket changed.
				if (named !== undefined && !targets.length) {
					await postComment(notWaitingComment(named, waiting()));
					continue;
				}
				for (const t of targets) {
					await tracker.appendComment(t, `### Reply from @${reply.author}\n\n${String(reply.body ?? "").trim()}`);
					await tracker.setStatus(t, READY);
					t.status = READY; // the same sync's later loops look at these tickets too
					await post(postKey("replied", t.number, answers(t) + 1));
				}
			}
			// Every comment is consumed now, whoever wrote it: the newest id is
			// where the next sync starts, so a deleted comment hides nothing.
			entry.lastCommentId = maxCommentId(comments) ?? entry.lastCommentId;
			await writeIssueState(root, state);
			// The needsInfo label goes once no ticket of the issue waits any more.
			if (!waiting().length) await github.removeLabel(entry.number, labels.needsInfo);
		}

		// Work started (a): the working label once, then a comment per first-claimed ticket.
		for (const t of tickets.filter((t) => t.status === CLAIMED && !wasPosted(postKey("started", t.number)))) {
			if (!wasPosted(postKey("working"))) {
				await github.addLabels(entry.number, [labels.working]);
				await post(postKey("working"));
			}
			await postComment(`**Work started** — ticket ${t.number}: ${t.title}`);
			await post(postKey("started", t.number));
		}

		// Resolved tickets (b): title, latest shift report, landed commits.
		for (const t of tickets.filter((t) => t.status === RESOLVED && !wasPosted(postKey("resolved", t.number)))) {
			const markdown = await readFile(t.path, "utf8");
			const shas = await landedCommits(runGit, entry.feature, t.number);
			// Per commit, not per run: a commit is linked only once the local
			// remote-tracking refs show it on the remote (a push that has not
			// landed yet, or failed, shows the short sha).
			const onRemote = await Promise.all(shas.map((sha) => isOnRemote(runGit, sha)));
			const repo = onRemote.some(Boolean)
				? githubConfig.repo ?? (typeof github.repo === "function" ? await github.repo() : undefined)
				: undefined;
			await postComment(resolvedComment(t, markdown, shas, onRemote, repo));
			await post(postKey("resolved", t.number));
		}

		// The needs-info question (c), once per occurrence: fresh comments are the
		// ones after the question, so the question itself is never a reply to it.
		for (const t of tickets.filter((t) => t.status === NEEDS_INFO && questions(t) === answers(t))) {
			const markdown = await readFile(t.path, "utf8");
			const reason = needsInfoReason(markdown) ?? "the ticket needs information from a collaborator";
			// The question never moves the reply floor: it is Shiftwork's own
			// (its id is recorded in `ownComments`, and the marker ends it), so a
			// reply posted between two questions of this sync is still seen by the next.
			await postComment(`**Ticket ${t.number} needs information: ${t.title}**\n\n${reason}`);
			await writeIssueState(root, state);
			await post(postKey("needs-info", t.number, questions(t) + 1));
			await github.addLabels(entry.number, [labels.needsInfo]);
		}

		// Everything resolved (e): summary comment, close, done label (dropping
		// working) — each its own key, so a failed close or label is retried next
		// sync without re-posting the comment.
		if (autoClose && tickets.every((t) => t.status === RESOLVED)) {
			if (!wasPosted(postKey("summary"))) {
				await postComment(summaryComment(tickets));
				await post(postKey("summary"));
			}
			if (!wasPosted(postKey("done"))) {
				await github.close(entry.number);
				await post(postKey("done"));
			}
			if (!wasPosted(postKey("done-label"))) {
				await github.addLabels(entry.number, [labels.done]);
				await post(postKey("done-label"));
			}
			if (wasPosted(postKey("working")) && !wasPosted(postKey("working-removed"))) {
				await github.removeLabel(entry.number, labels.working);
				await post(postKey("working-removed"));
			}
		}
	}

	// The time of the last sync, for the TUI's GitHub tab: written on every
	// sync, posted or not, so a quiet watcher still shows a fresh sync time.
	state.syncedAt = new Date().toISOString();
	await writeIssueState(root, state);

	return { posted };
}

/**
 * The ticket number a reply names with `#NN` or `NN:` at the start, or
 * undefined when it names none (then every waiting ticket gets the reply).
 */
export function parseTicketRef(body) {
	const match = String(body ?? "").match(TICKET_REF);
	return match ? Number(match[1] ?? match[2]) : undefined;
}

/** The newest comment id in `comments`, or null when there are none. */
function maxCommentId(comments) {
	let max = null;
	for (const c of comments) {
		const id = Number(c?.id);
		if (Number.isFinite(id) && (max === null || id > max)) max = id;
	}
	return max;
}

/** Whether the local remote-tracking refs show the commit on the remote (`git branch -r --contains`, no fetch). */
async function isOnRemote(runGit, sha) {
	return String(await runGit(["branch", "-r", "--contains", sha])).trim().length > 0;
}

/** The landed commits of one ticket: `git log --grep "shiftwork: <feature>/<NN>" --format=%H`, newest first. */
async function landedCommits(runGit, feature, number) {
	const out = await runGit(["log", "--grep", `shiftwork: ${feature}/${number}`, "--format=%H"]);
	return String(out)
		.split("\n")
		.map((sha) => sha.trim())
		.filter(Boolean);
}

/** The "ticket resolved" comment: the title, the latest shift report and the landed commits (each linked only when it is on the remote). */
function resolvedComment(ticket, markdown, shas, onRemote, repo) {
	const report = latestShiftReport(markdown);
	const lines = [`**Ticket ${ticket.number} resolved: ${ticket.title}**`, ""];
	if (report) lines.push(report, "");
	lines.push("Landed commits:");
	if (!shas.length) lines.push("- none found");
	shas.forEach((sha, i) => {
		lines.push(onRemote[i] && repo ? `- [${sha.slice(0, 7)}](https://github.com/${repo}/commit/${sha})` : `- \`${sha.slice(0, 7)}\``);
	});
	return lines.join("\n");
}

/** The comment back when a reply names a ticket that isn't waiting for an answer. */
function notWaitingComment(number, waiting) {
	// The named number is padded like a ticket number (`07`, not `7`).
	const named = String(number).padStart(2, "0");
	const tickets = waiting.map((t) => t.number).join(", ");
	return `Ticket ${named} isn't waiting for an answer; ${tickets ? `the waiting tickets are: ${tickets}` : "no ticket is waiting"}`;
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
