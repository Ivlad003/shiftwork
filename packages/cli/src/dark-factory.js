import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { runFrontier } from "shiftwork-core";

import { createGitHub } from "./github.js";
import { importIssues } from "./github-import.js";
import { checkLabels, missingLabelsMessage } from "./github-labels.js";
import { syncIssues } from "./github-sync.js";

const run = promisify(execFile);

const STOP_FILE = "STOP";
/** The wait between polls wakes at least this often, so a STOP file is noticed (like the runner's cooldown waits). */
const WAKE_MS = 60_000;

/** gh missing: the binary was not found (a bad `github.gh`, or no `gh` on PATH). */
export const GH_INSTALL_MESSAGE = "dark-factory needs the GitHub CLI: install it from https://cli.github.com, then run gh auth login";
/** gh found but `gh auth status` failed: no logged-in session for Shiftwork to use. */
export const GH_AUTH_MESSAGE = "dark-factory needs an authenticated gh: run gh auth login";
/** `run --dark-factory` without a `github` block: there is nothing to watch. */
export const NO_GITHUB_CONFIG_MESSAGE = 'dark-factory needs a "github" block in .pi/shiftwork.json (see docs/guide.md "Dark-factory mode")';

/** `execFile` could not spawn the gh binary (it is missing or not executable). */
function isGhMissing(error) {
	return error?.code === "ENOENT" || error?.code === "EACCES" || /ENOENT/.test(String(error?.message ?? ""));
}

/**
 * `run --dark-factory` (spec: github-watch, ticket 05): watch the repo's GitHub
 * issues and work the frontier continuously.
 *
 * Every `github.pollMin` minutes one poll: `importIssues` (ticket 03), then
 * `syncIssues` (ticket 04), then a full frontier pass with today's
 * `runFrontier` until it is empty, then — with `github.push` on and a pass that
 * landed commits — `git push origin HEAD` in the main checkout, then sync
 * again. It stops like the runner does: a STOP file or a signal ends it after
 * the current shift; `once` does one poll plus one frontier pass and returns 0.
 *
 * Before anything else, using the operator's installed `gh` (`github.gh`, else
 * `gh` on PATH): gh missing and `gh auth status` failing each exit 1, then
 * `checkLabels` (ticket 09) — a missing label exits 1 before any issue is
 * imported. One line is printed per import/sync action.
 *
 * @returns {Promise<number>} the exit code: 3 stopped · 1 a start-up error · else 0 (`once`)
 */
export async function darkFactoryRun({
	root,
	config,
	tracker,
	backend,
	verify,
	workspace,
	classifyTicket,
	shiftLog,
	once = false,
	github,
	exec,
	git,
	log = console.log,
	err = console.error,
	runFrontier: runFrontierImpl = runFrontier,
	sleep,
}) {
	if (!config?.github) {
		err(NO_GITHUB_CONFIG_MESSAGE);
		return 1;
	}
	const ghBinary = config.github.gh ?? "gh";
	const execFn = exec ?? (async (args) => (await run(args[0], args.slice(1), { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout);

	// Before anything else: the operator's gh must exist and be logged in.
	try {
		await execFn([ghBinary, "auth", "status"]);
	} catch (error) {
		err(isGhMissing(error) ? GH_INSTALL_MESSAGE : GH_AUTH_MESSAGE);
		return 1;
	}
	const githubApi = github ?? createGitHub({ root, repo: config.github.repo, gh: ghBinary, exec: execFn });

	// The configured labels must exist before any issue is imported (ticket 09).
	const { missing } = await checkLabels({ github: githubApi, config });
	if (missing.length) {
		err(missingLabelsMessage(await githubApi.repo(), missing));
		return 1;
	}
	const pollMin = config.github.pollMin ?? 5;
	log(`dark-factory: watching ${await githubApi.repo()} (a poll every ${pollMin} min; a STOP file or a signal ends it)`);

	const runGit = git ?? (async (args) => (await run("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout);
	const gitHead = async () => {
		try {
			return String(await runGit(["rev-parse", "HEAD"])).trim() || undefined;
		} catch {
			return undefined; // not a git repo, or no commit yet: nothing to push
		}
	};
	const stopped = () => existsSync(join(root, STOP_FILE));
	const sleepFor = sleep ?? ((ms) => sleepUntil(root, ms));

	for (;;) {
		const { imported } = await importIssues({ root, github: githubApi, config });
		for (const issue of imported) log(`github#${issue.number} imported: ${issue.title} → ${issue.feature}`);
		await printSync(await syncIssues({ root, github: githubApi, config, tracker }), log);

		// One frontier pass with today's runner, all features, until the frontier is empty.
		const before = config.github.push ? await gitHead() : undefined;
		const summary = await runFrontierImpl({
			root,
			tracker,
			backend,
			verify,
			config,
			workspace,
			classifyTicket,
			log: shiftLog,
			options: {},
		});
		for (const t of summary.resolved) log(`✔ ${t.feature}/${t.number} resolved: ${t.reason}`);
		for (const t of summary.reopened ?? []) log(`✖ ${t.feature}/${t.number} reopened by review: ${t.reason}`);
		for (const t of summary.needsInfo) log(`✖ ${t.feature}/${t.number} needs-info: ${t.reason}`);
		if (summary.stoppedReason) log(`⚠ Stopped: ${summary.stoppedReason}`);

		// The commits the comments link to need to be on GitHub: push after a pass that landed.
		if (config.github.push) {
			const after = await gitHead();
			if (after !== undefined && after !== before) {
				await runGit(["push", "origin", "HEAD"]);
				log(`dark-factory: pushed ${after.slice(0, 7)} to origin`);
			}
		}
		await printSync(await syncIssues({ root, github: githubApi, config, tracker }), log);

		if (summary.stoppedReason || stopped()) return 3;
		if (once) return 0;
		log(`dark-factory: waiting ${pollMin} min for the next poll`);
		if (await sleepFor(pollMin * 60_000)) {
			log("⚠ Stopped: STOP file");
			return 3;
		}
	}
}

/** Print one line per sync action (`posted` keys of `syncIssues`). */
async function printSync({ posted }, log) {
	for (const p of posted) log(`github#${p.number}: ${describePost(p.key)}`);
}

/** What one `posted` key means, as one line. */
function describePost(key) {
	if (key === "working") return "labeled working";
	if (key === "done") return "closed with a summary, labeled done";
	const [kind, number] = key.split(":");
	if (kind === "started") return `comment: work started on ticket ${number}`;
	if (kind === "resolved") return `comment: ticket ${number} resolved`;
	if (kind === "needs-info") return `comment: ticket ${number} needs information`;
	if (kind === "replied") return `comment: a collaborator replied (ticket ${number} back to ready)`;
	return `posted ${key}`;
}

/** Sleep `ms`, waking at least once a minute so a STOP file ends the wait early. */
async function sleepUntil(root, ms) {
	const end = Date.now() + ms;
	for (;;) {
		if (existsSync(join(root, STOP_FILE))) return true;
		const left = end - Date.now();
		if (left <= 0) return existsSync(join(root, STOP_FILE));
		await new Promise((resolve) => setTimeout(resolve, Math.min(left, WAKE_MS)));
	}
}
