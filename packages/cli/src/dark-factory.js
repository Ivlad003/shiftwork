import { existsSync } from "node:fs";
import { join } from "node:path";

import { openRunState, runFrontier } from "shiftwork-core";

import { execIn } from "./exec.js";
import { createGitHub, ghPreFlight, ghAuthMessage, ghInstallMessage, oneLine } from "./github.js";
import { importIssues } from "./github-import.js";
import { checkLabels, missingLabelsMessage } from "./github-labels.js";
import { parsePostKey } from "./github-post.js";
import { syncIssues } from "./github-sync.js";

const STOP_FILE = "STOP";
/** The wait between polls wakes at least this often, so a STOP file is noticed (like the runner's cooldown waits). */
const WAKE_MS = 60_000;
/** After failed GitHub polls the wait doubles, up to this (or `pollMin`, when longer). */
const BACKOFF_CAP_MS = 60 * 60_000;

// The gh pre-flight messages live with the wrapper (github.js); re-exported
// here for the TUI and the tests, which know them as dark-factory's (they take
// the command name; dark-factory passes none, so they use its own).
export { ghAuthMessage, ghInstallMessage };
/** `run --dark-factory` without a `github` block: there is nothing to watch. */
export const NO_GITHUB_CONFIG_MESSAGE = 'dark-factory needs a "github" block in .shiftwork/shiftwork.json (see docs/guide.md "Dark-factory mode")';

/**
 * `run --dark-factory` (spec: github-watch, ticket 05): watch the repo's GitHub
 * issues and work the frontier continuously.
 *
 * Every `github.pollMin` minutes one poll: `importIssues` (ticket 03), then
 * `syncIssues` (ticket 04), then a full frontier pass with today's
 * `runFrontier` until it is empty, then — with `github.push` on and a pass that
 * landed commits — `git push origin HEAD` in the main checkout, then sync
 * again. A failed push is caught and retried on the next poll; until one
 * succeeds, the sync's commit comments show short shas, not links (a commit
 * is linked only once the local remote-tracking refs show it on the remote).
 * It stops like the runner does: a STOP file or a signal ends it after the
 * current shift; `once` does one poll plus one frontier pass and returns 0.
 *
 * A failing gh call in the import or a sync (network, 5xx, rate limit, 403)
 * must not kill the watcher: it is logged as one line, the frontier pass still
 * runs, and the wait before the next poll doubles (capped at an hour) until a
 * poll gets through. An outsider's skipped issue is printed once per process.
 * The run state says running between passes (each `runFrontier` pass ends by
 * marking it idle) and not running once dark-factory returns.
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
	const execFn = exec ?? execIn(root);

	// Before anything else: the operator's gh must exist and be logged in.
	const problem = await ghPreFlight({ gh: ghBinary, exec: execFn });
	if (problem) {
		err(problem);
		return 1;
	}
	const githubApi = github ?? createGitHub({ root, repo: config.github.repo, gh: ghBinary, exec: execFn, warn: err });

	// The configured labels must exist before any issue is imported (ticket 09).
	const { missing } = await checkLabels({ github: githubApi, config });
	if (missing.length) {
		err(missingLabelsMessage(await githubApi.repo(), missing));
		return 1;
	}
	const pollMin = config.github.pollMin;
	log(`dark-factory: watching ${await githubApi.repo()} (a poll every ${pollMin} min; a STOP file or a signal ends it)`);

	// The run state records the mode (the TUI's header shows dark-factory while it is
	// live), whether it was started from the shell or with the TUI's `g`.
	const runState = openRunState(root);
	const markRunning = () => runState.update({ pid: process.pid, running: true, mode: "dark-factory" });
	await markRunning();
	try {
		return await watch();
	} finally {
		await runState.update({ pid: process.pid, running: false, finishedAt: new Date().toISOString() });
	}

	async function watch() {
		const runGit = git ?? ((args) => execIn(root)(["git", ...args]));
		const gitHead = async () => {
			try {
				return String(await runGit(["rev-parse", "HEAD"])).trim() || undefined;
			} catch {
				return undefined; // not a git repo, or no commit yet: nothing to push
			}
		};
		const stopped = () => existsSync(join(root, STOP_FILE));
		const sleepFor = sleep ?? ((ms) => sleepUntil(root, ms));

		// Commit links need the commits on GitHub, checked per commit by the sync
		// itself (`git branch -r --contains`); a failed `git push` is retried on
		// every poll until one succeeds.
		let retryPush = false;
		const syncOnce = () => syncIssues({ root, github: githubApi, config, tracker, git: runGit });

		// A failing gh call is one line in the log, never the end of the watcher:
		// the poll's other steps still run and the next wait backs off.
		const pollMs = pollMin * 60_000;
		let waitMs = pollMs;
		let pollFailed = false;
		const ghStep = async (step) => {
			try {
				await step();
			} catch (error) {
				pollFailed = true;
				log(`dark-factory: GitHub poll failed: ${oneLine(error)}`);
			}
		};
		// An outsider's issue is skipped on every poll; it is printed once per process.
		const reportedSkips = new Set();

		for (;;) {
			pollFailed = false;
			await ghStep(async () => {
				const { imported, skipped } = await importIssues({ root, github: githubApi, config });
				for (const issue of imported) log(`github#${issue.number} imported: ${issue.title} → ${issue.feature}`);
				for (const { number, login } of skipped) {
					if (reportedSkips.has(number)) continue;
					reportedSkips.add(number);
					log(`github#${number} skipped: ${login} is not a collaborator or in github.authors, and no collaborator added the in label`);
				}
			});
			await ghStep(async () => printSync(await syncOnce(), log));

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
				options: { holdOnNeedsInfo: true },
			});
			for (const t of summary.resolved) log(`✔ ${t.feature}/${t.number} resolved: ${t.reason}`);
			for (const t of summary.reopened ?? []) log(`✖ ${t.feature}/${t.number} reopened by review: ${t.reason}`);
			for (const t of summary.needsInfo) log(`✖ ${t.feature}/${t.number} needs-info: ${t.reason}`);
			if (summary.stoppedReason) log(`⚠ Stopped: ${summary.stoppedReason}`);
			// Each pass ends by marking the run state idle; dark-factory is still running.
			await markRunning();

			// The commits the comments link to need to be on GitHub: push after a pass
			// that landed. A failed push must not kill the watcher: it is retried on
			// the next poll, and until one succeeds the comments show short shas.
			if (config.github.push) {
				const after = await gitHead();
				if (after !== undefined && (after !== before || retryPush)) {
					try {
						await runGit(["push", "origin", "HEAD"]);
						retryPush = false;
						log(`dark-factory: pushed ${after.slice(0, 7)} to origin`);
					} catch (error) {
						retryPush = true;
						log(`dark-factory: git push failed: ${String(error?.message ?? error).trim()}; commit links stay short shas until it succeeds`);
					}
				}
			}
			await ghStep(async () => printSync(await syncOnce(), log));

			if (summary.stoppedReason || stopped()) return 3;
			if (once) return 0;
			waitMs = pollFailed ? Math.min(waitMs * 2, Math.max(pollMs, BACKOFF_CAP_MS)) : pollMs;
			log(`dark-factory: waiting ${waitMs / 60_000} min for the next poll`);
			if (await sleepFor(waitMs)) {
				log("⚠ Stopped: STOP file");
				return 3;
			}
		}
	}
}

/** Print one line per sync action (`posted` keys of `syncIssues`). */
async function printSync({ posted }, log) {
	for (const p of posted) log(`github#${p.number}: ${describePost(p.key)}`);
}

/** What one `posted` key means, as one line. */
function describePost(key) {
	const { kind, ticket } = parsePostKey(key);
	if (kind === "working") return "labeled working";
	if (kind === "summary") return "comment: closing summary";
	if (kind === "done") return "closed the issue";
	if (kind === "done-label") return "labeled done";
	if (kind === "working-removed") return "dropped the working label";
	if (kind === "started") return `comment: work started on ticket ${ticket}`;
	if (kind === "resolved") return `comment: ticket ${ticket} resolved`;
	if (kind === "needs-info") return `comment: ticket ${ticket} needs information`;
	if (kind === "replied") return `comment: a collaborator replied (ticket ${ticket} back to ready)`;
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
