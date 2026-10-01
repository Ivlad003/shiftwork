import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Thin `gh` wrapper for the dark-factory GitHub integration (ADR-0004: core has
 * no backend dependencies, so GitHub calls live here in the CLI).
 *
 * `exec(args) → Promise<string>` runs a command with `args` — a full argv
 * including the binary, e.g. `["gh", "api", "repos/<repo>/collaborators"]` —
 * in `root` and resolves its stdout. Injectable so tests (and later the
 * watcher) never need the real `gh` or the network.
 *
 * It runs the operator's installed `gh` binary (`gh` on PATH, or a path via
 * the `github.gh` config key), inheriting the environment so the operator's
 * `gh auth login` session is used. Shiftwork never reads or stores a token
 * and adds no HTTP client (operator decision 2026-10-01).
 */
export function createGitHub({ root, repo, gh = "gh", exec } = {}) {
	// The default exec runs the binary in `root`, inheriting the environment
	// (so the operator's `gh auth login` session applies).
	const runCmd =
		exec ??
		(async (args) => (await run(args[0], args.slice(1), { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout);

	const ghCmd = async (...args) => (await runCmd([gh, ...args])).trim();
	const ghJson = async (...args) => JSON.parse(await ghCmd(...args));
	const repoFlag = async () => ["--repo", await resolveRepo()];

	/** The configured repo, else `owner/name` parsed from the `origin` remote URL. */
	async function resolveRepo() {
		if (repo !== undefined) return repo;
		return parseRepoUrl((await exec(["git", "remote", "get-url", "origin"])).trim());
	}

	return {
		repo: resolveRepo,

		/** Logins of the repo's collaborators (`gh api repos/<repo>/collaborators`). */
		async collaborators() {
			const out = await ghJson("api", `repos/${await resolveRepo()}/collaborators`);
			return out.map((collaborator) => collaborator.login);
		},

		/** Open issues of the repo, narrowed to `label` when given, normalized to plain fields. */
		async listIssues({ label, limit = 100 } = {}) {
			const args = ["issue", "list", ...(await repoFlag()), "--state", "open", "--limit", String(limit)];
			if (label !== undefined) args.push("--label", label);
			const out = await ghJson(...args, "--json", "number,title,body,state,author,labels,url");
			return out.map((issue) => ({
				number: issue.number,
				title: issue.title,
				body: issue.body,
				state: issue.state,
				author: issue.author?.login,
				labels: (issue.labels ?? []).map((l) => l.name),
				url: issue.url,
			}));
		},

		/** The issue's comments, oldest first, normalized to `{ author, body, createdAt }`. */
		async issueComments(n) {
			const out = await ghJson("issue", "view", String(n), ...(await repoFlag()), "--json", "comments");
			return (out.comments ?? []).map((c) => ({ author: c.author?.login, body: c.body, createdAt: c.createdAt }));
		},

		/** Post a comment on the issue; resolves the comment's URL. */
		async comment(n, body) {
			return ghCmd("issue", "comment", String(n), ...(await repoFlag()), "--body", body);
		},

		/** Add labels to the issue. */
		async addLabels(n, labels) {
			const flags = labels.flatMap((label) => ["--add-label", label]);
			return ghCmd("issue", "edit", String(n), ...(await repoFlag()), ...flags);
		},

		/** Remove one label from the issue. */
		async removeLabel(n, label) {
			return ghCmd("issue", "edit", String(n), ...(await repoFlag()), "--remove-label", label);
		},

		/** The repo's label names (`gh label list --json name --limit 500`). */
		async listLabels() {
			const out = await ghJson("label", "list", ...(await repoFlag()), "--json", "name", "--limit", "500");
			return out.map((label) => label.name);
		},

		/** Create a label with a colour and a description; never edits or deletes one. */
		async createLabel(name, { color, description } = {}) {
			const args = ["label", "create", name, ...(await repoFlag())];
			if (color !== undefined) args.push("--color", color);
			if (description !== undefined) args.push("--description", description);
			return ghCmd(...args);
		},

		/** Close the issue, optionally with a final comment. */
		async close(n, body) {
			const args = ["issue", "close", String(n), ...(await repoFlag())];
			if (body !== undefined) args.push("--comment", body);
			return ghCmd(...args);
		},
	};
}

/** `owner/name` from an origin remote URL: `https://github.com/<owner>/<name>(.git)` or `git@github.com:<owner>/<name>(.git)`. */
export function parseRepoUrl(url) {
	const match =
		url.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)?.slice(1) ??
		url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)?.slice(1) ??
		url.match(/^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)?.slice(1);
	if (!match) {
		throw new Error(`cannot read the GitHub repo from the origin remote "${url}": expected https://github.com/<owner>/<name> or git@github.com:<owner>/<name>`);
	}
	return `${match[0]}/${match[1]}`;
}
