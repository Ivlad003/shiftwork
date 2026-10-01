import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHub, parseRepoUrl } from "../src/github.js";

/**
 * A stub `exec`: records every argv it is handed and answers from `reply(argv)`.
 * No real `gh`, `git` or network is ever invoked.
 */
function stubExec(reply) {
	const calls = [];
	const exec = async (args) => {
		calls.push(args);
		const out = reply(args);
		if (out === undefined) throw new Error(`unexpected exec: ${args.join(" ")}`);
		return out;
	};
	return { exec, calls };
}

test("repo() returns the configured repo without calling gh", async () => {
	const { exec, calls } = stubExec(() => undefined);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.equal(await gh.repo(), "owner/name");
	assert.deepEqual(calls, []);
});

test("repo() falls back to the origin remote: https and ssh forms, with and without .git", async () => {
	const url = "https://github.com/octocat/hello-world.git\n";
	const https = createGitHub({ root: "/repo", exec: stubExec(() => url).exec });
	assert.equal(await https.repo(), "octocat/hello-world");

	const ssh = createGitHub({ root: "/repo", exec: stubExec(() => "git@github.com:octocat/hello-world.git").exec });
	assert.equal(await ssh.repo(), "octocat/hello-world");

	const bare = createGitHub({ root: "/repo", exec: stubExec(() => "https://github.com/octocat/hello-world").exec });
	assert.equal(await bare.repo(), "octocat/hello-world");
});

test("repo() asks git for the origin URL and throws when it is not a GitHub repo", async () => {
	const { exec, calls } = stubExec(() => "https://gitlab.com/octocat/hello-world.git");
	const gh = createGitHub({ root: "/repo", exec });

	await assert.rejects(gh.repo(), /cannot read the GitHub repo from the origin remote/);
	assert.deepEqual(calls, [["git", "remote", "get-url", "origin"]]);
	assert.throws(() => parseRepoUrl("github.com/octocat/hello-world"), /cannot read the GitHub repo/);
});

test("collaborators() calls gh api and returns the logins", async () => {
	const { exec, calls } = stubExec((args) =>
		args.join(" ") === "gh api repos/owner/name/collaborators"
			? JSON.stringify([{ login: "octocat" }, { login: "hubot" }])
			: undefined,
	);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await gh.collaborators(), ["octocat", "hubot"]);
	assert.deepEqual(calls, [["gh", "api", "repos/owner/name/collaborators"]]);
});

test("listIssues() calls gh issue list with --json and normalizes the output", async () => {
	const { exec, calls } = stubExec((args) =>
		args.includes("list")
			? JSON.stringify([
					{
						number: 8,
						title: "dark factory",
						body: "watch issues",
						state: "OPEN",
						author: { login: "octocat" },
						labels: [{ name: "sw" }, { name: "bug" }],
						url: "https://github.com/owner/name/issues/8",
					},
				])
			: undefined,
	);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await gh.listIssues({ label: "sw" }), [
		{
			number: 8,
			title: "dark factory",
			body: "watch issues",
			state: "OPEN",
			author: "octocat",
			labels: ["sw", "bug"],
			url: "https://github.com/owner/name/issues/8",
		},
	]);
	assert.deepEqual(calls, [[
		"gh",
		"issue",
		"list",
		"--repo",
		"owner/name",
		"--state",
		"open",
		"--limit",
		"100",
		"--label",
		"sw",
		"--json",
		"number,title,body,state,author,labels,url",
	]]);
});

test("listIssues() without a label sends no --label flag", async () => {
	const { exec, calls } = stubExec(() => "[]");
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await gh.listIssues(), []);
	assert.ok(!calls[0].includes("--label"));
});

test("issueComments(n) calls gh issue view with --json comments and normalizes them", async () => {
	const { exec, calls } = stubExec((args) =>
		args.includes("view")
			? JSON.stringify({
					comments: [
						{ author: { login: "octocat" }, body: "first", createdAt: "2026-10-01T10:00:00Z" },
						{ author: { login: "hubot" }, body: "second", createdAt: "2026-10-02T10:00:00Z" },
					],
				})
			: undefined,
	);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await gh.issueComments(8), [
		{ author: "octocat", body: "first", createdAt: "2026-10-01T10:00:00Z" },
		{ author: "hubot", body: "second", createdAt: "2026-10-02T10:00:00Z" },
	]);
	assert.deepEqual(calls, [["gh", "issue", "view", "8", "--repo", "owner/name", "--json", "comments"]]);
});

test("comment(n, body) posts with --body and resolves the comment URL", async () => {
	const { exec, calls } = stubExec(() => "https://github.com/owner/name/issues/8#issuecomment-1\n");
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.equal(await gh.comment(8, "started"), "https://github.com/owner/name/issues/8#issuecomment-1");
	assert.deepEqual(calls, [["gh", "issue", "comment", "8", "--repo", "owner/name", "--body", "started"]]);
});

test("addLabels and removeLabel edit the issue's labels", async () => {
	const { exec, calls } = stubExec(() => "");
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	await gh.addLabels(8, ["shiftwork:planning", "shiftwork:working"]);
	await gh.removeLabel(8, "shiftwork:needs-info");

	assert.deepEqual(calls, [
		["gh", "issue", "edit", "8", "--repo", "owner/name", "--add-label", "shiftwork:planning", "--add-label", "shiftwork:working"],
		["gh", "issue", "edit", "8", "--repo", "owner/name", "--remove-label", "shiftwork:needs-info"],
	]);
});

test("close(n) closes the issue, with an optional final comment", async () => {
	const { exec, calls } = stubExec(() => "");
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	await gh.close(8);
	await gh.close(8, "all tickets resolved");

	assert.deepEqual(calls, [
		["gh", "issue", "close", "8", "--repo", "owner/name"],
		["gh", "issue", "close", "8", "--repo", "owner/name", "--comment", "all tickets resolved"],
	]);
});
