import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { orderFrontier } from "./index.js";
import { classifyError, cooldownMs, isAuthError } from "./classify.js";
import { openCooldowns } from "./cooldowns.js";
import { applyProfileContext, createMeter } from "./meter.js";
import { chooseHandoffMode, cooldownKey, liftedFor, parseModelRef, planShift, resolveTicketBudget } from "./planner.js";
import { buildMergePrompt, buildReviewPrompt, buildShiftPrompt, REVIEWER_PROMPT, REVIEW_WRAP_UP_PROMPT, SOFT_LIMIT_STEER, STOP_STEER, WORKER_PROMPT } from "./prompt.js";
import { matchesGlob } from "./glob.js";
import { noRunState, openRunState } from "./run-state.js";

const NEEDS_INFO = "needs-info";
const RESOLVED = "resolved";
const READY = "ready-for-agent";
const CLAIMED = "claimed";
const STOP_FILE = "STOP";
const WAIT_STEP_MS = 60_000;
/** Only the runner's own shift reports: "### Shift N — <backend> <model> (<thinking>)". */
const SHIFT_REPORT = /^### Shift (\d+) — \S+ \S+ \([^)]*\)$/gm;
const MARKER = /<shiftwork:needs-info\s+reason="([^"]*)"\s*\/>/;
const RESEARCH_MARKER = /<shiftwork:needs-research\s+reason="([^"]*)"\s*\/>/;
const REVIEW_MARKER = /<shiftwork:review\s+verdict="([^"]*)"\s+reason="([^"]*)"\s*\/>/g;
const REVIEW_VERDICTS = new Set(["accept", "reopen", "follow-up"]);
/** Review findings kept in the ticket; the full review text stays in the review log. */
const REVIEW_FINDING_LINES = 40;
/** Recorded when two review shifts give no verdict: no silent accept, a human reviews by hand. */
const NO_VERDICT_REASON = "review gave no verdict twice; review it by hand";

/**
 * Decide what happens to a ticket after one attempt. Pure.
 * @returns {{ action: "resolve" | "retry" | "needs-info", reason?: string }}
 */
export function decideNext({ attempt, maxAttempts, needsInfo, hasVerify, verifyOk }) {
	if (needsInfo !== undefined && needsInfo !== null) return { action: NEEDS_INFO, reason: needsInfo || "agent asked for information" };
	if (!hasVerify) return { action: NEEDS_INFO, reason: "no Verify commands: a human must check this ticket" };
	if (verifyOk) return { action: "resolve" };
	if (attempt >= maxAttempts) return { action: NEEDS_INFO, reason: `verify gate failed after ${attempt} attempts` };
	return { action: "retry" };
}

function checkStop(root) {
	return existsSync(join(root, STOP_FILE));
}

/** Whether a resolved ticket gets a review shift: `review: { enabled, tier, features?, types? }`.
 * Both orders review — `review.when` decides only where the review runs (`reviewWhen`). */
export function shouldReview(config, ticket) {
	const review = config.review;
	if (!review?.enabled) return false;
	// A plan or research ticket's work is files under .scratch/, which git never commits: a
	// reviewer would judge an empty diff. Its gate (`tickets check`, `test -s research.md`) is its check.
	if (trackerOnly(ticket)) return false;
	if (review.features?.length && !review.features.includes(ticket.feature)) return false;
	if (review.types?.length && !review.types.includes(ticket.type)) return false;
	return true;
}

/** A ticket's `**Dual:**` line: yes opts it in, no opts it out, whatever `dual.enabled` says. */
const DUAL_YES = /^(?:yes|true|on)$/i;
/** Shift labels with a worker entry of their own beside the ticket's: dual candidates (ADR-0007) and the review. */
const DUAL_LABEL = /^(?:A|B|merge|review)$/;
const DUAL_NO = /^(?:no|false|off)$/i;

/** Whether a ticket gets dual shifts (ADR-0007): two worker shifts on two models in two
 * worktrees, then a merge shift. The ticket's own `**Dual:** yes|no` line wins; otherwise
 * `dual.enabled` with its `features` and `types` filters (the routed type). A plan or research
 * ticket never does: its work is tracker files, with nothing to merge. Pure. */
export function shouldDual(config, ticket) {
	if (trackerOnly(ticket)) return false;
	const own = String(ticket?.dual ?? "").trim();
	if (DUAL_YES.test(own)) return true;
	if (DUAL_NO.test(own)) return false;
	const dual = config.dual;
	if (!dual?.enabled) return false;
	if (dual.features?.length && !dual.features.includes(ticket.feature)) return false;
	if (ticket.type !== undefined && dual.types?.length && !dual.types.includes(ticket.type)) return false;
	return true;
}

/** Ticket types whose whole work is tracker files (new tickets, research.md) under .scratch/. */
const TRACKER_ONLY_TYPES = new Set(["plan", "research"]);
const trackerOnly = (ticket) => TRACKER_ONLY_TYPES.has(ticket?.type);

/** The frozen globs of a ticket: the config's list plus its own `**Frozen:**` line. A plan or
 * research ticket has none: its work is tracker files, never what a gate measures. */
function frozenOf(config, ticket) {
	if (trackerOnly(ticket)) return [];
	return [...new Set([...(config.frozen ?? []), ...(ticket.frozen ?? [])])];
}

/** The changed files of the ticket's branch that match a frozen glob; none without a worktree. */
async function frozenChanges(workspace, ticket, globs) {
	if (!globs.length || typeof workspace?.changedFiles !== "function") return [];
	return (await workspace.changedFiles(ticket)).filter((file) => globs.some((glob) => matchesGlob(file, glob)));
}

/** Whether this worked ticket gets a review shift: by its own Type (a plan or research ticket
 * never does, even when routing has no entry for it) and by the type it was routed as. */
function reviewsTicket(config, ticket, route) {
	return !trackerOnly(ticket) && shouldReview(config, { ...ticket, type: route.type });
}

/** Where the review shift runs: on the ticket's unlanded branch, before anything lands (the
 * default), or after the ticket has landed. `"resolve"` is `"after-land"`'s old name and
 * reads as it. Works with raw, unvalidated configs (a missing `when` is the default). */
export function reviewWhen(config) {
	return config.review?.when === "after-land" || config.review?.when === "resolve" ? "after-land" : "before-land";
}

/**
 * Parse the `--ticket` value `<feature>/<NN>` into its feature and padded number. An OpenSpec
 * task number (`<change>/1.2`) is taken as it is, unpadded. Pure; throws on any other shape.
 */
export function parseTicketSpec(spec) {
	const match = /^(.+)\/(\d+(?:\.\d+)*)$/.exec(String(spec ?? ""));
	if (!match) throw new Error(`ticket spec ${JSON.stringify(spec)} is not <feature>/<NN>`);
	const number = match[2].includes(".") ? match[2] : String(Number(match[2])).padStart(2, "0");
	return { feature: match[1], number };
}

/**
 * The part of a ticket file that is this ticket's own: in a file shared by several tickets
 * (OpenSpec's one .shiftwork.md per change, one `## N.M` section per task) the ticket's
 * section, up to the next `## N.M` heading; any other file is the ticket's whole. Pure.
 */
export function ticketSection(text, ticket) {
	const source = String(text ?? "");
	const number = String(ticket?.number ?? "");
	if (!/^\d+(?:\.\d+)*$/.test(number)) return source;
	const escaped = number.replaceAll(".", "\\.");
	const heading = new RegExp(`^## ${escaped}\\s*$`, "m").exec(source);
	if (!heading) return source;
	const rest = source.slice(heading.index + heading[0].length);
	const next = /^## \d+(?:\.\d+)*\s*$/m.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
}

/**
 * The frontier ticket named by `options.ticket` (`<feature>/<NN>`), or a throw with the
 * reason it is refused (`blocked by 02`, `status resolved`, `claimed by pid 123`): a ticket
 * that is not on the frontier is refused before anything is claimed or written.
 * A ticket whose claim is stale is on the frontier: the tracker reopens it.
 */
async function chosenTicket(tracker, spec) {
	const { feature, number } = parseTicketSpec(spec);
	const tickets = await tracker.list();
	const ticket = tickets.find((t) => t.feature === feature && t.number === number);
	if (!ticket) throw new Error(`--ticket ${spec} is not on the frontier: no such ticket`);
	if (ticket.featurePaused) throw new Error(`feature ${feature} is paused (shiftwork feature resume ${feature})`);
	const claim = (await tracker.activeClaims()).find((c) => c.ticket.feature === feature && c.ticket.number === number);
	if (claim) throw new Error(`--ticket ${spec} is not on the frontier: claimed by pid ${claim.pid}`);
	if (ticket.status !== READY && ticket.status !== CLAIMED) {
		throw new Error(`--ticket ${spec} is not on the frontier: status ${ticket.status}`);
	}
	const blockers = ticket.blockedBy.filter((n) => tickets.find((t) => t.feature === feature && t.number === n)?.status !== RESOLVED);
	if (blockers.length) throw new Error(`--ticket ${spec} is not on the frontier: blocked by ${blockers.join(", ")}`);
	return ticket;
}

/**
 * Work the frontier until nothing is left (or one ticket with `once`).
 * Every dependency is injected: tracker, backend, verify, log, classify, classifyTicket, clock, cooldowns.
 */
export async function runFrontier({
	root,
	tracker,
	backend,
	verify,
	config,
	workspace,
	log = () => {},
	options = {},
	classify = classifyError,
	classifyTicket,
	clock,
	cooldowns,
	runState,
}) {
	const maxAttempts = config.maxAttempts ?? 3;
	const summary = { resolved: [], needsInfo: [], reopened: [], stoppedReason: undefined };
	const seen = new Set();
	// The feature of the ticket last worked: the frontier is re-ordered with it as
	// `current`, so the runner stays on that feature while it has a ready ticket.
	let currentFeature = null;
	// A tracker ticket is identified by feature + number: the OpenSpec tracker shares
	// one .shiftwork.md path between all tasks of a change.
	const seenKey = (t) => (t.number === undefined ? t.path : `${t.feature}/${t.number}`);
	// A chosen ticket (`options.ticket`, `<feature>/<NN>`) is checked before anything is claimed
	// or written: one that is not on the frontier is refused with its reason (spec story 5).
	const chosen = options.ticket ? await chosenTicket(tracker, options.ticket) : null;
	// `--feature` on a paused feature is refused like a chosen ticket: before anything is claimed or written.
	if (
		options.feature &&
		(await tracker.list()).some((t) => t.feature === options.feature && t.featurePaused)
	) {
		throw new Error(`feature ${options.feature} is paused (shiftwork feature resume ${options.feature})`);
	}
	const time = clock ?? {
		now: () => new Date(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	const cooldownStore = cooldowns ?? openCooldowns(root);
	const state = runState ?? (root ? openRunState(root) : noRunState());
	// In-memory per-provider shift caps (`concurrency`): a serial run never fills one.
	// Cross-process caps are out of scope; the lock file (ticket 02) covers shared state, not slots.
	const slots = createProviderSlots(config.concurrency);
	// Models whose provider failed authentication (no API key, a rejected key): skipped by
	// every ticket for the rest of this run; never written to the cooldown store.
	const authBlocked = [];
	const parallel = options.parallel ?? config.parallel ?? 1;
	const counts = () => ({ resolved: summary.resolved.length, needsInfo: summary.needsInfo.length, reopened: summary.reopened.length });
	const recordOutcome = (ticket, outcome) => {
		if (outcome.action === "resolve") summary.resolved.push({ ...ticket, reason: outcome.reason, review: outcome.review });
		else if (outcome.action === "reopen") summary.reopened.push({ ...ticket, reason: outcome.reason, review: outcome.review });
		else if (outcome.action === NEEDS_INFO) summary.needsInfo.push({ ...ticket, reason: outcome.reason });
	};
	const workOne = async (ticket, ws = workspace) => {
		try {
			return await workTicket({
				root,
				ticket,
				tracker,
				backend,
				verify,
				config,
				workspace: ws,
				maxAttempts,
				log,
				classify,
				classifyTicket,
				clock: time,
				cooldowns: cooldownStore,
				runState: state,
				slots,
				authBlocked,
			});
		} finally {
			// The worker entry is gone once the shift settles: readers see only running shifts.
			await state.removeWorker(ticket);
		}
	};
	const frontierPage = async () => {
		let tickets = await tracker.frontier();
		// One tracker.list() per read, shared by the hold and the feature order below.
		const needsList = options.holdOnNeedsInfo || currentFeature;
		const listed = needsList ? await tracker.list() : [];
		// Dark-factory only: a needs-info ticket holds its whole feature for this pass,
		// so implementation waits until the next poll sees the answer. An ordinary
		// `shiftwork run` leaves `holdOnNeedsInfo` unset and still works the siblings.
		if (options.holdOnNeedsInfo) {
			const held = new Set(listed.filter((t) => t.status === NEEDS_INFO).map((t) => t.feature));
			tickets = tickets.filter((t) => !held.has(t.feature));
		}
		const page = tickets
			.filter((t) => !seen.has(seenKey(t)) && (!options.feature || t.feature === options.feature))
			.filter((t) => !chosen || (t.feature === chosen.feature && t.number === chosen.number));
		// A fresh runner takes the tracker's order (a started feature first, then name);
		// once it has worked a ticket, its feature is worked before any other.
		return currentFeature ? orderFrontier(page, listed, { current: currentFeature }) : page;
	};

	await state.update({
		pid: process.pid,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		feature: options.feature ?? null,
		workers: [],
		summary: { resolved: 0, needsInfo: 0, reopened: 0 },
	});

	// One worker failing is not the end of the run's bookkeeping: the pool lets the
	// others settle, and whatever throws (a worker, a release, a re-review), the run state
	// is finished below before the error propagates.
	let failure = null;
	try {
		// A resolved ticket whose last review never gave a verdict owes one: it is re-reviewed
		// before any new work, every run, until a review gives it a verdict (`--ticket` names one
		// frontier ticket and re-reviews nothing).
		if (!chosen) await reviewUnfinishedReviews();

		// `once` (and a chosen `ticket`) is one ticket however high `parallel` is: the serial loop keeps today's order exactly.
		if (parallel > 1 && !options.once && !chosen) failure = await runInPool();
		else
			for (;;) {
				if (checkStop(root)) {
					summary.stoppedReason = "STOP file";
					break;
				}
				const frontier = await frontierPage();
				if (frontier.length === 0) break;
				const ticket = frontier[0];
				seen.add(seenKey(ticket));

				const claim = await tracker.claim(ticket);
				if (!claim) continue;
				currentFeature = ticket.feature;
				let outcome;
				try {
					outcome = await workOne(ticket);
				} finally {
					await tracker.release(claim);
				}
				if (outcome.action === "stop") {
					summary.stoppedReason = outcome.reason;
					break;
				}
				// A research rollback: the ticket comes back once its research ticket resolves, this run too.
				if (outcome.action === "needs-research") seen.delete(seenKey(ticket));
				recordOutcome(ticket, outcome);
				await state.update({ summary: counts() });
				// A chosen ticket is worked once however the run ends: the loop stops after it.
				if (options.once || chosen) break;
			}
	} catch (error) {
		failure = error;
	}

	if (!summary.stoppedReason && checkStop(root)) {
		summary.stoppedReason = "STOP file";
	}

	summary.exitCode = summary.stoppedReason ? 3 : summary.needsInfo.length > 0 || summary.reopened.length > 0 ? 2 : 0;
	await state.update({
		running: false,
		finishedAt: new Date().toISOString(),
		stoppedReason: summary.stoppedReason ?? null,
		summary: counts(),
		workers: [],
	});
	if (failure) throw failure;
	return summary;

	/** Work up to `parallel` frontier tickets at once; after any one finishes, re-read the frontier.
	 * Returns the first worker error, if any, for the caller to propagate once every
	 * worker has settled. */
	async function runInPool() {
		// Landings (git merges in the root checkout) go through one in-process queue.
		const ws = workspace ? withLandingQueue(workspace) : undefined;
		const running = [];
		let stopping = false;
		let failure = null;
		const startWorker = (ticket, claim) => {
			const worker = (async () => {
				let outcome = null;
				let error = null;
				try {
					outcome = await workOne(ticket, ws);
				} catch (thrown) {
					error = thrown;
				}
				// A release that throws is this worker's failure, never a rejected race below.
				try {
					await tracker.release(claim);
				} catch (thrown) {
					error ??= thrown;
				}
				return { worker, ticket, outcome, error };
			})();
			return worker;
		};
		for (;;) {
			// A STOP file stops new tickets at once; the running shifts hand off on their own.
			if (!stopping && checkStop(root)) {
				summary.stoppedReason = "STOP file";
				stopping = true;
			}
			while (!stopping && running.length < parallel) {
				const frontier = await frontierPage();
				if (frontier.length === 0) break;
				const ticket = frontier[0];
				seen.add(seenKey(ticket));
				const claim = await tracker.claim(ticket);
				if (!claim) continue;
				currentFeature = ticket.feature;
				running.push(startWorker(ticket, claim));
			}
			if (running.length === 0) break;
			const done = await Promise.race(running);
			running.splice(running.indexOf(done.worker), 1);
			// A ticket worked to the end counts even when its release then threw.
			if (done.outcome && done.outcome.action !== "stop") recordOutcome(done.ticket, done.outcome);
			if (done.outcome?.action === "needs-research") seen.delete(seenKey(done.ticket));
			if (done.error) {
				// A failed worker ends the run, but only after the running shifts settle.
				failure ??= done.error;
				stopping = true;
				continue;
			}
			await state.update({ summary: counts() });
			if (done.outcome.action === "stop") {
				summary.stoppedReason ??= done.outcome.reason;
				stopping = true;
			}
		}
		return failure;
	}

	/** Re-review the tickets whose last review never gave a verdict (a stop, or no reviewer
	 * free), before any new work. A resolved ticket owes an after-land review of the landed
	 * change; a ready ticket owes a before-land one — its stopped review left it back on the
	 * frontier with its branch committed in the worktree, and this run resumes the review
	 * there instead of starting a new worker shift on it. A reopen puts the ticket back on
	 * the frontier — this same run works it again; `none` goes to needs-info as ever; accept
	 * and follow-up only complete the review — a before-land one lands the branch it just
	 * accepted — so the ticket stays resolved and nothing is re-worked; stopped again, or no
	 * reviewer free, leaves the verdict owed to the next run, with no worker shift in between. */
	async function reviewUnfinishedReviews() {
		if (!config.review?.enabled) return;
		const listed = await tracker.list();
		// A file shared by several tickets (OpenSpec's one .shiftwork.md per change) can't say
		// whose review is unfinished, or count one task's reopens: those are never resumed here.
		const perPath = new Map();
		for (const t of listed) perPath.set(t.path, (perPath.get(t.path) ?? 0) + 1);
		const owed = listed.filter(
			(t) =>
				(t.status === RESOLVED || (t.status === READY && workspace)) &&
				// A paused feature is off the frontier: no review is resumed, nothing of it lands.
				!t.featurePaused &&
				perPath.get(t.path) === 1 &&
				(!options.feature || t.feature === options.feature) &&
				shouldReview(config, t),
		);
		for (const t of owed) {
			if (checkStop(root)) {
				summary.stoppedReason ??= "STOP file";
				return;
			}
			const text = ticketSection(await readFile(t.path, "utf8"), t);
			// Unfinished only on the last review section's own status line, with no verdict: a
			// quoted not-finished line in findings is not a status line, so it never re-reviews.
			if (!reviewUnfinished(text)) continue;
			// Before-land: the stopped review was judging the ticket's unlanded branch in its
			// worktree, so the resumed one runs there too, on the branch it left committed. After-land:
			// the ticket is resolved, and the review reads the landed change in the repo.
			const beforeLand = t.status === READY;
			const cwd = beforeLand ? (await workspace.prepare(t)).cwd : undefined;
			const outcome = await runReviewShift({
				runState: state,
				root,
				ticket: t,
				tracker,
				backend,
				verify,
				config,
				clock: time,
				cooldowns: cooldownStore,
				log,
				type: t.type,
				...(beforeLand
					? {
							cwd,
							target: typeof workspace.target === "function" ? await workspace.target(t) : undefined,
							// The branch has not landed yet: a follow-up is filed only once it does.
							deferFollowUp: true,
						}
					: { landed: lastLandedLine(text) }),
				resumed: true,
				slots,
				authBlocked,
			});
			if (outcome.verdict === "skip" || outcome.verdict === "stopped") {
				// No worker shift on a ticket that owes a verdict: the frontier skips it this run,
				// and the verdict stays owed to the next one (the `Not run` note alone would end it).
				if (outcome.verdict === "skip") await tracker.appendComment(t, "- Review: not finished (no reviewer free this run)");
				else summary.stoppedReason ??= "STOP file";
				seen.add(seenKey(t));
				continue;
			}
			if (beforeLand) {
				// Accept (or a follow-up) on the resumed before-land review: land the branch it just
				// judged. A landing that fails or conflicts is not reworked here — no worker shift —
				// so the branch is kept and a human lands it.
				if (outcome.verdict === "accept" || outcome.verdict === "follow-up") {
					const landingNotes = [];
					// As after the worker's own before-land review: land only the work the review saw.
					if (typeof workspace.discardAfterReview === "function") {
						const discarded = await workspace.discardAfterReview(t);
						if (discarded.length) landingNotes.push(`- Discarded after review: ${discarded.join(", ")}`);
					}
					// No worker shift here, so a landing conflict is not redone (`conflictRedone`): it
					// is reported as a failed landing, the branch kept for a human.
					const landing = await landResolvedBranch({ ticket: t, workspace, verify, config, cwd, notes: landingNotes, conflictRedone: true, discardAfterReview: true });
					if (landing.outcome === "landed") {
						if (outcome.verdict === "follow-up") {
							const followUp = await createFollowUp(tracker, t, { root, type: t.type, reason: outcome.reason, verify: t.verify });
							landingNotes.push(followUpLine(followUp));
						}
						await tracker.appendComment(t, landingNotes.join("\n"));
						await tracker.setStatus(t, RESOLVED);
						summary.resolved.push({ ...t, reason: landing.message, review: outcome });
					} else {
						// "Branch kept" once: a landing that gave up on a moving target already kept it.
						if (!/ kept\b/.test(landing.reason ?? "")) landingNotes.push(`- Branch kept: ${(await workspace.keep(t)).branch}`);
						if (outcome.verdict === "follow-up") landingNotes.push("- Follow-up: not filed — the branch did not land");
						await tracker.appendComment(t, landingNotes.join("\n"));
						await tracker.setStatus(t, NEEDS_INFO);
						summary.needsInfo.push({ ...t, reason: landing.reason ?? "the landing failed; the branch is kept for a human", review: outcome });
					}
					await state.update({ summary: counts() });
					continue;
				}
				// A reopen on the resumed before-land review: bounded like the worker's own one —
				// after review.maxRounds reopens a human takes over, the branch kept; before that
				// the ticket is back on the frontier (runReviewShift put it there) and this same run
				// fixes it forward. `none` hands the branch to a human, needs-info as ever.
				if (outcome.verdict === "reopen") {
					const reopens = countReopenVerdicts(ticketSection(await readFile(t.path, "utf8"), t));
					if (reopens >= (config.review?.maxRounds ?? 2)) {
						const branch = (await workspace.keep(t)).branch;
						await tracker.appendComment(t, `- Review rejected it ${reopens} times; branch ${branch} kept`);
						await tracker.setStatus(t, NEEDS_INFO);
						summary.needsInfo.push({ ...t, reason: `review rejected it ${reopens} times; branch ${branch} kept`, review: outcome });
						await state.update({ summary: counts() });
						continue;
					}
					summary.reopened.push({ ...t, reason: outcome.reason, review: outcome });
				} else if (outcome.verdict === "none") {
					await tracker.appendComment(t, `- Branch kept: ${(await workspace.keep(t)).branch}`);
					summary.needsInfo.push({ ...t, reason: outcome.reason });
				} else {
					summary.resolved.push({ ...t, reason: outcome.reason, review: outcome });
				}
			} else if (outcome.verdict === "reopen") summary.reopened.push({ ...t, reason: outcome.reason, review: outcome });
			else if (outcome.verdict === "none") summary.needsInfo.push({ ...t, reason: outcome.reason });
			else summary.resolved.push({ ...t, reason: outcome.reason, review: outcome });
			await state.update({ summary: counts() });
			if (summary.stoppedReason) return;
		}
	}
}

/**
 * In-memory per-provider slot counters for `concurrency: { "<provider>": n }`:
 * at most n shifts of this process run at once on a provider. A serial run never fills one.
 */
function createProviderSlots(concurrency = {}) {
	const used = new Map(Object.keys(concurrency).map((provider) => [provider, 0]));
	return {
		/** Providers whose slots are all taken right now. */
		fullProviders() {
			return [...used].filter(([provider, n]) => n >= concurrency[provider]).map(([provider]) => provider);
		},
		/**
		 * Take a slot for one shift on `provider`: returns the release function, or null when
		 * every slot is taken (re-plan: the planner skips full providers like cooling ones).
		 */
		acquire(provider) {
			if (!used.has(provider)) return () => {};
			const n = used.get(provider);
			if (n >= concurrency[provider]) return null;
			used.set(provider, n + 1);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				used.set(provider, Math.max(0, used.get(provider) - 1));
			};
		},
	};
}

/** One landing at a time: git merges in the root checkout are serialised through an in-process queue. */
function withLandingQueue(workspace) {
	let queue = Promise.resolve();
	return {
		...workspace,
		land: (ticket) => {
			const landing = queue.then(() => workspace.land(ticket));
			queue = landing.catch(() => {});
			return landing;
		},
	};
}

/**
 * Land the ticket's resolved branch, re-running its gate on every rebased state while a
 * parallel landing keeps moving the target (up to `landRetries` rounds, default 5). Pushes the
 * landing notes into `notes`; the outcome tells the caller what happened: "landed" (message),
 * "redo" (a landing conflict: one fix-forward from the new target), or NEEDS_INFO (reason: the
 * target would not stand still, or the landing failed outright). In a parallel run every
 * `land` here goes through the queue in withLandingQueue, so the rounds stay
 * one-landing-at-a-time like any other landing. `discardAfterReview` (the before-land path):
 * after each rebase re-verify, what that gate left in the worktree is discarded again before
 * the next `land`, so a moved target cannot commit files the review never saw.
 */
async function landResolvedBranch({ ticket, workspace, verify, config, cwd, notes, conflictRedone, discardAfterReview = false }) {
	let landed = await workspace.land(ticket);
	let rebases = 0;
	while (!landed.ok && landed.rebase) {
		if (rebases >= (config.landRetries ?? 5)) {
			// The target moved once per round of the whole budget: the branch is kept, a human lands it.
			const branch = (await workspace.keep(ticket)).branch;
			return {
				outcome: NEEDS_INFO,
				reason: `the target kept moving (${rebases} rebases); branch ${branch} kept — land it with shiftwork run --ticket ${ticket.feature}/${ticket.number} or merge it by hand`,
			};
		}
		// A parallel landing moved the target: the branch is rebased onto it in its worktree,
		// and the gate must pass on that integrated state before the branch lands (story 4).
		rebases++;
		const integrated = await verify(ticket.verify, cwd);
		const failed = integrated.ok ? null : integrated.results.find((r) => r.code !== 0);
		notes.push(
			`- Target moved to ${landed.rebase}: branch rebased onto it, verify gate re-run: ${
				integrated.ok ? "passed" : `failed at \`${failed?.cmd}\` (${failed?.code})`
			}`,
		);
		if (!integrated.ok) {
			return { outcome: NEEDS_INFO, reason: `verify gate failed on the branch rebased onto ${landed.rebase} (\`${failed?.cmd}\`)` };
		}
		// The re-verify itself may leave files in the worktree (test strays, a tool): after an
		// accepted before-land review, discard them again before the next `land`, so it commits
		// only the work the review saw; the discarded paths go into the notes.
		if (discardAfterReview && typeof workspace.discardAfterReview === "function") {
			const discarded = await workspace.discardAfterReview(ticket);
			if (discarded.length) notes.push(`- Discarded after re-verify: ${discarded.join(", ")}`);
		}
		landed = await workspace.land(ticket);
	}
	notes.push(`- Landed: ${landed.message}`);
	if (landed.ok) return { outcome: "landed", message: landed.message };
	if (landed.conflict && !conflictRedone) {
		// One fix-forward per ticket: the note below tells the next shift what landed first.
		notes.push(`- Landing conflict with ${landed.conflict.files.join(", ") || "the target"}; redone on top of ${landed.conflict.commit}`);
		return { outcome: "redo" };
	}
	return { outcome: NEEDS_INFO, reason: `verify gate passed but landing failed: ${landed.message}` };
}

/** How many reopen verdicts the ticket already carries (the current review's own comment included). */
function countReopenVerdicts(text) {
	return (text.match(/^- Verdict: reopen\b/gm) ?? []).length;
}

async function workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log, classify, classifyTicket, clock, cooldowns, runState, slots, authBlocked = [] }) {
	let cwd = root;
	// Only this ticket's own section: OpenSpec tasks share one .shiftwork.md.
	const sectionOf = (text) => ticketSection(text, ticket);
	const initialText = sectionOf(await readFile(ticket.path, "utf8"));
	const earlier = [...initialText.matchAll(SHIFT_REPORT)].map((m) => Number(m[1]));
	// The last review of the ticket ended in reopen: the next shift's prompt points at its findings.
	const reopenedByReview = /^- Verdict: reopen/m.test(initialText.slice(Math.max(0, initialText.lastIndexOf("### Review"))));
	const firstShift = earlier.length ? Math.max(...earlier) + 1 : 1;
	let shiftNumber = firstShift;
	let firstPlan = true;
	let handoffCount = 0;
	let attempt = 1;
	let landedMessage = undefined;
	// One fix-forward per ticket: a landing conflict with a parallel landing gets the work
	// redone on top of it once; a second conflict goes to needs-info as before (spec story 4).
	let conflictRedone = false;
	let previousRoute = undefined;
	let exceededKind = undefined;
	let lastVerifyFailure = undefined;
	const blockedModels = [];
	const ticketUsage = { maxTokens: 0, maxCostUsd: 0, maxTurns: 0, maxWallMin: 0 };
	const maxHandoffs = config.maxHandoffs ?? 3;
	// Provider-limit shifts in a row: past maxLimitRetries the ticket stops instead of looping.
	const maxLimitRetries = config.maxLimitRetries ?? 10;
	let limitRetries = 0;
	const { classification, classificationNote } = await classifyUntyped(ticket, config, classifyTicket);
	const historyOf = (extra = {}) => ({ previousRoute, exceededKind, ticketUsage, blockedModels: [...blockedModels, ...authBlocked], ...extra });

	// Dual shifts (ADR-0007): a fresh ticket that asks for them is first worked by two candidates
	// on two models in two worktrees, then merged. The outcome feeds the loop below: a resolved
	// dual is its first round's shift (already reported), a failed one its next attempt.
	// A ticket whose dual round ran in an earlier run (a reopen, a needs-info answered) still has
	// its candidate branches: its `### Dual — A: …` block says so, and they go when it lands.
	const dualCandidates = /^### Dual — A: /m.test(initialText) ? DUAL_LABELS.map((label) => ({ ...ticket, suffix: label.toLowerCase() })) : [];
	let preset = null;
	const dual =
		earlier.length === 0 && !trackerOnly(ticket) && shouldDual(config, { ...ticket, type: undefined })
			? await runDualShifts({ root, ticket, tracker, backend, verify, config, workspace, log, classify, clock, cooldowns, runState, slots, authBlocked, classification, classificationNote, ticketUsage, shiftNumber, attempt, maxAttempts, candidates: dualCandidates })
			: { kind: "skip" };
	shiftNumber += dual.shifts ?? 0;
	if (dual.kind === "stop") {
		await tracker.setStatus(ticket, READY);
		return { action: "stop", reason: "STOP file" };
	}
	if (dual.kind === NEEDS_INFO) {
		await tracker.setStatus(ticket, NEEDS_INFO);
		return { action: NEEDS_INFO, reason: dual.reason };
	}
	if (dual.kind === "resolved") {
		cwd = dual.cwd;
		preset = dual;
	} else if (dual.kind === "retry") {
		cwd = dual.cwd;
		lastVerifyFailure = dual.lastVerifyFailure;
		attempt++;
	} else if (workspace) cwd = (await workspace.prepare(ticket)).cwd;
	// The dual candidates' branches stay until the ticket lands; then they go, like a landed branch.
	const dropDualCandidates = async () => {
		for (const candidate of dualCandidates.splice(0)) if (typeof workspace?.redo === "function") await workspace.redo(candidate);
	};

	for (;;) {
		if (checkStop(root)) {
			await tracker.setStatus(ticket, READY);
			return { action: "stop", reason: "STOP file" };
		}
		// A resolved dual is this round's shift: no planning, no new shift, its gate already run.
		const fromDual = preset;
		preset = null;
		let route;
		let shift;
		const getDiffStat = workspace ? () => workspace.diffStat(ticket) : undefined;
		if (fromDual) {
			route = fromDual.route;
			shift = fromDual.shift;
		} else {
			const now = clock.now();
			// Before every ticket, check every guessed cooldown; between its shifts, every probeEveryMin.
			await probeCooldowns({ backend, cooldowns, config, now, force: firstPlan && config.probeBeforeTicket !== false, log: (event) => log({ ticket, attempt, event }) });
			firstPlan = false;
			const activeCooldowns = await cooldowns.active(now);
			// A provider at its concurrency cap is skipped like a cooling one, but no cooldown is written.
			const plan = planShift({
				ticket,
				config,
				classification,
				history: historyOf(),
				cooldowns: activeCooldowns,
				now,
				fullProviders: slots ? slots.fullProviders() : [],
			});
			if (plan.wait) {
				const ms = Math.max(0, new Date(plan.wait).getTime() - now.getTime());
				log({ ticket, event: { type: "wait", until: plan.wait, ms } });
				// Wake at least once a minute so a STOP file is noticed during long cooldowns.
				await clock.sleep(Math.min(ms, WAIT_STEP_MS));
				continue;
			}
			if (plan.stop) {
				const notes = [];
				if (workspace) notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
				notes.push(`- Stopped: ${plan.stop}`);
				await tracker.appendComment(ticket, notes.join("\n"));
				await tracker.setStatus(ticket, NEEDS_INFO);
				return { action: NEEDS_INFO, reason: plan.stop };
			}
			route = plan;
			// The ticket budget is a total across every shift: once the earlier shifts used it up
			// (on a limit this route doesn't lift), no shift starts — a retry, a handoff or a limit retry alike.
			const remaining = remainingTicketBudget(ticket, config, ticketUsage, route);
			if (remaining.exhausted) {
				const notes = [];
				if (workspace) notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
				notes.push(`- Stopped: ticket budget exhausted (${remaining.reason})`);
				await tracker.appendComment(ticket, notes.join("\n"));
				await tracker.setStatus(ticket, NEEDS_INFO);
				return { action: NEEDS_INFO, reason: `ticket budget exhausted: ${remaining.reason}` };
			}
			// Take this shift's provider slot right after planning it: plan and acquire are
			// one synchronous block, so two workers can never take the last slot together.
			const releaseSlot = slots ? slots.acquire(route.provider) : undefined;
			if (slots && !releaseSlot) {
				// Planned before another worker took the last slot: re-plan shortly.
				log({ ticket, event: { type: "wait", provider: route.provider, ms: WAIT_STEP_MS } });
				await clock.sleep(WAIT_STEP_MS);
				continue;
			}
			const prompt = buildShiftPrompt(ticket, { root, attempt, absolute: cwd !== root, reopenedByReview, frozen: frozenOf(config, ticket) });
			const softLimitPct = config.softLimitPct ?? 80;
			const publish = await publishShift(runState ?? noRunState(), { ticket, attempt, shift: shiftNumber, route });
			try {
				shift = await runShift(
					backend,
					{
						root,
						cwd,
						route,
						prompt,
						systemPrompt: config.workerPrompt ?? WORKER_PROMPT,
						softLimitPct,
						getDiffStat,
						ticketPath: ticket.path,
						maxHandoffs,
						allowInPlace: Boolean(config.allowInPlace),
						// Planned while this shift holds its own slot, so a same-provider in-place
						// swap can look busy at a cap of 1; that only skips to another provider.
						planHandoff: (kind, fromRoute) =>
							planShift({
								ticket,
								config,
								classification,
								history: historyOf({ previousRoute: fromRoute, exceededKind: kind }),
								cooldowns: activeCooldowns,
								now: clock.now(),
								fullProviders: slots ? slots.fullProviders() : [],
							}),
					},
					(event) => {
						log({ ticket, attempt, event });
						publish(event);
					},
					{ sectionOf },
				);
			} finally {
				releaseSlot?.();
			}

			accumulateUsage(ticketUsage, shift);
		}

		if (shift.handoff?.kind === "stop") {
			const notes = [];
			if (!shift.handoff.agentNote) {
				notes.push(
					await buildHandoffNote({
						shiftNumber,
						from: route,
						to: undefined,
						reason: shift.handoff.reason ?? "STOP file",
						shift,
						verifyResult: null,
						getDiffStat,
					}),
				);
			}
			await tracker.appendComment(
				ticket,
				[
					shiftReport({
						number: shiftNumber,
						route,
						shift,
						verifyResult: null,
						decision: { action: "stop", reason: "STOP file" },
						classificationNote,
						ticketUsage,
					}),
					...notes,
				].join("\n"),
			);
			await tracker.setStatus(ticket, READY);
			return { action: "stop", reason: "STOP file" };
		}

		// A research rollback (`<shiftwork:needs-research/>`): what is missing is reading, not a human's
		// answer. A research ticket is filed in the feature and blocks this one, which stays ready, its
		// branch kept: the frontier works the research first. Not a failed attempt. Once per ticket — a
		// second one, or a tracker that cannot file tickets (OpenSpec), asks a human instead.
		if (shift.needsInfo === null && shift.needsResearch !== null && shift.needsResearch !== undefined) {
			const reason = shift.needsResearch || "the agent asked for research";
			const rolledBack = /^- Outcome: needs-research: /m.test(sectionOf(await readFile(ticket.path, "utf8")));
			if (rolledBack || typeof tracker.createTicket !== "function" || typeof tracker.addBlocker !== "function") shift.needsInfo = reason;
			else {
				const research = await fileResearchTicket(tracker, ticket, { reason });
				await tracker.addBlocker(ticket, research.number);
				const notes = workspace ? [`- Branch kept: ${(await workspace.keep(ticket)).branch}`] : [];
				const decision = { action: "needs-research", reason: `${reason} → ${ticket.feature}/${research.number}` };
				await tracker.appendComment(ticket, [shiftReport({ number: shiftNumber, route, shift, verifyResult: null, decision, classificationNote, ticketUsage }), ...notes].join("\n"));
				await tracker.setStatus(ticket, READY);
				return { action: "needs-research", reason, research };
			}
		}

		// No API key, a rejected key, not logged in: retrying that provider cannot help this run.
		// Its models are skipped by every ticket for the rest of the run, and no attempt is counted.
		// A backend that reports itself unavailable (a missing CLI, not logged in) cools as before.
		if (shift.error && shift.needsInfo === null && !isBackendUnavailable(shift.error, route) && isAuthError(shift.error, shift.errorKind)) {
			for (const ref of modelsOfProvider(config, route, ticket)) if (!authBlocked.includes(ref)) authBlocked.push(ref);
			await tracker.appendComment(
				ticket,
				[
					shiftReport({ number: shiftNumber, route, shift, verifyResult: null, decision: { action: "retry", reason: "auth error" }, classificationNote, ticketUsage }),
					`- Auth error: ${route.provider} — ${shift.error}; its models are skipped for this run, continuing without counting an attempt`,
				].join("\n"),
			);
			shiftNumber++;
			continue;
		}

		let limit = shift.error ? classify(shift.error, shift.errorHeaders, clock.now()) : null;
		if (!limit && shift.error && isBackendUnavailable(shift.error, route)) {
			limit = { kind: "usage" };
		}
		// Free models cool on their own; everything else cools its whole provider.
		const provider = route.model && String(route.model).endsWith(":free") ? cooldownKey(route.model) : route.provider;
		// A reset time at or before now is no reset time: the provider would be free again at
		// once and the same model rerun in a hot loop. The kind's default cooldown applies instead.
		const resetAt = limit?.resetAt && new Date(limit.resetAt).getTime() > clock.now().getTime() ? limit.resetAt : undefined;
		const until = limit ? (resetAt ?? new Date(clock.now().getTime() + cooldownMs(config, limit.kind))) : undefined;
		if (limit) await cooldowns.add(provider, until, limit.kind, { at: clock.now(), exact: Boolean(resetAt) });
		// The limit may have hit after the work was done: if the gate passes, the ticket is resolved.
		// With nothing changed, nobody worked the ticket yet: hand it on instead of judging the gate.
		const workedBeforeLimit = limit && (!workspace?.hasChanges || (await workspace.hasChanges(ticket)));
		// A plan or research ticket's gate checks tracker files (`tickets check`, `test -s …/research.md`):
		// the tracker's copy in the repo, never the worktree's stale copy of .scratch/.
		const gateCwd = trackerOnly(ticket) ? root : cwd;
		const limitGate = workedBeforeLimit && ticket.verify.length > 0 && shift.needsInfo === null ? await verify(ticket.verify, gateCwd) : null;
		// The agent's needs-info wins over a provider limit in the same shift: its question is asked.
		if (limit && !limitGate?.ok && shift.needsInfo === null) {
			limitRetries++;
			const capped = limitRetries >= maxLimitRetries;
			const reason = `provider limits hit ${limitRetries} times in a row (maxLimitRetries ${maxLimitRetries})`;
			const notes = [
				`- Provider limit: ${limit.kind} on ${provider}, cooling until ${until instanceof Date ? until.toISOString() : until}; ${
					capped ? "no more limit retries" : "continuing without counting an attempt"
				}`,
			];
			if (capped && workspace) notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
			await tracker.appendComment(
				ticket,
				[
					shiftReport({
						number: shiftNumber,
						route,
						shift,
						verifyResult: null,
						decision: capped ? { action: NEEDS_INFO, reason } : { action: "retry", reason: `provider ${limit.kind} limit` },
						classificationNote,
						ticketUsage,
					}),
					...notes,
				].join("\n"),
			);
			shiftNumber++;
			if (capped) {
				await tracker.setStatus(ticket, NEEDS_INFO);
				return { action: NEEDS_INFO, reason };
			}
			continue;
		}
		limitRetries = 0;

		const hasVerify = ticket.verify.length > 0;
		// A handed-off shift may already have finished the work: the gate decides either way.
		const verifyResult = fromDual ? fromDual.verifyResult : (limitGate ?? (shift.needsInfo === null && hasVerify ? await verify(ticket.verify, gateCwd) : null));
		let decision = decideNext({
			attempt,
			maxAttempts,
			needsInfo: shift.needsInfo,
			hasVerify,
			verifyOk: verifyResult?.ok ?? false,
		});

		const notes = [];
		const inPlaceHandoffs = shift.handoffs ?? [];
		let freshHandoff = shift.handoff && !shift.handoff.inPlace ? shift.handoff : null;
		// Frozen paths: a gate that passes on a branch that changed what it measures proves nothing.
		// The attempt fails like a failed gate (maxAttempts still ends it), the files named.
		const frozenHit = decision.action === "resolve" ? await frozenChanges(workspace, ticket, frozenOf(config, ticket)) : [];
		if (frozenHit.length) {
			notes.push(`- Frozen paths changed: ${frozenHit.join(", ")}`);
			freshHandoff = null;
			decision =
				attempt >= maxAttempts ? { action: NEEDS_INFO, reason: `frozen paths changed: ${frozenHit.join(", ")}` } : { action: "retry" };
			if (decision.action === NEEDS_INFO) notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}
		if (
			!freshHandoff &&
			verifyResult &&
			!verifyResult.ok &&
			config.onExceed?.verifyFailed &&
			decision.action === "retry"
		) {
			freshHandoff = { reason: "verify gate failed", kind: "verifyFailed" };
		}
		// A gate that passes with nothing changed doesn't test the ticket. If a budget cut the
		// shift short, nobody has worked the ticket yet: hand it on instead of giving up.
		// A plan or research ticket's work is new files under .scratch, which git excludes, so a
		// passing gate is the ticket done even when the product tree is untouched.
		const unchanged =
			!trackerOnly(ticket) && decision.action === "resolve" && workspace?.hasChanges ? !(await workspace.hasChanges(ticket)) : false;
		if (unchanged && freshHandoff) decision = { action: "retry" };
		let nextRoute = undefined;
		handoffCount += inPlaceHandoffs.length;
		for (const handoff of inPlaceHandoffs) {
			if (handoff.agentNote) continue;
			notes.push(
				await buildHandoffNote({
					shiftNumber,
					from: handoff.from ?? route,
					to: handoff.to,
					reason: handoff.reason,
					shift,
					verifyResult: verifyResult ?? lastVerifyFailure,
					getDiffStat,
				}),
			);
		}
		if (freshHandoff && decision.action !== "resolve") {
			// A handoff is not a failed attempt: only the verify gate after real work counts.
			// verifyFailed is the exception: the gate did fail, so the attempt still counts.
			if (decision.action === "retry" || decision.reason?.startsWith("verify gate failed")) decision = { action: "retry" };
			handoffCount++;
			rememberBlocked(blockedModels, route, freshHandoff.kind);
			const handoffHistory = historyOf({ previousRoute: route, exceededKind: freshHandoff.kind });
			// Planned with the same inputs as the next shift's real plan, so the note names the
			// model that runs next — never a cooling or full one. A wait or a stop names none.
			const handoffNow = clock.now();
			const planned = planShift({
				ticket,
				config,
				classification,
				history: handoffHistory,
				cooldowns: await cooldowns.active(handoffNow),
				now: handoffNow,
				fullProviders: slots ? slots.fullProviders() : [],
			});
			nextRoute = planned.model ? { ...planned, backend: backend.name } : undefined;
			if (!freshHandoff.agentNote) {
				const handoffNote = await buildHandoffNote({
					shiftNumber,
					from: freshHandoff.from ?? route,
					to: nextRoute,
					reason: freshHandoff.reason,
					shift,
					verifyResult: verifyResult ?? lastVerifyFailure,
					getDiffStat,
				});
				notes.push(handoffNote);
			}
		}
		if (handoffCount > maxHandoffs && decision.action !== "resolve") {
			notes.push(`- Handoff limit: ${maxHandoffs} handoffs already used`);
			decision = { action: NEEDS_INFO, reason: `maxHandoffs (${maxHandoffs}) exceeded` };
		}

		if (unchanged && decision.action === "resolve") {
			decision = { action: NEEDS_INFO, reason: "verify gate passed but no shift changed anything: the gate doesn't test this ticket" };
		}
		let redoNext = false;
		// Before-land: the review shift judges the unlanded branch in its worktree first (in the
		// resolve branch below); the landing, and its notes, happen only after the review accepts.
		const reviewed = reviewsTicket(config, ticket, route);
		const beforeLand = workspace && decision.action === "resolve" && reviewWhen(config) === "before-land" && reviewed;
		if (!beforeLand && workspace && decision.action === "resolve") {
			const landing = await landResolvedBranch({ ticket, workspace, verify, config, cwd, notes, conflictRedone });
			if (landing.outcome === "landed") {
				landedMessage = landing.message;
				await dropDualCandidates();
			} else if (landing.outcome === "redo") {
				conflictRedone = true;
				redoNext = true;
				// The report says what happens next: this shift's work is redone, not resolved.
				decision = { action: "redo", reason: "landing conflict" };
			} else decision = { action: NEEDS_INFO, reason: landing.reason };
		}
		if (workspace && decision.action === NEEDS_INFO && notes.length === 0) {
			notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}

		// Before-land, a passed gate is not resolved yet: the review decides whether the branch lands.
		const reported = beforeLand && decision.action === "resolve" ? { ...decision, reviewNext: true } : decision;
		// A dual round's shifts are reported already (candidates, merge, the `### Dual` block): only its notes follow.
		if (!fromDual) {
			await tracker.appendComment(ticket, [shiftReport({ number: shiftNumber, route, shift, verifyResult, decision: reported, classificationNote, ticketUsage }), ...notes].join("\n"));
			shiftNumber++;
		} else if (notes.length) await tracker.appendComment(ticket, notes.join("\n"));

		if (redoNext) {
			// The landing conflicted with a parallel one (noted above): one more shift, in a fresh
			// worktree prepared from the new target, on top of what landed first.
			if (typeof workspace.redo === "function") await workspace.redo(ticket);
			cwd = (await workspace.prepare(ticket)).cwd;
			continue;
		}

		if (decision.action === "resolve") {
			// Before-land: one review shift judges the unlanded branch, in the ticket's worktree,
			// before anything lands; a landing after an accepted review re-runs the gate only, never
			// the review.
			let review = null;
			if (beforeLand) {
				// The reviewer judges `git diff <target>...HEAD`: commit the shift's work on the branch
				// first (the landing's own commit), or that range is empty.
				if (typeof workspace.commit === "function") await workspace.commit(ticket);
				review = await runReviewShift({
					runState,
					root,
					ticket,
					tracker,
					backend,
					verify,
					config,
					clock,
					cooldowns,
					log,
					type: route.type,
					cwd,
					target: typeof workspace.target === "function" ? await workspace.target(ticket) : undefined,
					slots,
					authBlocked,
					// A follow-up is filed only once the branch has landed: not for work that never lands.
					deferFollowUp: true,
				});
				if (review.verdict === "reopen") {
					// Reopen rounds are bounded: after review.maxRounds reopens on one ticket a human
					// takes over — nothing has landed, the branch and its worktree are kept.
					const reopens = countReopenVerdicts(ticketSection(await readFile(ticket.path, "utf8"), ticket));
					if (reopens >= (config.review?.maxRounds ?? 2)) {
						const branch = (await workspace.keep(ticket)).branch;
						await tracker.appendComment(ticket, `- Review rejected it ${reopens} times; branch ${branch} kept`);
						await tracker.setStatus(ticket, NEEDS_INFO);
						return { action: NEEDS_INFO, reason: `review rejected it ${reopens} times; branch ${branch} kept` };
					}
					// runReviewShift has put the ticket back to ready-for-agent: the next shift
					// continues on the same branch and worktree, with the review findings in its prompt.
					return { action: "reopen", reason: review.reason, review };
				}
				// No verdict twice is no silent accept: nothing lands, the branch is kept for a human.
				if (review.verdict === "none") {
					await tracker.appendComment(ticket, `- Branch kept: ${(await workspace.keep(ticket)).branch}`);
					return { action: NEEDS_INFO, reason: review.reason, review };
				}
				// A review stopped by the runner stopping is no missing verdict: no retry, no needs-info —
				// nothing lands, the ticket goes back to the frontier, the next run reviews it again.
				if (review.verdict === "stopped") {
					await tracker.setStatus(ticket, READY);
					return { action: "stop", reason: "STOP file" };
				}
				// No reviewer free is no silent accept either: nothing lands, the branch stays in its
				// worktree, and the ticket goes back to the frontier owing the review — the next run's
				// reviewUnfinishedReviews resumes it there before any worker shift.
				if (review.verdict === "skip") {
					await tracker.appendComment(ticket, "- Review: not finished (no reviewer free this run)");
					await tracker.setStatus(ticket, READY);
					return { action: "deferred", reason: `review not run: ${review.reason}`, review };
				}
				// accept or follow-up (filed below, once landed): land.
				const landingNotes = [];
				// What the review round left in the worktree (reviewer edits, verify strays) is
				// discarded first, so the landing commits only the work the review saw; the
				// discarded paths go into the landing notes.
				if (typeof workspace.discardAfterReview === "function") {
					const discarded = await workspace.discardAfterReview(ticket);
					if (discarded.length) landingNotes.push(`- Discarded after review: ${discarded.join(", ")}`);
				}
				const landing = await landResolvedBranch({ ticket, workspace, verify, config, cwd, notes: landingNotes, conflictRedone, discardAfterReview: true });
				if (landing.outcome === "redo") {
					// The landing conflicted with a parallel one: the work is redone in a fresh
					// worktree, and the redone work gets a fresh review after its gate passes.
					conflictRedone = true;
					await tracker.appendComment(ticket, landingNotes.join("\n"));
					if (typeof workspace.redo === "function") await workspace.redo(ticket);
					cwd = (await workspace.prepare(ticket)).cwd;
					continue;
				}
				if (landing.outcome === "landed") {
					await dropDualCandidates();
					if (review.verdict === "follow-up") {
						review.followUp = await createFollowUp(tracker, ticket, { root, type: route.type, reason: review.reason, verify: ticket.verify });
						landingNotes.push(followUpLine(review.followUp));
					}
					await tracker.appendComment(ticket, landingNotes.join("\n"));
					landedMessage = landing.message;
				} else {
					if (landingNotes.length === 0) landingNotes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
					if (review.verdict === "follow-up") landingNotes.push("- Follow-up: not filed — the branch did not land");
					await tracker.appendComment(ticket, landingNotes.join("\n"));
					await tracker.setStatus(ticket, NEEDS_INFO);
					return { action: NEEDS_INFO, reason: landing.reason };
				}
			}
			await tracker.setStatus(ticket, RESOLVED);
			const reason = landedMessage ?? (notes.length ? notes[notes.length - 1].replace(/^- Landed: /, "") : "verify passed");
			// After a landing (or without a workspace, before-land included), one review shift in
			// a fresh context judges the work (stories 4–6).
			if (!beforeLand && reviewed) {
				review = await runReviewShift({
					runState,
					root,
					ticket,
					tracker,
					backend,
					verify,
					config,
					clock,
					cooldowns,
					log,
					type: route.type,
					landed: landedMessage,
					slots,
					authBlocked,
				});
				if (review.verdict === "reopen") return { action: "reopen", reason: review.reason, review };
				// No verdict twice is no silent accept: the ticket goes to needs-info, the landed commit stays.
				if (review.verdict === "none") return { action: NEEDS_INFO, reason: review.reason, review };
			}
			return { action: "resolve", reason, review: review ?? undefined };
		}
		if (decision.action === NEEDS_INFO) {
			await tracker.setStatus(ticket, NEEDS_INFO);
			return { action: NEEDS_INFO, reason: decision.reason };
		}

		if (freshHandoff && decision.action === "retry" && handoffCount <= maxHandoffs) {
			previousRoute = route;
			exceededKind = freshHandoff.kind;
			if (freshHandoff.kind === "verifyFailed" && verifyResult && !verifyResult.ok) {
				lastVerifyFailure = verifyResult.results?.find((r) => r.code !== 0) ?? null;
				attempt++;
			}
			// Before starting the next shift, make sure the ticket budget isn't exhausted —
			// except on a limit the route about to run lifts (`liftedFor`).
			const remainingTicket = remainingTicketBudget(ticket, config, ticketUsage, nextRoute);
			if (remainingTicket.exhausted) {
				await tracker.appendComment(ticket, `### Handoff blocked\n- Reason: ticket budget exhausted (${remainingTicket.reason})`);
				await tracker.setStatus(ticket, NEEDS_INFO);
				return { action: NEEDS_INFO, reason: `ticket budget exhausted: ${remainingTicket.reason}` };
			}
			continue;
		}

		if ((verifyResult && !verifyResult.ok) || frozenHit.length) {
			lastVerifyFailure = verifyResult?.ok ? null : (verifyResult.results?.find((r) => r.code !== 0) ?? null);
			attempt++;
			previousRoute = undefined;
			exceededKind = undefined;
		}

		if (checkStop(root)) {
			await tracker.setStatus(ticket, READY);
			return { action: "stop", reason: "STOP file" };
		}
	}
}

const DUAL_LABELS = ["A", "B"];

/**
 * The dual phase of a fresh ticket (ADR-0007): two candidate shifts on two models (different
 * providers when the config allows), each in its own worktree on `shiftwork/<feature>-<NN>-a|b`,
 * at the same time as far as the provider slots allow, each through its own Verify gate. Both
 * pass: a merge shift on `dual.mergeTier` (the review tier by default) combines them in the
 * ticket's own worktree, started from A's branch; a merge that fails its gate is dropped and A
 * taken. One passes: it is taken without a merge. Neither: the next attempt is an ordinary single
 * shift from the target. The ticket's own branch then goes through the usual review and landing.
 * Every shift here is reported (candidates, merge) with a `### Dual` summary; `shifts` is how
 * many. Returns `kind`: "skip" (not dual after all), "single" (dual impossible, warned),
 * "resolved" (`cwd`, `route`, `shift`, `verifyResult` of the ticket's branch), "retry" (`cwd`,
 * `lastVerifyFailure`), "stop" or NEEDS_INFO (`reason`). Candidates go into `candidates`.
 */
async function runDualShifts(ctx) {
	const { root, ticket, tracker, config, workspace, clock, cooldowns, classification, ticketUsage, authBlocked, attempt, maxAttempts, candidates } = ctx;
	const single = async (why) => {
		await tracker.appendComment(ticket, `### Dual\n- Warning: ${why}; worked as a single shift`);
		return { kind: "single" };
	};
	const now = clock.now();
	const routes = planDualRoutes({ ticket, config, classification, ticketUsage, authBlocked, cooldowns: await cooldowns.active(now), now });
	// No first route (every model cooling, or none): the ordinary loop waits or stops as ever.
	if (!routes) return { kind: "skip" };
	// The `types` filter needs the routed type, known only now.
	if (!shouldDual(config, { ...ticket, type: routes[0].type })) return { kind: "skip" };
	if (!ticket.verify.length) return single("dual shifts need Verify commands to compare the candidates");
	if (!workspace || typeof workspace.diff !== "function") return single("dual shifts need worktrees (worktree.enabled is false or --no-worktree)");
	if (routes.length < 2) return single(`no second model to run beside ${routes[0].ref ?? routes[0].model}`);
	const remaining = remainingTicketBudget(ticket, config, ticketUsage, routes[0]);
	if (remaining.exhausted) return { kind: "skip" };

	const results = await Promise.all(
		routes.map((route, i) => runDualCandidate({ ...ctx, route, label: DUAL_LABELS[i], candidate: { ...ticket, suffix: DUAL_LABELS[i].toLowerCase() } })),
	);
	for (const r of results) if (!candidates.some((c) => c.suffix === r.candidate.suffix)) candidates.push(r.candidate);
	let number = ctx.shiftNumber;
	const reports = [];
	for (const r of results) {
		if (!r.shift) continue;
		accumulateUsage(ticketUsage, r.shift);
		reports.push(
			shiftReport({
				number: number++,
				route: r.route,
				shift: r.shift,
				verifyResult: r.verifyResult,
				decision: { action: "dual", reason: `dual candidate ${r.label} on ${r.branch}${r.verifyResult?.ok && !r.changed ? " (gate passed with nothing changed)" : ""}` },
				classificationNote: ctx.classificationNote,
				ticketUsage,
			}),
		);
	}
	if (reports.length) await tracker.appendComment(ticket, reports.join("\n"));
	const branches = results.map((r) => r.branch).join(", ");
	const summary = (merge, notes = []) => tracker.appendComment(ticket, [dualHeading(results, merge), ...notes].join("\n"));
	const shifts = () => number - ctx.shiftNumber;

	if (results.some((r) => r.stopped)) {
		await summary("stopped", [`- Candidates kept: ${branches}`]);
		return { kind: "stop", shifts: shifts() };
	}
	const passed = results.filter((r) => r.passed);
	if (passed.length === 0) {
		// Needs-info only when both candidates asked; one question beside a failed gate is a failed attempt.
		const asked = results.every((r) => r.shift?.needsInfo != null) ? results[0].shift.needsInfo : null;
		const failed = results.map((r) => r.verifyResult?.results?.find((x) => x.code !== 0)).find(Boolean) ?? null;
		const decision = decideNext({ attempt, maxAttempts, needsInfo: asked, hasVerify: true, verifyOk: false });
		if (decision.action !== "retry") {
			for (const r of results) await workspace.keep(r.candidate);
			await summary("skipped — neither passed its gate", [`- Candidates kept: ${branches}`]);
			return { kind: NEEDS_INFO, reason: decision.reason, shifts: shifts() };
		}
		await summary("skipped — neither passed its gate", [`- Candidates kept: ${branches} (until the ticket lands); the next attempt starts from the target`]);
		return { kind: "retry", cwd: (await workspace.prepare(ticket)).cwd, lastVerifyFailure: failed, shifts: shifts() };
	}

	// The better-verified candidate: the one that passed, or A when both did.
	const best = passed[0];
	const take = async (merge) => {
		await summary(merge, [`- Candidates kept: ${branches} (until the ticket lands)`]);
		const { cwd } = await workspace.prepare(ticket, { from: best.branch });
		return { kind: "resolved", cwd, route: best.route, shift: settled(best.shift), verifyResult: best.verifyResult, shifts: shifts() };
	};
	if (passed.length === 1) return take(`skipped — only ${best.label} passed its gate`);

	// Both passed: one merge shift, in a fresh context, in the ticket's own worktree from A's branch.
	const mergeRoute = planMergeRoute({ ticket, config, classification, ticketUsage, authBlocked, cooldowns: await cooldowns.active(clock.now()), now: clock.now(), routeA: routes[0] });
	if (!mergeRoute) return take(`skipped — no ${mergeTierOf(config, routes[0])} model free; took ${best.label}`);
	const left = remainingTicketBudget(ticket, config, ticketUsage, mergeRoute);
	if (left.exhausted) return take(`skipped — ticket budget exhausted (${left.reason}); took ${best.label}`);
	const target = typeof workspace.target === "function" ? await workspace.target(ticket) : undefined;
	const stats = await Promise.all(results.map((r) => workspace.diff(r.candidate).catch(() => ({}))));
	const { cwd } = await workspace.prepare(ticket, { from: best.branch });
	const merge = await runDualShift({
		...ctx,
		route: mergeRoute,
		cwd,
		prompt: buildMergePrompt(ticket, {
			root,
			target,
			base: best.label,
			candidates: results.map((r, i) => ({ label: r.label, model: r.route.ref ?? r.route.model, branch: r.branch, verify: verifyLine(r.verifyResult), stat: stats[i]?.stat })),
		}),
		getDiffStat: () => workspace.diffStat(ticket),
		logAs: "merge",
	});
	accumulateUsage(ticketUsage, merge.shift);
	const stopped = merge.shift.handoff?.kind === "stop";
	const mergeGate = !stopped && merge.shift.needsInfo === null ? await ctx.verify(ticket.verify, cwd) : null;
	await tracker.appendComment(
		ticket,
		shiftReport({ number: number++, route: mergeRoute, shift: merge.shift, verifyResult: mergeGate, decision: { action: "dual", reason: `dual merge of ${results.map((r) => r.label).join(" and ")} from ${best.branch}` }, classificationNote: ctx.classificationNote, ticketUsage }),
	);
	const mergeName = `${mergeRoute.backend} ${mergeRoute.model} (${mergeRoute.thinking})`;
	if (stopped) {
		await summary(`${mergeName}, stopped`, [`- Candidates kept: ${branches}`]);
		return { kind: "stop", shifts: shifts() };
	}
	if (mergeGate?.ok) {
		await summary(`${mergeName}, merged (verify passed)`, [`- Candidates kept: ${branches} (until the ticket lands)`]);
		return { kind: "resolved", cwd, route: { ...mergeRoute, type: routes[0].type, typeSource: routes[0].typeSource }, shift: settled(merge.shift), verifyResult: mergeGate, shifts: shifts() };
	}
	// The merge did not hold: its work is dropped, and the ticket's branch starts again from A's.
	const why = merge.shift.needsInfo !== null ? `asked for information (${merge.shift.needsInfo})` : merge.shift.error ? `failed (${merge.shift.error})` : verifyLine(mergeGate);
	if (typeof workspace.redo === "function") await workspace.redo(ticket);
	return take(`${mergeName}, ${why}; took ${best.label}`);
}

/** A dual shift settled by the dual phase: no handoff, error or question left for the loop to act on. */
function settled(shift) {
	return { ...shift, handoff: null, handoffs: [], error: null, needsInfo: null, needsResearch: null };
}

/** "verify passed", or where the gate failed. */
function verifyLine(result) {
	if (result?.ok) return "verify passed";
	if (!result) return "verify not run";
	const failed = result.results?.find((r) => r.code !== 0);
	return failed ? `verify failed at \`${failed.cmd}\` (exit ${failed.code})` : "verify failed";
}

/** `### Dual — A: <route>, <verify>; B: <route>, <verify>; merge: <outcome>`. */
function dualHeading(results, merge) {
	const parts = results.map((r) => {
		const gate = r.verifyResult?.ok && !r.changed ? "verify passed with nothing changed" : r.shift?.needsInfo != null ? `needs-info: ${r.shift.needsInfo}` : verifyLine(r.verifyResult);
		return `${r.label}: ${r.route.backend} ${r.route.model} (${r.route.thinking}), ${gate}`;
	});
	return `### Dual — ${parts.join("; ")}; merge: ${merge}`;
}

/** The merge shift's tier: `dual.mergeTier`, else the review tier, else candidate A's. */
function mergeTierOf(config, routeA) {
	return config.dual?.mergeTier ?? (config.review?.enabled !== false ? config.review?.tier : undefined) ?? routeA.tier;
}

/** A config whose every route goes to `tier`: the ticket keeps its routed type, the tier is forced. */
function onTier(config, tier) {
	const routing = Object.fromEntries(Object.entries(config.routing ?? {}).map(([type, r]) => [type, { ...r, tier, model: undefined }]));
	return { ...config, routing, defaultTier: tier };
}

/**
 * The two candidates' routes, or null when the first cannot be planned (every model cooling or
 * none: the ordinary loop waits or stops). `dual.models` pins both; `dual.tiers` routes each on its
 * tier; otherwise A is the ticket's ordinary route and B the next one on another provider — on the
 * same provider only when no other has a model. A one-route array: there is no second model.
 */
function planDualRoutes({ ticket, config, classification, ticketUsage, authBlocked, cooldowns, now }) {
	const plan = (over, blocked = []) => {
		try {
			const route = planShift({
				ticket: over.ticket ?? ticket,
				config: over.config ?? config,
				classification,
				history: { ticketUsage, blockedModels: [...authBlocked, ...blocked] },
				cooldowns,
				now,
			});
			return route.model ? route : null;
		} catch {
			return null;
		}
	};
	const dual = config.dual ?? {};
	if (dual.models?.length === 2) {
		const [a, b] = dual.models.map((model) => plan({ ticket: { ...ticket, model } }));
		return a ? (b ? [a, b] : [a]) : null;
	}
	if (dual.tiers?.length === 2) {
		const unpinned = { ...ticket, model: undefined };
		const a = plan({ ticket: unpinned, config: onTier(config, dual.tiers[0]) });
		if (!a) return null;
		const b = plan({ ticket: unpinned, config: onTier(config, dual.tiers[1]) }, [a.ref ?? a.model]);
		return b ? [a, b] : [a];
	}
	const a = plan({});
	if (!a) return null;
	const otherProvider = plan({}, modelsOfProvider(config, a, ticket));
	const b = otherProvider ?? plan({}, [a.ref ?? a.model]);
	return b ? [a, b] : [a];
}

/** The merge shift's route on the merge tier, the ticket's routed type kept; its budget is
 * `dual.budget` when set. Null when no model of the tier is free. */
function planMergeRoute({ ticket, config, classification, ticketUsage, authBlocked, cooldowns, now, routeA }) {
	const tier = mergeTierOf(config, routeA);
	let route;
	try {
		route = planShift({
			ticket: { ...ticket, model: undefined },
			config: tier ? onTier(config, tier) : config,
			classification,
			history: { ticketUsage, blockedModels: [...authBlocked] },
			cooldowns,
			now,
		});
	} catch {
		return null;
	}
	if (!route.model) return null;
	return config.dual?.budget ? { ...route, budget: config.dual.budget } : route;
}

/** One candidate: its own worktree, its own shift, its own gate; the work committed on its
 * branch so `git diff <target>...<branch>` shows it. */
async function runDualCandidate(ctx) {
	const { root, ticket, candidate, label, route, workspace, attempt } = ctx;
	const { cwd, branch } = await workspace.prepare(candidate);
	const branchName = branch ?? `${candidate.feature}-${candidate.number}-${candidate.suffix}`;
	const { shift } = await runDualShift({
		...ctx,
		cwd,
		prompt: buildShiftPrompt(ticket, { root, attempt, absolute: true, dual: label, frozen: frozenOf(ctx.config, ticket) }),
		getDiffStat: () => workspace.diffStat(candidate),
		logAs: label,
	});
	if (!shift) return { label, route, branch: branchName, candidate, shift: null, stopped: true, passed: false };
	const stopped = shift.handoff?.kind === "stop";
	const verifyResult = !stopped && shift.needsInfo === null ? await ctx.verify(ticket.verify, cwd) : null;
	const changed = typeof workspace.hasChanges === "function" ? await workspace.hasChanges(candidate) : true;
	if (typeof workspace.commit === "function") await workspace.commit(candidate);
	return { label, route, branch: branchName, candidate, cwd, shift, verifyResult, changed, stopped, passed: Boolean(verifyResult?.ok) && changed };
}

/** One shift of the dual phase on `route`: its provider slot (waited for), no handoffs (its
 * budget's hard limit ends it), a provider limit cools the provider as ever. `shift` is null when
 * the runner stopped before a slot was free. */
async function runDualShift({ root, ticket, backend, config, route, cwd, prompt, getDiffStat, logAs, log, classify, clock, cooldowns, runState, slots, attempt }) {
	let release;
	for (;;) {
		release = slots ? slots.acquire(route.provider) : undefined;
		if (!slots || release) break;
		if (checkStop(root)) return { shift: null };
		log({ ticket, attempt, dual: logAs, event: { type: "wait", provider: route.provider, ms: WAIT_STEP_MS } });
		await clock.sleep(WAIT_STEP_MS);
	}
	const publish = await publishShift(runState ?? noRunState(), { ticket, attempt, shift: logAs, route });
	let shift;
	try {
		shift = await runShift(
			backend,
			{
				root,
				cwd,
				route,
				prompt,
				systemPrompt: config.workerPrompt ?? WORKER_PROMPT,
				softLimitPct: config.softLimitPct ?? 80,
				getDiffStat,
				ticketPath: ticket.path,
				maxHandoffs: 0,
				allowInPlace: false,
			},
			(event) => {
				log({ ticket, attempt, dual: logAs, event });
				publish(event);
			},
			{ sectionOf: (text) => ticketSection(text, ticket) },
		);
	} finally {
		release?.();
		// A finished candidate leaves the live view while its sibling may still be running.
		await runState?.removeWorker({ ...ticket, dual: logAs });
	}
	const limit = shift.error ? classify(shift.error, shift.errorHeaders, clock.now()) : null;
	if (limit) {
		const provider = route.model && String(route.model).endsWith(":free") ? cooldownKey(route.model) : route.provider;
		const resetAt = limit.resetAt && new Date(limit.resetAt).getTime() > clock.now().getTime() ? limit.resetAt : undefined;
		const until = resetAt ?? new Date(clock.now().getTime() + cooldownMs(config, limit.kind));
		await cooldowns.add(provider, until, limit.kind, { at: clock.now(), exact: Boolean(resetAt) });
	}
	return { shift };
}

/**
 * One review shift on the review tier, in a fresh context, judging a ticket's change:
 * after it lands (`landed`), or on its unlanded branch in the ticket's worktree before
 * anything lands (`cwd` + `target`: the review runs there, and its prompt points at the
 * branch diff). The reviewer reads the ticket, the spec and the diff, runs the verify
 * gate and ends with a verdict marker; the runner records it as `### Review` in Comments.
 * A review that ends without a valid verdict (an unknown verdict word counts as none)
 * is retried once, in a fresh context, on the next model of the review tier's chain;
 * a second miss is no silent accept — the ticket goes to needs-info for a human.
 * A review stopped by the runner stopping (a STOP file or a signal) is none of that:
 * not a missing verdict, so no retry and no needs-info — the ticket stays as it is
 * (after-land: resolved, the landed commit kept; before-land: the caller keeps the
 * branch and puts the ticket back on the frontier), recorded as not finished, for the next run.
 * A resumed review (`resumed`, `reviewUnfinishedReviews`): the ticket's earlier review
 * never finished, so this one owes its verdict; its prompt says so and points at the
 * ticket's last `- Landed:` line (`landed`), since `git log -3` no longer has to reach it.
 * @returns {Promise<{ verdict: "accept" | "reopen" | "follow-up" | "none" | "skip" | "stopped", reason: string, warnings?: string[], followUp?: object }>}
 */
async function runReviewShift({ root, ticket, tracker, backend, verify, config, clock, cooldowns, log, type, landed, slots, cwd, target, deferFollowUp = false, resumed = false, authBlocked = [], runState }) {
	const review = config.review;
	const now = clock.now();
	// Plan on the review tier as if the ticket were untyped and unrouted: the review is its own job.
	const plan = planShift({
		ticket: { ...ticket, type: undefined, model: undefined, skills: [], budget: undefined },
		config: { ...config, routing: {}, defaultTier: review.tier },
		history: authBlocked.length ? { blockedModels: [...authBlocked] } : {},
		cooldowns: await cooldowns.active(now),
		now,
		fullProviders: slots ? slots.fullProviders() : [],
	});
	const why =
		plan.wait
			? `every ${review.tier} model is cooling until ${new Date(plan.wait).toISOString()}`
			: (plan.stop ?? `no ${review.tier} model available`);
	if (!plan.model) {
		await tracker.appendComment(ticket, `### Review\n- Not run: ${why}`);
		return { verdict: "skip", reason: why };
	}
	// The review's own budget: ticket, tier and model budgets never cap it, and no
	// `unlimited` list lifts it — only `review.budget` itself does.
	const route = { ...plan, budget: review.budget };

	const first = await runOneReviewShift({ root, ticket, backend, config, route, landed, log, slots, cwd, target, resumed, runState });
	if (first.notRun) {
		await tracker.appendComment(ticket, `### Review\n- Not run: ${first.notRun}`);
		return { verdict: "skip", reason: first.notRun };
	}

	const warnings = [];
	let outcome = reviewVerdict(route, first.shift);
	let finalShift = first.shift;
	let retryRoute = undefined;
	// A stopped review is not a review without a verdict: no retry on the next model.
	if (!outcome.verdict && !reviewStopped(first.shift)) {
		// No verdict is not accept: once more, in a fresh context, on the next model of the chain.
		warnings.push(outcome.why);
		retryRoute = nextReviewRoute(route, config, review);
		const second = await runOneReviewShift({ root, ticket, backend, config, route: retryRoute, landed, log, slots, cwd, target, resumed, runState });
		finalShift = second.shift ?? finalShift;
		outcome = second.notRun
			? { verdict: null, reason: null, why: `${retryRoute.model}: ${second.notRun}` }
			: reviewVerdict(retryRoute, second.shift);
		if (!outcome.verdict) warnings.push(outcome.why);
	}
	// The runner stopped before the review gave a verdict (a STOP file, or a signal that wrote one):
	// no silent accept either — but no retry and no needs-info. The ticket stays as it is,
	// recorded as not finished, so the next run reviews it again.
	if (!outcome.verdict && reviewStopped(finalShift)) {
		const retried =
			retryRoute && retryRoute.model !== route.model ? `, retried on ${retryRoute.backend} ${retryRoute.model} (${retryRoute.thinking})` : "";
		await tracker.appendComment(
			ticket,
			[`### Review — ${route.backend} ${route.model} (${route.thinking})${retried}`, "- Review: not finished (stopped)", `- Time: ${formatDuration(finalShift.wallMin)}`].join("\n"),
		);
		return { verdict: "stopped", reason: "the runner stopped before the review gave a verdict" };
	}

	let verdict = outcome.verdict;
	let reason = outcome.reason;
	if (!verdict) {
		// Two review shifts, no verdict: recorded as none, and a human reviews by hand.
		verdict = "none";
		reason = NO_VERDICT_REASON;
	}

	// reopen puts the ticket back on the frontier: after-land, the landed commit stays and the
	// next shift fixes forward; before-land, nothing has landed and the caller keeps the branch.
	if (verdict === "reopen") await tracker.setStatus(ticket, READY);
	// none hands the ticket to a human: the landed commit stays (after-land) or the branch is
	// kept (before-land, by the caller); the review is recorded as none.
	if (verdict === "none") await tracker.setStatus(ticket, NEEDS_INFO);

	const verifyResult = ticket.verify.length ? await verify(ticket.verify, cwd ?? root) : null;
	let followUp;
	if (verdict === "follow-up" && !deferFollowUp) followUp = await createFollowUp(tracker, ticket, { root, type, reason, verify: ticket.verify });
	await tracker.appendComment(
		ticket,
		[
			formatReviewComment({ route, retryRoute, verdict, reason, warnings, verifyResult, shift: finalShift, followUp }),
			...(verdict === "none" ? [`<shiftwork:needs-info reason="${NO_VERDICT_REASON}"/>`] : []),
		].join("\n"),
	);
	return { verdict, reason, warnings, followUp };
}

/** Run one review shift on `route`: its own provider slot, the reviewer prompt, no handoffs, the wrap-up steer at its soft limit.
 * `cwd` is where the review runs — the ticket's worktree for a before-land review, else the repo. */
async function runOneReviewShift({ root, ticket, backend, config, route, landed, log, slots, cwd, target, resumed, runState }) {
	const releaseSlot = slots ? slots.acquire(route.provider) : undefined;
	if (slots && !releaseSlot) return { notRun: `${route.provider} is at its concurrency cap` };
	// The review is a live worker of its own while it runs (the TUI's Agents tab, `shiftwork logs`).
	const publish = await publishShift(runState ?? noRunState(), { ticket, attempt: "review", shift: "review", route });
	try {
		const shift = await runShift(
			backend,
			{
				root,
				cwd: cwd ?? root,
				route,
				prompt: buildReviewPrompt(ticket, { root, landed, target, absolute: Boolean(cwd && cwd !== root), resumed }),
				systemPrompt: config.reviewerPrompt ?? REVIEWER_PROMPT,
				softLimitPct: config.softLimitPct ?? 80,
				ticketPath: ticket.path,
				// A review is one shift: no handoffs, no in-place swaps.
				maxHandoffs: 0,
				// At its soft limit a review wraps up and gives its verdict; it never gets the worker handoff prompt.
				softLimitSteer: REVIEW_WRAP_UP_PROMPT,
			},
			(event) => {
				log({ ticket, attempt: "review", event });
				publish(event);
			},
		);
		return { shift };
	} finally {
		releaseSlot?.();
		await runState?.removeWorker({ ...ticket, dual: "review" });
	}
}

/** A shift ended by the runner stopping (a STOP file, or a signal that wrote one): `stop` is its handoff kind. */
function reviewStopped(shift) {
	return shift?.handoff?.kind === "stop" || shift?.stopReason === "STOP file";
}

/** A review that never gave a verdict: the last `### Review` section's own status line is
 * `- Review: not finished` and it carries no verdict. A quoted not-finished line in the
 * findings (blockquoted, starting with `>`) is not a status line, so a review that quotes
 * the note while giving its verdict is finished. */
export function reviewUnfinished(text) {
	const source = String(text ?? "");
	let section = "";
	for (const m of source.matchAll(/^### Review\b.*$/gm)) section = source.slice(m.index + m[0].length);
	return /^- Review: not finished/m.test(section) && !/^- Verdict: /m.test(section);
}

/** The ticket's last `- Landed: …` line: the change a resumed review judges, since
 * `git log -3` no longer has to reach the landed commit. */
function lastLandedLine(text) {
	const lines = String(text ?? "").match(/^- Landed: (.+)$/gm);
	return lines ? lines[lines.length - 1].replace(/^- Landed: /, "") : undefined;
}

/** One review shift's verdict: the last marker in its text, or why there is none (an unknown verdict word counts as none). */
function reviewVerdict(route, shift) {
	const markers = [...shift.text.matchAll(REVIEW_MARKER)];
	const marker = markers[markers.length - 1];
	const verdict = marker?.[1];
	const reason = marker?.[2]?.trim();
	if (marker && REVIEW_VERDICTS.has(verdict)) return { verdict, reason: reason || "no reason given" };
	const why = !marker
		? shift.error
			? `review shift failed: ${shift.error}`
			: "review ended without a verdict marker"
		: `unknown review verdict "${verdict}"`;
	return { verdict: null, reason: null, why: `${route.model}: ${why}` };
}

/**
 * The retry route for a review without a verdict: the next model of the review tier's
 * chain after `route`'s (the chain's first model when `route`'s is the last or not in
 * the chain, so a single-model chain retries on its only model, in a fresh context).
 * Everything else but the model stays as planned, the review budget included.
 */
function nextReviewRoute(route, config, review) {
	const chain = config.tiers?.[review.tier]?.chain ?? [];
	const used = route.ref ?? route.model;
	const model = chain[chain.indexOf(used) + 1] ?? chain[0];
	if (!model || model === used) return route;
	const ref = parseModelRef(model);
	return { ...route, backend: ref.backend, model: ref.model, provider: ref.provider, ref: model };
}

/** The `- Follow-up:` line of a review comment or a landing note. */
function followUpLine(followUp) {
	return followUp.created
		? `- Follow-up: ${followUp.feature}/${followUp.number} — ${followUp.title}`
		: `- Follow-up: not filed — this tracker cannot create tickets; file it manually: ${followUp.title}`;
}

/** File the research ticket of a research rollback: `Type: research`, writing the feature's
 * research.md, which its gate checks; the blocked ticket and the reason in its What to build. */
async function fileResearchTicket(tracker, ticket, { reason }) {
	const research = `.scratch/${ticket.feature}/research.md`;
	const sentence = /[.!?…]$/.test(reason) ? reason : `${reason}.`;
	return tracker.createTicket(ticket.feature, {
		title: truncate(`Research: ${reason}`, 80),
		what: `Research what ${ticket.feature}/${ticket.number} (${ticket.title ?? "untitled"}) needs before its implementation can continue: ${sentence} Write the findings (sources, facts, decisions, open questions) to ${research}. Filed by a shift of ${ticket.feature}/${ticket.number}, which is blocked by this ticket.`,
		type: "research",
		verify: [`test -s ${research}`],
		checkboxes: [`${research} answers: ${reason}`],
	});
}

/** File the follow-up ticket: a new ticket in the feature, blocked by nothing, with the reviewed ticket's verify gate. */
async function createFollowUp(tracker, ticket, { root, type, reason, verify }) {
	const title = truncate(`Follow-up to ${ticket.feature}/${ticket.number}: ${reason}`, 80);
	const what =
		`${/[.!?…]$/.test(reason) ? reason : `${reason}.`} Filed by the review of ${ticket.feature}/${ticket.number} — see its "### Review" block in ${root ? relative(root, ticket.path) : ticket.path}.`;
	if (typeof tracker.createTicket !== "function") {
		return { created: false, feature: ticket.feature, title, what };
	}
	return { ...(await tracker.createTicket(ticket.feature, { title, what, type, verify })), created: true };
}

function formatReviewComment({ route, retryRoute, verdict, reason, warnings = [], verifyResult, shift, followUp }) {
	const retried = retryRoute && retryRoute.model !== route.model ? `, retried on ${retryRoute.backend} ${retryRoute.model} (${retryRoute.thinking})` : "";
	const lines = [`### Review — ${route.backend} ${route.model} (${route.thinking})${retried}`, `- Verdict: ${verdict} — ${reason}`, `- Time: ${formatDuration(shift.wallMin)}`];
	if (verifyResult?.ok) lines.push("- Verify: passed");
	else if (verifyResult) {
		const failed = verifyResult.results?.find((r) => r.code !== 0) ?? verifyResult;
		lines.push(`- Verify: failed at \`${failed.cmd}\` (exit ${failed.code})`);
		// The failing output, as in a shift report: a verdict of accept over a red gate needs its why.
		if (failed.outputTail) lines.push("", "```", failed.outputTail.trimEnd(), "```", "");
	} else lines.push("- Verify: not run");
	for (const w of shift.warnings ?? []) lines.push(`- Warning: ${w}`);
	for (const w of warnings) lines.push(`- Warning: ${w}`);
	// The findings are the reviewer's final message, not the narration of how it got there;
	// a final message holding only the marker falls back to the whole text.
	const final = reviewFindings(shift.lastText);
	const findings = final.length ? final : reviewFindings(shift.text);
	if (findings.length) lines.push("- Findings:", "", ...findings);
	if (followUp) lines.push(followUpLine(followUp));
	return lines.join("\n");
}

/** The reviewer's findings, as a blockquote capped at REVIEW_FINDING_LINES lines. */
function reviewFindings(text) {
	const clean = String(text ?? "")
		.replace(REVIEW_MARKER, "")
		.trim();
	if (!clean) return [];
	const all = clean.split("\n");
	const shown = all.slice(0, REVIEW_FINDING_LINES).map((line) => `> ${line.trimEnd()}`);
	return shown.length < all.length ? [...shown, `> … ${all.length - shown.length} more lines in the review log`] : shown;
}

function truncate(text, max) {
	const t = String(text).trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Publish what the runner is doing now, so a reader of the run state sees every
 * running shift — its ticket, shift, model and budget use — as they change.
 * One worker entry per running shift: the runner's `workers` list.
 * @returns {Promise<(event: object) => void>} a sink for the shift's events
 */
async function publishShift(runState, { ticket, attempt, shift, route }) {
	const usage = { tokens: 0, costUsd: 0, turns: 0, contextPct: 0 };
	// A dual candidate (`A`, `B`, `merge`) or a review is its own worker entry: a sibling may run at the same time.
	const key = DUAL_LABEL.test(String(shift)) ? { ...ticket, dual: shift } : ticket;
	const write = () =>
		runState.updateWorker(key, {
			ticket: { feature: ticket.feature, number: ticket.number, title: ticket.title, path: ticket.path },
			attempt,
			shift,
			model: route.ref ?? route.model,
			thinking: route.thinking ?? null,
			tier: route.tier ?? null,
			budget: route.budget ?? null,
			usage: { ...usage },
		});
	await write();
	return (event) => {
		if (event.type === "turn") {
			usage.turns++;
			usage.tokens += event.usage?.totalTokens ?? 0;
			usage.costUsd += event.costUsd ?? 0;
		} else if (event.type === "cost") {
			usage.costUsd += event.costUsd ?? 0;
		} else if (event.type === "context") {
			usage.contextPct = event.percent ?? usage.contextPct;
		} else {
			return;
		}
		write();
	};
}

/**
 * Guessed cooldowns (no reset time from the provider) are probed every `probeEveryMin` minutes
 * with one tiny request through the backend; a provider that answers is available again.
 */
async function probeCooldowns({ backend, cooldowns, config, now, force = false, log }) {
	if (typeof backend.probe !== "function") return;
	const everyMs = (config.probeEveryMin ?? 15) * 60_000;
	const models = Object.values(config.tiers ?? {}).flatMap((tier) => tier.chain ?? []);
	const due = [];
	for (const cooldown of await cooldowns.active(now)) {
		if (cooldown.exact) continue;
		const last = new Date(cooldown.probedAt ?? cooldown.at ?? 0).getTime();
		if (!force && now.getTime() - last < everyMs) continue;
		const model = models.find((m) => cooldownKey(m) === cooldown.provider || parseModelRef(m).provider === cooldown.provider);
		if (!model) continue;
		due.push({ cooldown, model });
	}
	// Probes run concurrently (parallel where it's free); the store writes follow, one at a time.
	const probed = await Promise.all(
		due.map(async ({ cooldown, model }) => ({ cooldown, model, ok: await backend.probe(model).catch(() => false) })),
	);
	for (const { cooldown, model, ok } of probed) {
		log({ type: "probe", provider: cooldown.provider, model, ok });
		if (ok) await cooldowns.remove(cooldown.provider);
		else await cooldowns.markProbed(cooldown.provider, now);
	}
}

function accumulateUsage(target, shift) {
	target.maxTokens += shift.usage.totalTokens ?? 0;
	target.maxCostUsd += shift.costUsd ?? 0;
	target.maxTurns += shift.turns ?? 0;
	target.maxWallMin += shift.wallMin ?? 0;
}

const BLOCKING_KINDS = new Set(["stallTurns", "verifyFailed"]);

/** Every model reference the config (and this ticket) can route to on `route`'s provider. */
function modelsOfProvider(config, route, ticket) {
	const refs = [
		route.ref ?? route.model,
		config.model,
		ticket.model,
		...Object.values(config.tiers ?? {}).flatMap((tier) => tier.chain ?? []),
		...Object.values(config.routing ?? {}).map((r) => r?.model),
	].filter(Boolean);
	return [...new Set(refs)].filter((ref) => ref === (route.ref ?? route.model) || parseModelRef(ref).provider === route.provider);
}

function rememberBlocked(blockedModels, route, kind) {
	const ref = route?.ref ?? route?.model;
	if (!BLOCKING_KINDS.has(kind) || !ref) return;
	if (!blockedModels.includes(ref)) blockedModels.push(ref);
}

function remainingTicketBudget(ticket, config, usage, route) {
	const ticketBudget = resolveTicketBudget(ticket, config);
	if (!ticketBudget) return { exhausted: false };
	const lifted = new Set(liftedFor(route, config));
	for (const [key, limit] of Object.entries(ticketBudget)) {
		if (limit === undefined || limit === null || lifted.has(key)) continue;
		const used = usage[key] ?? 0;
		if (used >= limit) return { exhausted: true, reason: `${key} (${used} / ${limit})` };
	}
	return { exhausted: false };
}

const COMPACT_INSTRUCTIONS = "Keep the current task, files touched, hypotheses and next steps. Drop chatter.";

/** A CLI agent killed by a signal: what a Shiftwork stop (a STOP file, a signal) does to it. */
const KILLED_EXIT = /exited with code (?:130|143|null)\b|\bSIG(?:INT|TERM)\b/;
/** How long a killed agent's shift waits for the STOP file a signal handler is writing. */
const STOP_FILE_GRACE_MS = 500;

/** Whether a STOP file appears within `ms` (a signal handler may write it just after the agent died). */
async function stopFileSoon(root, ms = STOP_FILE_GRACE_MS) {
	for (let waited = 0; ; waited += 50) {
		if (checkStop(root)) return true;
		if (waited >= ms) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The agent's needs-info reason: the marker only in its final message, standalone — a marker
 * quoted in backticks or a code block, or one in an earlier message, is not a question. */
function needsInfoOf(lastText) {
	return markerProse(lastText).match(MARKER)?.[1] ?? null;
}

/** The agent's research rollback reason (`<shiftwork:needs-research reason="…"/>`), read like needs-info. */
function needsResearchOf(lastText) {
	return markerProse(lastText).match(RESEARCH_MARKER)?.[1] ?? null;
}

/** The final message without code blocks and backtick spans: a quoted marker is not one. */
function markerProse(lastText) {
	return String(lastText ?? "")
		.replace(/```[\s\S]*?(?:```|$)/g, "")
		.replace(/`[^`\n]*`/g, "");
}

const WALL_TICK = Symbol("wall-clock tick");

/** Consume one shift's events into a result. `sectionOf` scopes the ticket file to this
 * ticket's own section (a shared OpenSpec .shiftwork.md) when looking for its handoff note. */
async function runShift(backend, request, log, { sectionOf = (text) => text } = {}) {
	const result = {
		usage: { input: 0, output: 0, totalTokens: 0 },
		costUsd: 0,
		turns: 0,
		text: "",
		lastText: "",
		error: null,
		errorKind: undefined,
		stopReason: null,
		needsInfo: null,
		warnings: [],
		handoff: null,
		handoffs: [],
	};
	let shift;
	try {
		shift = await backend.startShift(request);
	} catch (error) {
		result.error = error.message;
		result.stopReason = "error";
		return result;
	}
	result.warnings = shift.warnings ?? [];
	const startedAt = Date.now();
	let currentRoute = request.route;
	const softLimitPct = request.softLimitPct ?? 80;
	let meterStartedAt = Date.now();
	let meter = createMeter(currentRoute.budget, softLimitPct, { now: Date.now });

	let softFired = false;
	let softFiredThisTurn = false;
	let softGraceRemaining = 0;
	let exceededKind = null;
	let ticketSnapshot = null;
	let contextTokens = 0;

	async function hasAgentHandoff() {
		if (!request.ticketPath) return false;
		try {
			const text = sectionOf(await readFile(request.ticketPath, "utf8"));
			if (!text.includes("### Handoff")) return false;
			if (ticketSnapshot === null) return true;
			const lastOld = ticketSnapshot.lastIndexOf("### Handoff");
			const lastNew = text.lastIndexOf("### Handoff");
			return lastNew > lastOld;
		} catch {
			return false;
		}
	}

	async function freshHandoff(reason, kind) {
		await shift.abort().catch(() => {});
		result.stopReason = result.stopReason ?? "budget";
		result.handoff = { reason, kind };
	}

	async function tryInPlace(reason, kind) {
		const maxHandoffs = request.maxHandoffs ?? Infinity;
		const next =
			request.planHandoff && kind
				? { ...request.planHandoff(kind, currentRoute), backend: currentRoute.backend }
				: undefined;
		const canSwap =
			next &&
			next.model !== currentRoute.model &&
			result.handoffs.length < maxHandoffs &&
			shift.capabilities?.inPlaceHandoff &&
			typeof shift.swapModel === "function";
		const targetWindow = canSwap && typeof shift.contextWindow === "function" ? await shift.contextWindow(next.model) : undefined;
		const used = contextTokens || result.usage.totalTokens;
		const decision = chooseHandoffMode({
			mode: currentRoute.onExceed?.[kind]?.mode,
			kind,
			allowInPlace: Boolean(request.allowInPlace),
			inPlaceHandoff: Boolean(canSwap),
			contextTokens: used || undefined,
			targetContextWindow: targetWindow,
		});
		if (decision.mode !== "same-process" || !canSwap) {
			await freshHandoff(reason, kind);
			return true;
		}
		try {
			if (decision.compact && shift.compact) await shift.compact(COMPACT_INSTRUCTIONS);
			await shift.swapModel(next.model, next.thinking);
		} catch {
			await freshHandoff(reason, kind);
			return true;
		}
		result.handoffs.push({ inPlace: true, kind, reason, from: currentRoute, to: next, compacted: decision.compact });
		currentRoute = next;
		meterStartedAt = Date.now();
		meter = createMeter(next.budget, softLimitPct, { now: Date.now });
		resetWallTimer();
		softFired = false;
		softFiredThisTurn = false;
		softGraceRemaining = 0;
		exceededKind = null;
		return false;
	}

	async function beginGrace(steerText, kind) {
		softFired = true;
		softFiredThisTurn = true;
		softGraceRemaining = 2;
		exceededKind = kind;
		if (ticketSnapshot === null) ticketSnapshot = sectionOf(await readFile(request.ticketPath, "utf8").catch(() => ""));
		if (shift.steer) await shift.steer(steerText).catch(() => {});
	}

	async function finishStop(agentNote) {
		await shift.abort().catch(() => {});
		result.stopReason = "STOP file";
		result.handoff = { reason: "STOP file", kind: "stop", agentNote };
	}

	async function checkLimit(limit) {
		if (!limit || exceededKind === "stop") return false;
		if (limit.level === "soft" && shift.steer) {
			const isFirst = !softFired;
			softFired = true;
			// A review gets the wrap-up prompt instead: it never gets the worker handoff prompt.
			if (isFirst) await beginGrace(request.softLimitSteer ?? SOFT_LIMIT_STEER, limit.kind);
		} else if (limit.level === "hard") {
			return tryInPlace(limit.reason, limit.kind);
		}
		return false;
	}
	// The wall-clock budget is kept by a timer, not only on events: a tool call that hangs
	// sends no events, and the shift is still steered at its soft limit and aborted at its hard one.
	let wallTimer = null;
	let pendingTick = null;
	function resetWallTimer() {
		clearTimeout(wallTimer);
		wallTimer = null;
		pendingTick = null;
	}
	function nextWallTick() {
		const limitMin = currentRoute.budget?.maxWallMin;
		if (limitMin === undefined || limitMin === null) return null;
		const fired = meter.snapshot();
		if (fired.hardFired.has("maxWallMin")) return null;
		const softAt = meterStartedAt + (limitMin * 60_000 * softLimitPct) / 100;
		const hardAt = meterStartedAt + limitMin * 60_000;
		const at = !fired.softFired.has("maxWallMin") && Date.now() < softAt ? softAt : hardAt;
		return new Promise((resolve) => {
			wallTimer = setTimeout(() => resolve(WALL_TICK), Math.max(0, at - Date.now()) + 5);
		});
	}
	const iterator = shift.events[Symbol.asyncIterator]();
	let pendingNext = null;
	try {
		for (;;) {
			pendingNext ??= iterator.next();
			if (pendingTick === null) pendingTick = nextWallTick() ?? new Promise(() => {});
			const next = await Promise.race([pendingNext, pendingTick]);
			if (next === WALL_TICK) {
				resetWallTimer();
				if (await checkLimit(meter.observe({ type: "tick" }))) break;
				continue;
			}
			pendingNext = null;
			if (next.done) break;
			const event = next.value;
			const observed = applyProfileContext(event, currentRoute.contextWindow);
			log(observed);
			let limit = null;
			if (observed.type === "turn") {
				result.turns++;
				result.usage.input += observed.usage?.input ?? 0;
				result.usage.output += observed.usage?.output ?? 0;
				result.usage.totalTokens += observed.usage?.totalTokens ?? 0;
				result.costUsd += observed.costUsd ?? 0;
				// Feed a diff-stat snapshot after each turn so stall detection can work.
				if (request.getDiffStat) {
					try {
						const stat = await request.getDiffStat();
						limit = meter.observe({ type: "diffStat", stat });
					} catch {}
				}
			} else if (observed.type === "cost") {
				// Some backends (Claude Code) report the shift's cost once, at the end.
				result.costUsd += observed.costUsd ?? 0;
			} else if (observed.type === "context") {
				contextTokens = observed.tokens ?? contextTokens;
			}

			limit = meter.observe(observed) ?? limit;
			if (exceededKind !== "stop" && request.root && checkStop(request.root)) {
				await beginGrace(STOP_STEER, "stop");
			}
			if (await checkLimit(limit)) break;

			if (softFired) {
				if (event.type === "turn" && !softFiredThisTurn) {
					softGraceRemaining--;
				}
				softFiredThisTurn = false;

				if (await hasAgentHandoff()) {
					// Stop the agent before anyone else touches its worktree.
					if (exceededKind === "stop") {
						await finishStop(true);
					} else {
						await shift.abort().catch(() => {});
						result.stopReason = result.stopReason ?? "agent-handoff";
						result.handoff = { reason: "agent handoff", kind: exceededKind, agentNote: true };
					}
					break;
				}

				if (softGraceRemaining <= 0) {
					if (exceededKind === "stop") {
						await finishStop(false);
						break;
					}
					if (await tryInPlace("soft-limit agent did not hand off", exceededKind)) break;
				}
			}

			if (event.type === "text") {
				result.text += `${event.text}\n`;
				if (String(event.text ?? "").trim()) result.lastText = event.text;
			} else if (event.type === "error") {
				result.error = event.message;
				result.errorHeaders = event.headers;
				result.errorKind = event.kind;
			} else if (event.type === "end") {
				result.stopReason = event.stopReason;
				break;
			}
		}
	} finally {
		resetWallTimer();
		await shift.close?.().catch(() => {});
	}
	if (exceededKind === "stop" && !result.handoff) {
		result.stopReason = "STOP file";
		result.handoff = { reason: "STOP file", kind: "stop", agentNote: await hasAgentHandoff() };
	}
	// The agent died because Shiftwork is stopping (a STOP file, or a signal whose handler writes
	// one just after the agent got it too): a stopped shift, not a failed attempt.
	if (
		!result.handoff &&
		result.error &&
		request.root &&
		(checkStop(request.root) || (KILLED_EXIT.test(result.error) && (await stopFileSoon(request.root))))
	) {
		result.stopReason = "STOP file";
		result.handoff = { reason: "STOP file", kind: "stop", agentNote: false };
	}
	result.wallMin = (Date.now() - startedAt) / 60_000;
	result.needsInfo = needsInfoOf(result.lastText);
	result.needsResearch = needsResearchOf(result.lastText);
	return result;
}

async function buildHandoffNote({ shiftNumber, from, to, reason, shift, verifyResult, getDiffStat }) {
	const lines = [`### Handoff — shift ${shiftNumber}, ${from.ref ?? from.model} → ${to ? (to.ref ?? to.model) : "(no target)"}, reason: ${reason}`];
	if (shift.text?.trim()) {
		const tail = shift.text.trim().split("\n").slice(-3).join("\n");
		lines.push("- Last output:", "", "```", tail, "```");
	}
	if (getDiffStat) {
		try {
			const stat = await getDiffStat();
			if (stat) lines.push("", "- Diff stat:", "", "```", stat, "```");
		} catch {}
	}
	if (verifyResult && !verifyResult.ok) {
		const failed = verifyResult.results?.find((r) => r.code !== 0) ?? verifyResult;
		if (failed?.cmd) lines.push("", `- Verify failure: \`${failed.cmd}\` (exit ${failed.code})`);
	}
	return lines.join("\n");
}

async function classifyUntyped(ticket, config, classifyTicket) {
	if (ticket.type || !classifyTicket || config.jev?.enabled === false) {
		return { classification: undefined, classificationNote: undefined };
	}
	try {
		const classification = (await classifyTicket(ticket)) ?? null;
		if (!classification) return { classification: null, classificationNote: "Jev unavailable, used default type" };
		return { classification, classificationNote: undefined };
	} catch {
		return { classification: null, classificationNote: "Jev unavailable, used default type" };
	}
}

const BACKEND_UNAVAILABLE = /^(?:claude|codex|opencode|grok|cursor(?:-agent)?): command not found|backend not (?:available|installed)/i;
// A stopped server (Ollama, a proxy) refuses connections: the backend is unavailable,
// like a missing CLI, instead of cooling as a provider limit.
const CONNECTION_REFUSED = /connection (?:was )?refused|ECONNREFUSED/i;
// pi reports a stopped local server only as "Connection error." (recorded, pi 0.99.1). On a cloud
// provider that text is a network blip, so it means "unavailable" only for local providers.
const CONNECTION_ERROR = /^connection error\.?$/i;
const LOCAL_PROVIDERS = new Set(["ollama"]);

function isBackendUnavailable(message, route) {
	if (BACKEND_UNAVAILABLE.test(message) || CONNECTION_REFUSED.test(message)) return true;
	return LOCAL_PROVIDERS.has(route?.provider) && CONNECTION_ERROR.test(message.trim());
}

/** A wall-clock duration in minutes as "45s", "12m 34s" or "2h 5m". */
export function formatDuration(minutes) {
	const seconds = Math.max(0, Math.round((minutes ?? 0) * 60));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h) return `${h}h ${m}m`;
	return m ? `${m}m ${s}s` : `${s}s`;
}

function shiftReport({ number, route, shift, verifyResult, decision, classificationNote, ticketUsage }) {
	const lines = [`### Shift ${number} — ${route.backend} ${route.model} (${route.thinking})`];
	if (route.typeSource === "jev") {
		lines.push(`- Type: ${route.type} (jev)`);
	} else if (classificationNote) {
		lines.push(`- Type: ${route.type} (default); ${classificationNote}`);
	}
	lines.push(`- Ended: ${shift.stopReason ?? "unknown"}${shift.error ? `, error: ${shift.error}` : ""}`);
	lines.push(
		`- Usage: ${shift.usage.input} in / ${shift.usage.output} out tokens, $${shift.costUsd.toFixed(4)}, ${shift.turns} turns`,
	);
	// From the second shift on, the ticket's total time across shifts too.
	const total = number > 1 && ticketUsage ? ` (ticket total ${formatDuration(ticketUsage.maxWallMin)})` : "";
	lines.push(`- Time: ${formatDuration(shift.wallMin)}${total}`);
	if (verifyResult?.ok) {
		lines.push("- Verify: passed");
	} else if (verifyResult) {
		// A gate may say ok: false without any non-zero result (a timeout, an adapter error).
		const failed = verifyResult.results?.find((r) => r.code !== 0);
		lines.push(failed ? `- Verify: failed at \`${failed.cmd}\` (exit ${failed.code})` : "- Verify: failed");
		if (failed?.outputTail) lines.push("", "```", failed.outputTail.trimEnd(), "```", "");
	} else {
		lines.push("- Verify: not run");
	}
	for (const warning of shift.warnings ?? []) {
		lines.push(`- Warning: ${warning}`);
	}
	const outcome =
		decision.action === "resolve"
			? decision.reviewNext
				? "verify passed; review before landing"
				: "resolved"
			: decision.action === "dual"
				? decision.reason
			: decision.action === "needs-research"
				? `needs-research: ${decision.reason}`
				: decision.action === "redo"
				? "redo on the new target (landing conflict)"
				: decision.action === "retry"
				? "new attempt"
				: decision.action === "stop"
					? `stopped: ${decision.reason}`
					: `needs-info: ${decision.reason}`;
	lines.push(`- Outcome: ${outcome}`);
	return lines.join("\n");
}
