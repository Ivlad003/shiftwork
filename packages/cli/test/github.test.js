import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	createGitHub,
	GH_AUTH_MESSAGE,
	GH_INSTALL_MESSAGE,
	ghPreFlight,
	parseRepoUrl,
	SHIFTWORK_MARKER,
} from "../src/github.js";

const run = promisify(execFile);
const ghStub = fileURLToPath(new URL("./fixtures/gh-stub.mjs", import.meta.url));

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

test("createGitHub({ root }) with no exec and no repo resolves the repo with real git and the gh binary", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sw-gh-origin-"));
	await run("git", ["init", "-q"], { cwd: dir });
	await run("git", ["remote", "add", "origin", "https://github.com/octocat/hello-world.git"], { cwd: dir });
	const statePath = join(dir, "gh-stub-state.json");
	await writeFile(statePath, JSON.stringify({ repo: "octocat/hello-world", collaborators: ["octocat", "hubot"], labels: [], issues: [] }));
	process.env.SHIFTWORK_GH_STATE = statePath;
	try {
		const gh = createGitHub({ root: dir, gh: ghStub });

		assert.equal(await gh.repo(), "octocat/hello-world");
		assert.deepEqual(await gh.collaborators(), ["octocat", "hubot"]);
	} finally {
		delete process.env.SHIFTWORK_GH_STATE;
	}
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

test("collaborators() calls gh api with --paginate, every page, and returns the logins", async () => {
	const { exec, calls } = stubExec((args) =>
		args.join(" ") === "gh api repos/owner/name/collaborators --paginate --jq .[].login" ? "octocat\nhubot\n" : undefined,
	);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await gh.collaborators(), ["octocat", "hubot"]);
	assert.deepEqual(calls, [["gh", "api", "repos/owner/name/collaborators", "--paginate", "--jq", ".[].login"]]);
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

test("issueComments(n) calls gh api with --paginate and normalizes the comments with their ids", async () => {
	const jq = ".[] | {id: .id, author: .user.login, body: .body, createdAt: .created_at}";
	const { exec, calls } = stubExec((args) =>
		args.join(" ") === `gh api repos/owner/name/issues/8/comments --paginate --jq ${jq}`
			? [
					JSON.stringify({ id: 11, author: "octocat", body: "first", createdAt: "2026-10-01T10:00:00Z" }),
					JSON.stringify({ id: 12, author: "hubot", body: "second", createdAt: "2026-10-02T10:00:00Z" }),
				].join("\n")
			: undefined,
	);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.deepEqual(await gh.issueComments(8), [
		{ id: 11, author: "octocat", body: "first", createdAt: "2026-10-01T10:00:00Z" },
		{ id: 12, author: "hubot", body: "second", createdAt: "2026-10-02T10:00:00Z" },
	]);
	assert.deepEqual(calls, [["gh", "api", "repos/owner/name/issues/8/comments", "--paginate", "--jq", jq]]);
});

test("comment(n, body) posts with -f body, ends with the marker and resolves the comment's id", async () => {
	const { exec, calls } = stubExec(() => `${JSON.stringify({ id: 123 })}\n`);
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	assert.equal(await gh.comment(8, "started"), 123);
	assert.deepEqual(calls, [["gh", "api", "repos/owner/name/issues/8/comments", "-f", `body=started\n\n${SHIFTWORK_MARKER}`]]);
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

test("close(n) closes the issue, with an optional final comment that ends with the marker", async () => {
	const { exec, calls } = stubExec(() => "");
	const gh = createGitHub({ root: "/repo", repo: "owner/name", exec });

	await gh.close(8);
	await gh.close(8, "all tickets resolved");

	assert.deepEqual(calls, [
		["gh", "issue", "close", "8", "--repo", "owner/name"],
		["gh", "issue", "close", "8", "--repo", "owner/name", "--comment", `all tickets resolved\n\n${SHIFTWORK_MARKER}`],
	]);
});

test("ghPreFlight: null when gh auth status passes, the two messages when it does not", async () => {
	assert.equal(await ghPreFlight({ gh: "gh", exec: stubExec(() => "").exec }), null);

	const missing = async () => {
		throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
	};
	assert.equal(await ghPreFlight({ gh: "gh", exec: missing }), GH_INSTALL_MESSAGE);

	const noAuth = async () => {
		throw Object.assign(new Error("gh: exit status 1"), { code: 1, stderr: "not logged in" });
	};
	assert.equal(await ghPreFlight({ gh: "/x/gh", exec: noAuth }), GH_AUTH_MESSAGE);
});
