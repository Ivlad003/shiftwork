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
 */
export function createGitHub({ root, repo, exec = defaultExec } = {}) {
	async function defaultExec(args) {
		return (await run(args[0], args.slice(1), { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
	}

	const gh = async (...args) => (await exec(["gh", ...args])).trim();
	const ghJson = async (...args) => JSON.parse(await gh(...args));
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
			return gh("issue", "comment", String(n), ...(await repoFlag()), "--body", body);
		},

		/** Add labels to the issue. */
		async addLabels(n, labels) {
			const flags = labels.flatMap((label) => ["--add-label", label]);
			return gh("issue", "edit", String(n), ...(await repoFlag()), ...flags);
		},

		/** Remove one label from the issue. */
		async removeLabel(n, label) {
			return gh("issue", "edit", String(n), ...(await repoFlag()), "--remove-label", label);
		},

		/** Close the issue, optionally with a final comment. */
		async close(n, body) {
			const args = ["issue", "close", String(n), ...(await repoFlag())];
			if (body !== undefined) args.push("--comment", body);
			return gh(...args);
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
