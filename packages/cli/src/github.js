import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execIn } from "./exec.js";

/** The hidden marker every comment Shiftwork posts ends with, so its own comments are never mistaken for a collaborator's reply. */
export const SHIFTWORK_MARKER = "<!-- shiftwork -->";

/** gh missing: the binary was not found (a bad `github.gh`, or no `gh` on PATH). */
export const ghInstallMessage = (command = "dark-factory") =>
	`${command}: needs the GitHub CLI: install it from https://cli.github.com, then run gh auth login`;
/** gh found but `gh auth status` failed: no logged-in session for Shiftwork to use. */
export const ghAuthMessage = (command = "dark-factory") => `${command}: needs an authenticated gh: run gh auth login`;

/** `execFile` could not spawn the gh binary (it is missing or not executable). */
export function isGhMissing(error) {
	return error?.code === "ENOENT" || error?.code === "EACCES" || /ENOENT/.test(String(error?.message ?? ""));
}

/**
 * The gh pre-flight, shared by dark-factory and `github labels` (ticket 10): the
 * binary must exist and `gh auth status` must pass. Resolves null when OK, else
 * the message to print and exit 1 with. The messages carry the calling command's
 * name (`command`, default `dark-factory`; `github labels` passes its own).
 */
export async function ghPreFlight({ gh = "gh", exec, command = "dark-factory" } = {}) {
	try {
		await exec([gh, "auth", "status"]);
		return null;
	} catch (error) {
		return isGhMissing(error) ? ghInstallMessage(command) : ghAuthMessage(command);
	}
}

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
 *
 * Every comment Shiftwork posts ends with the hidden `SHIFTWORK_MARKER`, and
 * `comment` resolves the new comment's id, so the sync can tell its own
 * comments from a collaborator's reply.
 *
 * `warn(line)` (default `console.error`) is told once per client when the
 * collaborators cannot be listed (a token without push access gets a 403) and
 * `collaborators()` falls back to the authenticated user.
 */
export function createGitHub({ root, repo, gh = "gh", exec, warn = console.error } = {}) {
	// The default exec runs the binary in `root`, inheriting the environment
	// (so the operator's `gh auth login` session applies).
	const runCmd = exec ?? execIn(root);

	const ghCmd = async (...args) => (await runCmd([gh, ...args])).trim();
	const ghJson = async (...args) => JSON.parse(await ghCmd(...args));
	/** The non-empty output lines of a command (`gh api --paginate --jq` prints one value per line). */
	const ghLines = async (...args) => (await ghCmd(...args)).split("\n").map((line) => line.trim()).filter(Boolean);
	const ghJsonLines = async (...args) => (await ghLines(...args)).map((line) => JSON.parse(line));
	const repoFlag = async () => ["--repo", await resolveRepo()];

	/** The configured repo, else `owner/name` parsed from the `origin` remote URL. */
	async function resolveRepo() {
		if (repo !== undefined) return repo;
		return parseRepoUrl((await runCmd(["git", "remote", "get-url", "origin"])).trim());
	}
	let warnedCollaborators = false;

	return {
		repo: resolveRepo,

		/**
		 * Logins of the repo's collaborators — every page
		 * (`gh api repos/<repo>/collaborators --paginate`). When that fails (a
		 * token without push access gets a 403), the authenticated user alone
		 * (`gh api user`), with one warning per client; the callers add
		 * `github.authors`. Tried again on every call; when the user cannot be
		 * read either, the original error is thrown.
		 */
		async collaborators() {
			const target = await resolveRepo();
			try {
				return await ghLines("api", `repos/${target}/collaborators`, "--paginate", "--jq", ".[].login");
			} catch (error) {
				let me;
				try {
					me = await ghCmd("api", "user", "--jq", ".login");
				} catch {
					throw error;
				}
				if (!warnedCollaborators) {
					warnedCollaborators = true;
					warn(
						`dark-factory: cannot list the collaborators of ${target} (${oneLine(error)}); only ${me} and github.authors may hand over issues and reply`,
					);
				}
				return me ? [me] : [];
			}
		},

		/**
		 * The login that most recently added `label` to the issue (its `labeled`
		 * events, every page), or undefined when it was never added.
		 */
		async labelActor(n, label) {
			const jq = `.[] | select(.event == "labeled" and .label.name == ${JSON.stringify(label)}) | .actor.login`;
			return (await ghLines("api", `repos/${await resolveRepo()}/issues/${n}/events`, "--paginate", "--jq", jq)).at(-1);
		},

		/**
		 * Open issues of the repo, narrowed to `label` when given, normalized to
		 * plain fields. With a label the limit is 1000, so a busy queue of
		 * labelled issues is not cut at 100.
		 */
		async listIssues({ label, limit = label === undefined ? 100 : 1000 } = {}) {
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

		/**
		 * The issue's comments, oldest first, every page, normalized to
		 * `{ id, author, body, createdAt }` — the id is how the sync tells a
		 * fresh reply from one it already consumed.
		 */
		async issueComments(n) {
			const out = await ghJsonLines(
				"api",
				`repos/${await resolveRepo()}/issues/${n}/comments`,
				"--paginate",
				"--jq",
				".[] | {id: .id, author: .user.login, body: .body, createdAt: .created_at}",
			);
			return out.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt }));
		},

		/**
		 * Post a comment on the issue (it ends with the Shiftwork marker);
		 * resolves the new comment's id.
		 */
		async comment(n, body) {
			const out = await ghJson("api", `repos/${await resolveRepo()}/issues/${n}/comments`, "-f", `body=${withMarker(body)}`);
			return out.id;
		},

		/** The issue body (`gh issue view --json body`). Empty when GitHub has none. */
		async issueBody(n) {
			const out = await ghJson("issue", "view", String(n), ...(await repoFlag()), "--json", "body");
			return out.body ?? "";
		},

		/**
		 * Replace the issue body. The text goes through a file so newlines and
		 * quotes stay literal; Shiftwork never deletes the issue.
		 */
		async editBody(n, body) {
			const dir = await mkdtemp(join(tmpdir(), `shiftwork-issue-${randomUUID()}-`));
			try {
				const file = join(dir, "body.md");
				await writeFile(file, String(body ?? ""));
				return await ghCmd("issue", "edit", String(n), ...(await repoFlag()), "--body-file", file);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
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

		/** Close the issue, optionally with a final comment (it ends with the Shiftwork marker). */
		async close(n, body) {
			const args = ["issue", "close", String(n), ...(await repoFlag())];
			if (body !== undefined) args.push("--comment", withMarker(body));
			return ghCmd(...args);
		},
	};
}

/** An error's message on one line (gh errors span several). */
export function oneLine(error) {
	return String(error?.message ?? error)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");
}

/** The body with the Shiftwork marker at the end (never a second marker). */
function withMarker(body) {
	const text = String(body ?? "");
	return text.includes(SHIFTWORK_MARKER) ? text : `${text.trimEnd()}\n\n${SHIFTWORK_MARKER}`;
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
