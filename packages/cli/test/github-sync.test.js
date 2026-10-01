import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openTracker, parseTicket } from "shiftwork-core";

import { readIssueState, writeIssueState } from "../src/github-import.js";
import { latestShiftReport, needsInfoReason, parseTicketRef, syncIssues } from "../src/github-sync.js";
import { SHIFTWORK_MARKER } from "../src/github.js";

const run = promisify(execFile);

/** Every op a stub `github` may see: no test ever calls a delete endpoint. */
const OPS = ["repo", "collaborators", "issueComments", "comment", "addLabels", "removeLabel", "close"];

function assertNoDeletes(calls) {
	const unknown = calls.map((c) => c.op).filter((op) => !OPS.includes(op));
	assert.deepEqual(unknown, [], `unexpected github op (a delete endpoint?): ${JSON.stringify(calls)}`);
}

/**
 * A stub GitHub: records every call, answers comments from the shared
 * `comments` array. Posted comments land in it, like on GitHub, with an id
 * one above the newest — so a test's own pushes just use higher ids.
 */
function stubGitHub({ collaborators = ["octocat"], comments = [] } = {}) {
	const calls = [];
	const nextId = () => 1 + comments.reduce((max, c) => Math.max(max, Number(c.id) || 0), 1000);
	const github = {
		async repo() {
			calls.push({ op: "repo", args: [] });
			return "owner/name";
		},
		async collaborators() {
			calls.push({ op: "collaborators", args: [] });
			return [...collaborators];
		},
		async issueComments(n) {
			calls.push({ op: "issueComments", args: [n] });
			return [...comments];
		},
		async comment(n, body) {
			calls.push({ op: "comment", args: [n, body] });
			const id = nextId();
			comments.push({ id, author: "octocat", body, createdAt: new Date().toISOString() });
			return id;
		},
		async addLabels(n, labels) {
			calls.push({ op: "addLabels", args: [n, [...labels]] });
			return "";
		},
		async removeLabel(n, label) {
			calls.push({ op: "removeLabel", args: [n, label] });
			return "";
		},
		async close(n, body) {
			calls.push({ op: "close", args: [n, body] });
			return "";
		},
	};
	return { github, calls };
}

/** A temp repo root: a real git repo with one initial commit. */
async function makeRoot() {
	const dir = await mkdtemp(join(tmpdir(), "sw-sync-"));
	await run("git", ["init", "-q"], { cwd: dir });
	await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await run("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "README.md"), "# test\n");
	await run("git", ["add", "-A"], { cwd: dir });
	await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

/** A landed commit of the shape the runner makes; resolves its full sha. */
async function commit(root, message) {
	await writeFile(join(root, `tick-${Math.random().toString(36).slice(2)}`), message);
	await run("git", ["add", "-A"], { cwd: root });
	await run("git", ["commit", "-q", "-m", message], { cwd: root });
	return (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

/** A ticket on disk under `.scratch/<feature>/issues/`, optionally with a `## Comments` section. */
async function writeTicket(root, feature, { number, title, status, comments = "" }) {
	const path = join(root, ".scratch", feature, "issues", `${number}-ticket.md`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		[`# ${number}: ${title}`, "", "**What to build:** Something.", "", `**Status:** ${status}`, "", comments, ""].join("\n"),
	);
	return path;
}

/** One imported issue in `.pi/shiftwork-github.json`, as `importIssues` writes it (a legacy `commentsSeen` optional). */
async function seedState(root, feature, { number = 8, posted = [], commentsSeen, lastCommentId = null } = {}) {
	await writeIssueState(root, {
		issues: {
			[String(number)]: {
				number,
				feature,
				importedAt: "2026-10-01T10:00:00.000Z",
				...(commentsSeen !== undefined && { commentsSeen }),
				lastCommentId,
				ownComments: [],
				posted,
			},
		},
	});
}

const shiftReport = (outcome) =>
	["## Comments", "", "### Shift 1 — pi claude-4-sonnet (medium)", "- Ended: done", "- Usage: 100 in / 50 out tokens, $0.0100, 5 turns", `- Outcome: ${outcome}`].join("\n");

const sync = (dir, github, config) => syncIssues({ root: dir, github, config, tracker: openTracker(dir) });

test("claimed → one started comment with the working label; resolved → one comment with the report and the commit link; a second sync posts nothing", async () => {
	const dir = await makeRoot();
	const feature = "gh-8-fix-the-thing";
	await seedState(dir, feature);
	await writeTicket(dir, feature, { number: "02", title: "Fix the thing", status: "claimed" });
	const { github, calls } = stubGitHub();
	const config = { github: { repo: "owner/name", push: true, autoClose: false } };

	await sync(dir, github, config);

	assert.equal(calls.filter((c) => c.op === "comment").length, 1);
	assert.match(calls.find((c) => c.op === "comment").args[1], /\*\*Work started\*\* — ticket 02: Fix the thing/);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:working"]]);
	assert.deepEqual(calls.filter((c) => c.op === "close"), []);

	// The ticket resolves with a landed commit: one comment with title, report and commit link.
	const sha = await commit(dir, `shiftwork: ${feature}/02 Fix the thing`);
	await writeTicket(dir, feature, { number: "02", title: "Fix the thing", status: "resolved", comments: shiftReport("resolved") });
	await sync(dir, github, config);

	const resolved = calls.filter((c) => c.op === "comment" && /Ticket 02 resolved/.test(c.args[1]));
	assert.equal(resolved.length, 1);
	assert.match(resolved[0].args[1], /\*\*Ticket 02 resolved: Fix the thing\*\*/);
	assert.match(resolved[0].args[1], /^### Shift 1 — pi claude-4-sonnet \(medium\)$/m);
	assert.match(resolved[0].args[1], new RegExp(`\\[${sha.slice(0, 7)}\\]\\(https://github\\.com/owner/name/commit/${sha}\\)`));

	// Nothing new on disk → a second sync posts nothing at all.
	const before = calls.length;
	await sync(dir, github, config);
	assert.equal(calls.length, before);

	const state = await readIssueState(dir);
	assert.deepEqual([...state.issues["8"].posted].sort(), ["resolved:02", "started:02", "working"].sort());
	// Every comment Shiftwork posted is remembered by id, so it never counts as a reply.
	assert.deepEqual(state.issues["8"].ownComments.length, 2);
	// Every sync, posted or not, records the time of the last sync (the TUI's GitHub tab).
	assert.match(state.syncedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assertNoDeletes(calls);
});

test("with github.push off, the resolved comment shows the short sha and no link", async () => {
	const dir = await makeRoot();
	const feature = "gh-9-other-thing";
	await seedState(dir, feature, { number: 9 });
	const sha = await commit(dir, `shiftwork: ${feature}/02 Other thing`);
	await writeTicket(dir, feature, { number: "02", title: "Other thing", status: "resolved", comments: shiftReport("resolved") });
	const { github, calls } = stubGitHub();
	const config = { github: { repo: "owner/name", push: false, autoClose: false } };

	await sync(dir, github, config);

	const body = calls.find((c) => c.op === "comment").args[1];
	assert.match(body, new RegExp(`- \`${sha.slice(0, 7)}\``));
	assert.doesNotMatch(body, /github\.com\/.*\/commit\//);
	assertNoDeletes(calls);
});

test("with github.push on but linkCommits false (the last push failed), the resolved comment shows the short sha", async () => {
	const dir = await makeRoot();
	const feature = "gh-22-unpushed-thing";
	await seedState(dir, feature, { number: 22 });
	const sha = await commit(dir, `shiftwork: ${feature}/02 Unpushed thing`);
	await writeTicket(dir, feature, { number: "02", title: "Unpushed thing", status: "resolved", comments: shiftReport("resolved") });
	const { github, calls } = stubGitHub();
	const config = { github: { repo: "owner/name", push: true, autoClose: false } };

	await syncIssues({ root: dir, github, config, tracker: openTracker(dir), linkCommits: false });

	const body = calls.find((c) => c.op === "comment").args[1];
	assert.match(body, new RegExp(`- \`${sha.slice(0, 7)}\``));
	assert.doesNotMatch(body, /github\.com\/.*\/commit\//);
	assertNoDeletes(calls);
});

test("needs-info → one question comment with the reason and the needs-info label", async () => {
	const dir = await makeRoot();
	const feature = "gh-10-unclear-work";
	await seedState(dir, feature, { number: 10 });
	await writeTicket(dir, feature, { number: "03", title: "Unclear work", status: "needs-info", comments: shiftReport("needs-info: Which database should this target?") });
	const { github, calls } = stubGitHub();
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config);

	const body = calls.find((c) => c.op === "comment").args[1];
	assert.match(body, /\*\*Ticket 03 needs information: Unclear work\*\*/);
	assert.match(body, /Which database should this target\?/);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:needs-info"]]);

	const state = await readIssueState(dir);
	assert.deepEqual(state.issues["10"].posted, ["needs-info:03:1"]);
	// The question's id is where fresh replies start, and it is Shiftwork's own.
	assert.equal(state.issues["10"].lastCommentId, 1001);
	assert.deepEqual(state.issues["10"].ownComments, [1001]);
	assertNoDeletes(calls);
});

test("a collaborator's reply is appended to the ticket and it goes back to ready-for-agent", async () => {
	const dir = await makeRoot();
	const feature = "gh-11-answered-work";
	await seedState(dir, feature, { number: 11 });
	const path = await writeTicket(dir, feature, { number: "03", title: "Answered work", status: "needs-info", comments: shiftReport("needs-info: Which database?") });
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config);
	assert.equal(calls.filter((c) => c.op === "comment").length, 1);

	comments.push({ id: 2001, author: "octocat", body: "Use Postgres.", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);

	// The question is not re-asked, the reply is on the ticket and it is ready again.
	assert.equal(calls.filter((c) => c.op === "comment").length, 1);
	const ticket = await readFile(path, "utf8");
	assert.match(ticket, /^### Reply from @octocat$/m);
	assert.match(ticket, /Use Postgres\./);
	assert.equal(parseTicket(ticket).status, "ready-for-agent");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info"]);

	const state = await readIssueState(dir);
	assert.deepEqual([...state.issues["11"].posted].sort(), ["needs-info:03:1", "replied:03:1"].sort());
	assert.equal(state.issues["11"].lastCommentId, 2001);
	assertNoDeletes(calls);
});

test("Shiftwork's own later comments never count as replies; a collaborator's does", async () => {
	const dir = await makeRoot();
	const feature = "gh-15-own-comments";
	await seedState(dir, feature, { number: 15 });
	const path = await writeTicket(dir, feature, { number: "02", title: "Waiting work", status: "needs-info", comments: shiftReport("needs-info: Which database?") });
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	// The question, then a later Shiftwork comment: work starts on another ticket.
	await sync(dir, github, config);
	await writeTicket(dir, feature, { number: "04", title: "Other work", status: "claimed" });
	await sync(dir, github, config);

	// A Shiftwork-looking comment with an unknown id but the hidden marker, then a collaborator's reply.
	comments.push({ id: 2001, author: "octocat", body: `Work started on something ${SHIFTWORK_MARKER}`, createdAt: "2026-10-01T12:00:00Z" });
	comments.push({ id: 2002, author: "octocat", body: "Use Postgres.", createdAt: "2026-10-01T13:00:00Z" });
	await sync(dir, github, config);

	// Only the reply landed: neither own comment did.
	const ticket = await readFile(path, "utf8");
	assert.match(ticket, /^### Reply from @octocat$/m);
	assert.match(ticket, /Use Postgres\./);
	assert.doesNotMatch(ticket, /Work started on something/);
	assert.doesNotMatch(ticket, /<!-- shiftwork -->/);
	assert.equal(parseTicket(ticket).status, "ready-for-agent");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info"]);
	assertNoDeletes(calls);
});

test("a non-collaborator's reply is ignored; a collaborator's still lands after it", async () => {
	const dir = await makeRoot();
	const feature = "gh-12-guarded-work";
	await seedState(dir, feature, { number: 12 });
	const path = await writeTicket(dir, feature, { number: "04", title: "Guarded work", status: "needs-info", comments: shiftReport("needs-info: Which cloud?") });
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config);

	comments.push({ id: 2001, author: "rando", body: "Also AWS?", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);

	let ticket = await readFile(path, "utf8");
	assert.doesNotMatch(ticket, /### Reply from/);
	assert.equal(parseTicket(ticket).status, "needs-info");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel"), []);

	// The ignored reply is not reconsidered; the next collaborator reply lands.
	comments.push({ id: 2002, author: "octocat", body: "Use AWS.", createdAt: "2026-10-01T13:00:00Z" });
	await sync(dir, github, config);

	ticket = await readFile(path, "utf8");
	assert.match(ticket, /^### Reply from @octocat$/m);
	assert.match(ticket, /Use AWS\./);
	assert.doesNotMatch(ticket, /Also AWS\?/);
	assert.equal(parseTicket(ticket).status, "ready-for-agent");
	assertNoDeletes(calls);
});

test("a reply names one waiting ticket with #NN; a deleted comment does not hide a later reply", async () => {
	const dir = await makeRoot();
	const feature = "gh-16-named-replies";
	await seedState(dir, feature, { number: 16 });
	const path02 = await writeTicket(dir, feature, { number: "02", title: "First wait", status: "needs-info", comments: shiftReport("needs-info: Which database?") });
	const path03 = await writeTicket(dir, feature, { number: "03", title: "Second wait", status: "needs-info", comments: shiftReport("needs-info: Which cloud?") });
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	// Two waiting tickets, two questions.
	await sync(dir, github, config);
	assert.equal(calls.filter((c) => c.op === "comment").length, 2);

	// A reply naming ticket 02: only 02 gets it, 03 still waits, so the label stays.
	comments.push({ id: 2001, author: "octocat", body: "#02: Use Postgres.", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);

	const first = await readFile(path02, "utf8");
	assert.match(first, /^### Reply from @octocat$/m);
	assert.match(first, /Use Postgres\./);
	const second = await readFile(path03, "utf8");
	assert.doesNotMatch(second, /### Reply from/);
	assert.equal(parseTicket(second).status, "needs-info");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel"), []);

	// The named reply is deleted on GitHub; a new reply with a higher id still
	// lands (a count would have missed it: the number of comments did not grow).
	comments.pop();
	comments.push({ id: 3000, author: "octocat", body: "Use AWS.", createdAt: "2026-10-01T13:00:00Z" });
	await sync(dir, github, config);

	const ticket03 = await readFile(path03, "utf8");
	assert.match(ticket03, /^### Reply from @octocat$/m);
	assert.match(ticket03, /Use AWS\./);
	assert.equal(parseTicket(ticket03).status, "ready-for-agent");
	// The label went once, when the last waiting ticket got its reply.
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info"]);
	assertNoDeletes(calls);
});

test("a ticket that needs information again asks again, and each question gets its reply", async () => {
	const dir = await makeRoot();
	const feature = "gh-17-ask-twice";
	await seedState(dir, feature, { number: 17 });
	const path = await writeTicket(dir, feature, { number: "03", title: "Ask twice", status: "needs-info", comments: shiftReport("needs-info: Which database?") });
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	// The first question, its reply, then the ticket needs information again.
	await sync(dir, github, config);
	comments.push({ id: 2001, author: "octocat", body: "Use Postgres.", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);
	assert.equal(parseTicket(await readFile(path, "utf8")).status, "ready-for-agent");

	await writeTicket(dir, feature, { number: "03", title: "Ask twice", status: "needs-info", comments: shiftReport("needs-info: Which schema?") });
	await sync(dir, github, config);

	// Two questions, one per occurrence, and the label went on for each.
	const questions = calls.filter((c) => c.op === "comment").map((c) => c.args[1]);
	assert.equal(questions.length, 2);
	assert.match(questions[0], /Which database\?/);
	assert.match(questions[1], /Which schema\?/);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:needs-info"], ["shiftwork:needs-info"]]);

	// The second reply answers the second question.
	comments.push({ id: 3000, author: "octocat", body: "public.", createdAt: "2026-10-01T14:00:00Z" });
	await sync(dir, github, config);

	const ticket = await readFile(path, "utf8");
	assert.match(ticket, /public\./);
	assert.equal(parseTicket(ticket).status, "ready-for-agent");
	const state = await readIssueState(dir);
	assert.deepEqual(state.issues["17"].posted, ["needs-info:03:1", "replied:03:1", "needs-info:03:2", "replied:03:2"]);
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info", "shiftwork:needs-info"]);
	assertNoDeletes(calls);
});

test("two waiting tickets both get a generic reply; the needs-info label is removed once", async () => {
	const dir = await makeRoot();
	const feature = "gh-18-two-waits";
	await seedState(dir, feature, { number: 18 });
	const path02 = await writeTicket(dir, feature, { number: "02", title: "First wait", status: "needs-info", comments: shiftReport("needs-info: Which database?") });
	const path03 = await writeTicket(dir, feature, { number: "03", title: "Second wait", status: "needs-info", comments: shiftReport("needs-info: Which cloud?") });
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config);
	comments.push({ id: 2001, author: "octocat", body: "Use Postgres and AWS.", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);

	for (const path of [path02, path03]) {
		const ticket = await readFile(path, "utf8");
		assert.match(ticket, /^### Reply from @octocat$/m);
		assert.match(ticket, /Use Postgres and AWS\./);
		assert.equal(parseTicket(ticket).status, "ready-for-agent");
	}
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info"]);
	const state = await readIssueState(dir);
	assert.deepEqual([...state.issues["18"].posted].sort(), ["needs-info:02:1", "needs-info:03:1", "replied:02:1", "replied:03:1"].sort());
	assertNoDeletes(calls);
});

test("collaborators are fetched once per sync however many replies arrive", async () => {
	const dir = await makeRoot();
	const feature = "gh-19-three-replies";
	await seedState(dir, feature, { number: 19 });
	for (const [n, title] of [["02", "First wait"], ["03", "Second wait"], ["04", "Third wait"]]) {
		await writeTicket(dir, feature, { number: n, title, status: "needs-info", comments: shiftReport(`needs-info: Which ${title}?`) });
	}
	const comments = [];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config); // three questions
	comments.push(
		{ id: 2001, author: "octocat", body: "#02: Use Postgres.", createdAt: "2026-10-01T12:00:00Z" },
		{ id: 2002, author: "octocat", body: "#03: Use Redis.", createdAt: "2026-10-01T12:01:00Z" },
		{ id: 2003, author: "octocat", body: "#04: Use MySQL.", createdAt: "2026-10-01T12:02:00Z" },
	);
	const { posted } = await sync(dir, github, config); // three replies, one collaborators fetch

	assert.deepEqual(posted.map((p) => p.key).sort(), ["replied:02:1", "replied:03:1", "replied:04:1"].sort());
	assert.equal(calls.filter((c) => c.op === "collaborators").length, 1, "collaborators fetched once for all three replies");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info"]);
	assertNoDeletes(calls);
});

test("a legacy commentsSeen count migrates: every comment that exists counts as seen", async () => {
	const dir = await makeRoot();
	const feature = "gh-20-legacy-state";
	await seedState(dir, feature, { number: 20, commentsSeen: 2 });
	const path = await writeTicket(dir, feature, { number: "02", title: "Legacy wait", status: "needs-info", comments: shiftReport("needs-info: Which database?") });
	const comments = [{ id: 10, author: "octocat", body: "an old reply that must not land", createdAt: "2026-10-01T11:00:00Z" }];
	const { github, calls } = stubGitHub({ comments });
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config);

	const state = await readIssueState(dir);
	assert.equal(state.issues["20"].commentsSeen, undefined, "the legacy count is gone");
	assert.ok(Number.isInteger(state.issues["20"].lastCommentId), "an id took its place");
	// The old comment was never a reply: the ticket still waits.
	let ticket = await readFile(path, "utf8");
	assert.doesNotMatch(ticket, /### Reply from/);
	assert.equal(parseTicket(ticket).status, "needs-info");

	comments.push({ id: 3000, author: "octocat", body: "Use Postgres.", createdAt: "2026-10-01T13:00:00Z" });
	await sync(dir, github, config);

	ticket = await readFile(path, "utf8");
	assert.match(ticket, /Use Postgres\./);
	assert.doesNotMatch(ticket, /an old reply/);
	assert.equal(parseTicket(ticket).status, "ready-for-agent");
	assertNoDeletes(calls);
});

test("all tickets resolved → one summary comment, the done label, working dropped, closed once; a second sync posts nothing", async () => {
	const dir = await makeRoot();
	const feature = "gh-13-all-done";
	await seedState(dir, feature, { number: 13 });
	await writeTicket(dir, feature, { number: "02", title: "The build", status: "claimed" });
	const { github, calls } = stubGitHub();
	const config = { github: { repo: "owner/name", autoClose: true } };

	// Work starts: the working label goes on.
	await sync(dir, github, config);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:working"]]);

	// Every ticket of the feature resolves (the plan ticket without landed commits).
	await commit(dir, `shiftwork: ${feature}/02 The build`);
	await writeTicket(dir, feature, { number: "01", title: "Plan the work", status: "resolved", comments: shiftReport("resolved") });
	await writeTicket(dir, feature, { number: "02", title: "The build", status: "resolved", comments: shiftReport("resolved") });
	await sync(dir, github, config);

	// The summary is a plain comment; the close carries no comment of its own.
	const summary = calls.filter((c) => c.op === "comment" && /All tickets of this issue are resolved/.test(c.args[1]));
	assert.equal(summary.length, 1);
	assert.match(summary[0].args[1], /- Ticket 02: The build/);
	const closed = calls.filter((c) => c.op === "close");
	assert.equal(closed.length, 1);
	assert.equal(closed[0].args[1], undefined);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:working"], ["shiftwork:done"]]);
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:working"]);
	// The plan ticket's resolved comment says it landed nothing.
	assert.match(calls.find((c) => c.op === "comment" && /Ticket 01 resolved/.test(c.args[1])).args[1], /- none found/);

	const before = calls.length;
	await sync(dir, github, config);
	assert.equal(calls.length, before);
	assert.equal(calls.filter((c) => c.op === "close").length, 1);

	const state = await readIssueState(dir);
	assert.deepEqual(state.issues["13"].posted, ["working", "started:02", "resolved:01", "resolved:02", "summary", "done", "done-label", "working-removed"]);
	assertNoDeletes(calls);
});

test("a failed done label is retried on the next sync without a second summary comment", async () => {
	const dir = await makeRoot();
	const feature = "gh-23-label-retry";
	await seedState(dir, feature, { number: 23 });
	await writeTicket(dir, feature, { number: "02", title: "The work", status: "resolved", comments: shiftReport("resolved") });
	const base = stubGitHub();
	let failLabels = true;
	const github = {
		...base.github,
		async addLabels(n, labels) {
			if (failLabels && labels.includes("shiftwork:done")) {
				failLabels = false;
				throw new Error("gh: exit status 1");
			}
			return base.github.addLabels(n, labels);
		},
	};
	const config = { github: { repo: "owner/name", autoClose: true } };

	// The summary comment and the close land; the done label fails.
	await assert.rejects(sync(dir, github, config), /gh: exit status 1/);
	const { posted } = await sync(dir, github, config);

	// The next sync retried only the label: one summary comment, one close.
	assert.equal(base.calls.filter((c) => c.op === "comment" && /All tickets of this issue are resolved/.test(c.args[1])).length, 1);
	assert.equal(base.calls.filter((c) => c.op === "close").length, 1);
	assert.deepEqual(base.calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:done"]]);
	assert.deepEqual(posted, [{ number: 23, key: "done-label" }]);
	const state = await readIssueState(dir);
	assert.deepEqual(state.issues["23"].posted, ["resolved:02", "summary", "done", "done-label"]);
	assertNoDeletes(base.calls);
});

test("a failed close is retried on the next sync without a second summary comment", async () => {
	const dir = await makeRoot();
	const feature = "gh-24-close-retry";
	await seedState(dir, feature, { number: 24 });
	await writeTicket(dir, feature, { number: "02", title: "The work", status: "resolved", comments: shiftReport("resolved") });
	const base = stubGitHub();
	let failClose = true;
	const github = {
		...base.github,
		async close(n, body) {
			const out = base.github.close(n, body); // recorded, like a real failed gh call
			if (failClose) {
				failClose = false;
				throw new Error("gh: exit status 1");
			}
			return out;
		},
	};
	const config = { github: { repo: "owner/name", autoClose: true } };

	// The summary comment lands; the close fails.
	await assert.rejects(sync(dir, github, config), /gh: exit status 1/);
	await sync(dir, github, config);

	assert.equal(base.calls.filter((c) => c.op === "comment" && /All tickets of this issue are resolved/.test(c.args[1])).length, 1);
	assert.equal(base.calls.filter((c) => c.op === "close").length, 2, "the close is retried");
	assert.deepEqual(base.calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:done"]]);
	const state = await readIssueState(dir);
	assert.deepEqual(state.issues["24"].posted, ["resolved:02", "summary", "done", "done-label"]);
	assertNoDeletes(base.calls);
});

test("with autoClose false, everything resolved leaves the issue open with no done label", async () => {
	const dir = await makeRoot();
	const feature = "gh-14-stays-open";
	await seedState(dir, feature, { number: 14 });
	await writeTicket(dir, feature, { number: "02", title: "Open work", status: "resolved", comments: shiftReport("resolved") });
	const { github, calls } = stubGitHub();
	const config = { github: { repo: "owner/name", autoClose: false } };

	await sync(dir, github, config);

	assert.deepEqual(calls.filter((c) => c.op === "close"), []);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels"), []);
	assert.equal(calls.filter((c) => c.op === "comment").length, 1);
	assertNoDeletes(calls);
});

test("parseTicketRef reads #NN and NN: at the start, and nothing else", () => {
	assert.equal(parseTicketRef("#02: Use Postgres."), 2);
	assert.equal(parseTicketRef("#02 Use Postgres."), 2);
	assert.equal(parseTicketRef("02: Use Postgres."), 2);
	assert.equal(parseTicketRef("Use #02 please."), undefined);
	assert.equal(parseTicketRef("12:30 was fine."), undefined);
	assert.equal(parseTicketRef(""), undefined);
});

test("latestShiftReport returns the last shift section and needsInfoReason the last reason", () => {
	const two = [
		"## Comments",
		"",
		"### Shift 1 — pi gpt-4 (low)",
		"- Outcome: new attempt",
		"",
		"### Shift 2 — pi claude-4 (medium)",
		"- Outcome: needs-info: First question",
		"",
		"### Handoff blocked",
		"- Reason: budget",
	].join("\n");

	assert.equal(
		latestShiftReport(two),
		["### Shift 2 — pi claude-4 (medium)", "", "- Outcome: needs-info: First question"].join("\n"),
	);
	assert.equal(needsInfoReason(two), "First question");

	const stopped = ["## Comments", "", "### Shift 1 — pi claude-4 (medium)", "- Stopped: no route for type code"].join("\n");
	assert.equal(needsInfoReason(stopped), "no route for type code");

	assert.equal(latestShiftReport("no reports here"), undefined);
	assert.equal(needsInfoReason("no reason here"), undefined);
});
