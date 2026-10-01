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
import { latestShiftReport, needsInfoReason, syncIssues } from "../src/github-sync.js";

const run = promisify(execFile);

/** Every op a stub `github` may see: no test ever calls a delete endpoint. */
const OPS = ["repo", "collaborators", "issueComments", "comment", "addLabels", "removeLabel", "close"];

function assertNoDeletes(calls) {
	const unknown = calls.map((c) => c.op).filter((op) => !OPS.includes(op));
	assert.deepEqual(unknown, [], `unexpected github op (a delete endpoint?): ${JSON.stringify(calls)}`);
}

/** A stub GitHub: records every call, answers comments from the shared `comments` array. */
function stubGitHub({ collaborators = ["octocat"], comments = [] } = {}) {
	const calls = [];
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
			return `https://github.com/owner/name/issues/${n}#comment-${calls.length}`;
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

/** One imported issue in `.pi/shiftwork-github.json`, as `importIssues` writes it. */
async function seedState(root, feature, { number = 8, posted = [] } = {}) {
	await writeIssueState(root, {
		issues: { [String(number)]: { number, feature, importedAt: "2026-10-01T10:00:00.000Z", lastCommentId: null, posted } },
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
	assert.deepEqual(state.issues["10"].posted, ["needs-info:03"]);
	assert.equal(state.issues["10"].commentsSeen, 0);
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

	comments.push({ author: "octocat", body: "Use Postgres.", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);

	// The question is not re-asked, the reply is on the ticket and it is ready again.
	assert.equal(calls.filter((c) => c.op === "comment").length, 1);
	const ticket = await readFile(path, "utf8");
	assert.match(ticket, /^### Reply from @octocat$/m);
	assert.match(ticket, /Use Postgres\./);
	assert.equal(parseTicket(ticket).status, "ready-for-agent");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:needs-info"]);

	const state = await readIssueState(dir);
	assert.deepEqual([...state.issues["11"].posted].sort(), ["needs-info:03", "replied:03"].sort());
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

	comments.push({ author: "rando", body: "Also AWS?", createdAt: "2026-10-01T12:00:00Z" });
	await sync(dir, github, config);

	let ticket = await readFile(path, "utf8");
	assert.doesNotMatch(ticket, /### Reply from/);
	assert.equal(parseTicket(ticket).status, "needs-info");
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel"), []);

	// The ignored reply is not reconsidered; the next collaborator reply lands.
	comments.push({ author: "octocat", body: "Use AWS.", createdAt: "2026-10-01T13:00:00Z" });
	await sync(dir, github, config);

	ticket = await readFile(path, "utf8");
	assert.match(ticket, /^### Reply from @octocat$/m);
	assert.match(ticket, /Use AWS\./);
	assert.doesNotMatch(ticket, /Also AWS\?/);
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

	const closed = calls.filter((c) => c.op === "close");
	assert.equal(closed.length, 1);
	assert.match(closed[0].args[1], /All tickets of this issue are resolved/);
	assert.match(closed[0].args[1], /- Ticket 02: The build/);
	assert.deepEqual(calls.filter((c) => c.op === "addLabels").map((c) => c.args[1]), [["shiftwork:working"], ["shiftwork:done"]]);
	assert.deepEqual(calls.filter((c) => c.op === "removeLabel").map((c) => c.args[1]), ["shiftwork:working"]);
	// The plan ticket's resolved comment says it landed nothing.
	assert.match(calls.find((c) => c.op === "comment" && /Ticket 01 resolved/.test(c.args[1])).args[1], /- none found/);

	const before = calls.length;
	await sync(dir, github, config);
	assert.equal(calls.length, before);
	assert.equal(calls.filter((c) => c.op === "close").length, 1);

	const state = await readIssueState(dir);
	assert.ok(state.issues["13"].posted.includes("done"));
	assertNoDeletes(calls);
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
