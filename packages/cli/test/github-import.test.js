import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseTicket } from "shiftwork-core";

import { importIssues, readIssueState, slugifyTitle } from "../src/github-import.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A stub GitHub: records every `listIssues` label, filters issues on it like `gh --label`. */
function stubGitHub({ collaborators = ["octocat"], issues = [], labelActors = {} } = {}) {
	const calls = { listIssues: [], labelActor: [] };
	return {
		calls,
		github: {
			async collaborators() {
				return [...collaborators];
			},
			async labelActor(n, label) {
				calls.labelActor.push([n, label]);
				return labelActors[n];
			},
			async listIssues({ label } = {}) {
				calls.listIssues.push(label ?? null);
				return label === undefined ? [...issues] : issues.filter((issue) => (issue.labels ?? []).includes(label));
			},
	},
	};
}

const issue = ({ number = 8, title = "Support GitHub issues", author = "octocat", labels = [], url = `https://github.com/owner/name/issues/${number}`, body = "Please support issues." } = {}) => ({
	number,
	title,
	body,
	state: "open",
	author,
	labels,
	url,
});

const now = () => new Date("2026-10-01T10:00:00.000Z");

/** A temp repo root. */
const root = () => mkdtemp(join(tmpdir(), "sw-import-"));

test("imports a collaborator's issue: spec.md and 01-plan.md with the expected lines", async () => {
	const dir = await root();
	const theIssue = issue();
	const { github, calls } = stubGitHub({ issues: [theIssue] });
	const config = { github: {} };

	const result = await importIssues({ root: dir, github, config, now });

	assert.deepEqual(calls.listIssues, [null]);
	assert.deepEqual(result, {
		imported: [{ number: 8, title: theIssue.title, url: theIssue.url, author: "octocat", feature: "gh-8-support-github-issues" }],
		skipped: [],
	});

	const spec = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "spec.md"), "utf8");
	assert.match(spec, /^# Spec: Support GitHub issues$/m);
	assert.match(spec, /\*\*Status:\*\* ready-for-agent/);
	assert.match(spec, /^Source: github#8 https:\/\/github\.com\/owner\/name\/issues\/8$/m);
	assert.match(spec, /^Author: octocat$/m);
	assert.match(spec, /^## Issue$/m);
	assert.match(spec, /Please support issues\./);

	const plan = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "issues", "01-plan.md"), "utf8");
	assert.match(plan, /\*\*Status:\*\* ready-for-agent/);
	assert.match(plan, /\*\*Type:\*\* plan/);
	assert.match(plan, /\*\*Verify:\*\* `shiftwork tickets check gh-8-support-github-issues`/);
});

test("the plan ticket asks for a Type: research ticket 02 only when the issue needs reading first", async () => {
	const dir = await root();
	await importIssues({ root: dir, github: stubGitHub({ issues: [issue()] }).github, config: { github: {} }, now });

	const plan = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "issues", "01-plan.md"), "utf8");
	assert.match(plan, /needs reading before coding/);
	assert.match(plan, /`\*\*Type:\*\* research` ticket `02`/);
	assert.match(plan, /`\.scratch\/gh-8-support-github-issues\/research\.md`/);
	assert.match(plan, /`test -s \.scratch\/gh-8-support-github-issues\/research\.md`/);
	assert.match(plan, /`\*\*Blocked by:\*\*`/);
	assert.match(plan, /otherwise skip it/);
});

test("an empty issue imports ticket 01 as needs-info and records a blank description", async () => {
	const dir = await root();
	const theIssue = issue({ body: " \n\t" });

	await importIssues({ root: dir, github: stubGitHub({ issues: [theIssue] }).github, config: { github: {} }, now });

	const plan = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "issues", "01-plan.md"), "utf8");
	assert.match(plan, /\*\*Status:\*\* needs-info/);
	assert.match(plan, /Outcome: needs-info: The issue has no description\. What should Shiftwork build\?/);
	const spec = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "spec.md"), "utf8");
	assert.match(spec, /\*\*Status:\*\* needs-info/);
	const state = await readIssueState(dir);
	assert.equal(state.issues["8"].bodySeen, "");
});

test("a second run imports nothing: the state file makes it idempotent", async () => {
	const dir = await root();
	const { github } = stubGitHub({ issues: [issue()] });
	const config = { github: {} };

	await importIssues({ root: dir, github, config, now });
	const second = await importIssues({ root: dir, github, config, now });

	assert.deepEqual(second, { imported: [], skipped: [] });

	const state = await readIssueState(dir);
	assert.deepEqual(state.issues["8"], {
		number: 8,
		feature: "gh-8-support-github-issues",
		title: "Support GitHub issues",
		importedAt: "2026-10-01T10:00:00.000Z",
		lastCommentId: null,
		ownComments: [],
		posted: [],
		bodySeen: "Please support issues.",
	});
});

test("a non-collaborator's issue is skipped with its login and nothing is written", async () => {
	const dir = await root();
	const config = { github: {} };

	const result = await importIssues({ root: dir, github: stubGitHub({ issues: [issue({ number: 9, author: "rando" })] }).github, config, now });

	assert.deepEqual(result, { imported: [], skipped: [{ number: 9, login: "rando" }] });
	const state = await readIssueState(dir);
	assert.deepEqual(state.issues, {});
	await assert.rejects(readFile(join(dir, ".scratch", "gh-9-support-github-issues", "spec.md")), /ENOENT/);
});

test("config.github.authors admits an extra login", async () => {
	const dir = await root();
	const config = { github: { authors: ["friend"] } };

	const result = await importIssues({ root: dir, github: stubGitHub({ issues: [issue({ author: "friend" })] }).github, config, now });

	assert.equal(result.imported.length, 1);
	assert.deepEqual(result.skipped, []);
});

test("github.labels.in filters the issues and is passed to listIssues", async () => {
	const dir = await root();
	const config = { github: { labels: { in: "shiftwork" } } };
	const { github, calls } = stubGitHub({
		issues: [issue({ number: 8, labels: ["shiftwork"] }), issue({ number: 9, labels: ["bug"] })],
	});

	const result = await importIssues({ root: dir, github, config, now });

	assert.deepEqual(calls.listIssues, ["shiftwork"]);
	assert.deepEqual(result.imported.map((i) => i.number), [8]);
	assert.deepEqual(result.skipped, []);
});

test("logins are compared case-insensitively, on both the collaborators and github.authors", async () => {
	const dir = await root();
	const config = { github: { authors: ["Friend"] } };
	const issues = [issue({ number: 8, author: "octocat" }), issue({ number: 9, title: "Other", author: "FRIEND" })];

	const result = await importIssues({ root: dir, github: stubGitHub({ collaborators: ["OctoCat"], issues }).github, config, now });

	assert.deepEqual(result.imported.map((i) => i.number), [8, 9]);
	assert.deepEqual(result.skipped, []);
});

test("an outsider's issue is accepted when a collaborator added the in label; events are read only for outsiders", async () => {
	const dir = await root();
	const config = { github: { labels: { in: "shiftwork" } } };
	const { github, calls } = stubGitHub({
		issues: [
			issue({ number: 8, labels: ["shiftwork"] }),
			issue({ number: 9, title: "Labelled by a collaborator", author: "rando", labels: ["shiftwork"] }),
			issue({ number: 10, title: "Labelled by an outsider", author: "rando", labels: ["shiftwork"] }),
		],
		labelActors: { 9: "OctoCat", 10: "rando" },
	});

	const result = await importIssues({ root: dir, github, config, now });

	assert.deepEqual(result.imported.map((i) => i.number), [8, 9]);
	assert.deepEqual(result.skipped, [{ number: 10, login: "rando" }]);
	assert.deepEqual(calls.labelActor, [[9, "shiftwork"], [10, "shiftwork"]], "the author's own issue needs no events query");
});

test("the generated 01-plan.md passes parseTicket and the spec names the issue URL", async () => {
	const dir = await root();
	const theIssue = issue();
	await importIssues({ root: dir, github: stubGitHub({ issues: [theIssue] }).github, config: { github: {} }, now });

	const plan = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "issues", "01-plan.md"), "utf8");
	const ticket = parseTicket(plan);
	assert.equal(ticket.number, "01");
	assert.equal(ticket.status, "ready-for-agent");
	assert.equal(ticket.type, "plan");
	assert.deepEqual(ticket.blockedBy, []);
	assert.deepEqual(ticket.verify, ["shiftwork tickets check gh-8-support-github-issues"]);

	const spec = await readFile(join(dir, ".scratch", "gh-8-support-github-issues", "spec.md"), "utf8");
	assert.ok(spec.includes(theIssue.url));
});

test("importIssues does not route plan tickets; validateConfig applies github.planTier", async () => {
	const dir = await root();
	const issues = [issue()];

	const routed = { github: { planTier: "light" } };
	await importIssues({ root: dir, github: stubGitHub({ issues }).github, config: routed, now });
	assert.equal(routed.routing, undefined, "the importer no longer sets routing.plan");

	const own = { github: { planTier: "light" }, routing: { plan: { model: "xai/grok-4.7" } } };
	await importIssues({ root: dir, github: stubGitHub({ issues }).github, config: own, now });
	assert.deepEqual(own.routing, { plan: { model: "xai/grok-4.7" } }, "an existing route is left alone");
});

test("the slug is the title lower-cased, ASCII-folded, 40 characters max", () => {
	assert.equal(slugifyTitle("Support GitHub issues"), "support-github-issues");
	assert.equal(slugifyTitle("Café — Ünïcode Tïtlë"), "cafe-unicode-title");
	assert.equal(slugifyTitle("!!!"), "issue");
	assert.equal(slugifyTitle("a".repeat(80)).length, 40);
	assert.equal(slugifyTitle(""), "issue");
	assert.equal(slugifyTitle(undefined), "issue");
});

test(".shiftwork/shiftwork-github.json (and its legacy .pi/ path) is in .gitignore", async () => {
	const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
	assert.match(gitignore, /^\.shiftwork\/shiftwork-github\.json$/m);
	assert.match(gitignore, /^\.pi\/shiftwork-github\.json$/m);
});
