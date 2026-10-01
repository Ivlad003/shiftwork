import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { classifyError, cooldownMs } from "./classify.js";
import { openCooldowns } from "./cooldowns.js";
import { applyProfileContext, createMeter } from "./meter.js";
import { chooseHandoffMode, cooldownKey, parseModelRef, planShift, resolveTicketBudget } from "./planner.js";
import { buildReviewPrompt, buildShiftPrompt, REVIEWER_PROMPT, REVIEW_WRAP_UP_PROMPT, SOFT_LIMIT_STEER, STOP_STEER, WORKER_PROMPT } from "./prompt.js";
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

/** Whether a resolved ticket gets a review shift: `review: { enabled, tier, when, features?, types? }`. */
export function shouldReview(config, ticket) {
	const review = config.review;
	if (!review?.enabled) return false;
	if ((review.when ?? "resolve") !== "resolve") return false;
	if (review.features?.length && !review.features.includes(ticket.feature)) return false;
	if (review.types?.length && !review.types.includes(ticket.type)) return false;
	return true;
}

/**
 * Parse the `--ticket` value `<feature>/<NN>` into its feature and padded number.
 * Pure; throws on any other shape.
 */
export function parseTicketSpec(spec) {
	const match = /^(.+)\/(\d+)$/.exec(String(spec ?? ""));
	if (!match) throw new Error(`ticket spec ${JSON.stringify(spec)} is not <feature>/<NN>`);
	return { feature: match[1], number: String(Number(match[2])).padStart(2, "0") };
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
	// A tracker ticket is identified by feature + number: the OpenSpec tracker shares
	// one .shiftwork.md path between all tasks of a change.
	const seenKey = (t) => (t.number === undefined ? t.path : `${t.feature}/${t.number}`);
	// A chosen ticket (`options.ticket`, `<feature>/<NN>`) is checked before anything is claimed
	// or written: one that is not on the frontier is refused with its reason (spec story 5).
	const chosen = options.ticket ? await chosenTicket(tracker, options.ticket) : null;
	const time = clock ?? {
		now: () => new Date(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	const cooldownStore = cooldowns ?? openCooldowns(root);
	const state = runState ?? (root ? openRunState(root) : noRunState());
	// In-memory per-provider shift caps (`concurrency`): a serial run never fills one.
	// Cross-process caps are out of scope; the lock file (ticket 02) covers shared state, not slots.
	const slots = createProviderSlots(config.concurrency);
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
			});
		} finally {
			// The worker entry is gone once the shift settles: readers see only running shifts.
			await state.removeWorker(ticket);
		}
	};
	const frontierPage = async () =>
		(await tracker.frontier())
			.filter((t) => !seen.has(seenKey(t)) && (!options.feature || t.feature === options.feature))
			.filter((t) => !chosen || (t.feature === chosen.feature && t.number === chosen.number));

	await state.update({
		pid: process.pid,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		feature: options.feature ?? null,
		workers: [],
		summary: { resolved: 0, needsInfo: 0, reopened: 0 },
	});

	// `once` (and a chosen `ticket`) is one ticket however high `parallel` is: the serial loop keeps today's order exactly.
	// One worker failing is not the end of the run's bookkeeping: the pool lets the
	// others settle, the run state is finished, and only then the error propagates.
	let failure = null;
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
			recordOutcome(ticket, outcome);
			await state.update({ summary: counts() });
			// A chosen ticket is worked once however the run ends: the loop stops after it.
			if (options.once || chosen) break;
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
				} finally {
					await tracker.release(claim);
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
				running.push(startWorker(ticket, claim));
			}
			if (running.length === 0) break;
			const done = await Promise.race(running);
			running.splice(running.indexOf(done.worker), 1);
			if (done.error) {
				// A failed worker ends the run, but only after the running shifts settle.
				failure ??= done.error;
				stopping = true;
				continue;
			}
			recordOutcome(done.ticket, done.outcome);
			await state.update({ summary: counts() });
			if (done.outcome.action === "stop") {
				summary.stoppedReason ??= done.outcome.reason;
				stopping = true;
			}
		}
		return failure;
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

async function workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log, classify, classifyTicket, clock, cooldowns, runState, slots }) {
	let cwd = workspace ? (await workspace.prepare(ticket)).cwd : root;
	const earlier = [...(await readFile(ticket.path, "utf8")).matchAll(SHIFT_REPORT)].map((m) => Number(m[1]));
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
	const { classification, classificationNote } = await classifyUntyped(ticket, config, classifyTicket);
	const historyOf = (extra = {}) => ({ previousRoute, exceededKind, ticketUsage, blockedModels, ...extra });

	for (;;) {
		if (checkStop(root)) {
			await tracker.setStatus(ticket, READY);
			return { action: "stop", reason: "STOP file" };
		}
		const now = clock.now();
		// Before every ticket, check every guessed cooldown; between its shifts, every probeEveryMin.
		await probeCooldowns({ backend, cooldowns, config, now, force: firstPlan && config.probeBeforeTicket !== false, log: (event) => log({ ticket, attempt, event }) });
		firstPlan = false;
		// A provider at its concurrency cap is skipped like a cooling one, but no cooldown is written.
		const plan = planShift({
			ticket,
			config,
			classification,
			history: historyOf(),
			cooldowns: await cooldowns.active(now),
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
		const route = plan;
		// Take this shift's provider slot right after planning it: plan and acquire are
		// one synchronous block, so two workers can never take the last slot together.
		const releaseSlot = slots ? slots.acquire(route.provider) : undefined;
		if (slots && !releaseSlot) {
			// Planned before another worker took the last slot: re-plan shortly.
			log({ ticket, event: { type: "wait", provider: route.provider, ms: WAIT_STEP_MS } });
			await clock.sleep(WAIT_STEP_MS);
			continue;
		}
		const prompt = buildShiftPrompt(ticket, { root, attempt, absolute: cwd !== root });
		const softLimitPct = config.softLimitPct ?? 80;
		const getDiffStat = workspace ? () => workspace.diffStat(ticket) : undefined;
		const publish = await publishShift(runState ?? noRunState(), { ticket, attempt, shift: shiftNumber, route });
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
							fullProviders: slots ? slots.fullProviders() : [],
						}),
				},
				(event) => {
					log({ ticket, attempt, event });
					publish(event);
				},
			);
		} finally {
			releaseSlot?.();
		}

		accumulateUsage(ticketUsage, shift);

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

		let limit = shift.error ? classify(shift.error, shift.errorHeaders, clock.now()) : null;
		if (!limit && shift.error && isBackendUnavailable(shift.error, route)) {
			limit = { kind: "usage" };
		}
		// Free models cool on their own; everything else cools its whole provider.
		const provider = route.model && String(route.model).endsWith(":free") ? cooldownKey(route.model) : route.provider;
		const until = limit ? (limit.resetAt ?? new Date(clock.now().getTime() + cooldownMs(config, limit.kind))) : undefined;
		if (limit) await cooldowns.add(provider, until, limit.kind, { at: clock.now(), exact: Boolean(limit.resetAt) });
		// The limit may have hit after the work was done: if the gate passes, the ticket is resolved.
		// With nothing changed, nobody worked the ticket yet: hand it on instead of judging the gate.
		const workedBeforeLimit = limit && (!workspace?.hasChanges || (await workspace.hasChanges(ticket)));
		const limitGate = workedBeforeLimit && ticket.verify.length > 0 && shift.needsInfo === null ? await verify(ticket.verify, cwd) : null;
		if (limit && !limitGate?.ok) {
			await tracker.appendComment(
				ticket,
				[
					shiftReport({
						number: shiftNumber,
						route,
						shift,
						verifyResult: null,
						decision: { action: "retry", reason: `provider ${limit.kind} limit` },
						classificationNote,
						ticketUsage,
					}),
					`- Provider limit: ${limit.kind} on ${provider}, cooling until ${until instanceof Date ? until.toISOString() : until}; continuing without counting an attempt`,
				].join("\n"),
			);
			shiftNumber++;
			continue;
		}

		const hasVerify = ticket.verify.length > 0;
		// A handed-off shift may already have finished the work: the gate decides either way.
		const verifyResult = limitGate ?? (shift.needsInfo === null && hasVerify ? await verify(ticket.verify, cwd) : null);
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
		const unchanged = decision.action === "resolve" && workspace?.hasChanges ? !(await workspace.hasChanges(ticket)) : false;
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
			nextRoute = { ...planShift({ ticket, config, classification, history: handoffHistory }), backend: backend.name };
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
		if (workspace && decision.action === "resolve") {
			let landed = await workspace.land(ticket);
			// A parallel landing can move the target again while the gate re-runs on the rebased
			// branch: keep rebasing, re-verifying and landing while it moves, up to `landRetries`
			// rounds (default 5). In a parallel run every `land` here goes through the queue in
			// withLandingQueue, so the rounds stay one-landing-at-a-time like any other landing.
			let rebases = 0;
			while (!landed.ok && landed.rebase) {
				if (rebases >= (config.landRetries ?? 5)) {
					// The target moved once per round of the whole budget: the branch is kept, a human lands it.
					const branch = (await workspace.keep(ticket)).branch;
					decision = {
						action: NEEDS_INFO,
						reason: `the target kept moving (${rebases} rebases); branch ${branch} kept — land it with shiftwork run --ticket ${ticket.feature}/${ticket.number} or merge it by hand`,
					};
					landed = null;
					break;
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
					decision = { action: NEEDS_INFO, reason: `verify gate failed on the branch rebased onto ${landed.rebase} (\`${failed?.cmd}\`)` };
					landed = null;
					break;
				}
				landed = await workspace.land(ticket);
			}
			if (landed) {
				notes.push(`- Landed: ${landed.message}`);
				if (landed.ok) landedMessage = landed.message;
				else if (landed.conflict && !conflictRedone) {
					// One fix-forward per ticket: the note below tells the next shift what landed first.
					conflictRedone = true;
					notes.push(
						`- Landing conflict with ${landed.conflict.files.join(", ") || "the target"}; redone on top of ${landed.conflict.commit}`,
					);
					redoNext = true;
					// The report says what happens next: this shift's work is redone, not resolved.
					decision = { action: "redo", reason: "landing conflict" };
				} else {
					decision = { action: NEEDS_INFO, reason: `verify gate passed but landing failed: ${landed.message}` };
				}
			}
		}
		if (workspace && decision.action === NEEDS_INFO && notes.length === 0) {
			notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}

		await tracker.appendComment(ticket, [shiftReport({ number: shiftNumber, route, shift, verifyResult, decision, classificationNote, ticketUsage }), ...notes].join("\n"));
		shiftNumber++;

		if (redoNext) {
			// The landing conflicted with a parallel one (noted above): one more shift, in a fresh
			// worktree prepared from the new target, on top of what landed first.
			if (typeof workspace.redo === "function") await workspace.redo(ticket);
			cwd = (await workspace.prepare(ticket)).cwd;
			continue;
		}

		if (decision.action === "resolve") {
			await tracker.setStatus(ticket, RESOLVED);
			const reason = notes.length ? notes[notes.length - 1].replace(/^- Landed: /, "") : "verify passed";
			// After a landing, one review shift in a fresh context judges the work (stories 4–6).
			if (shouldReview(config, { ...ticket, type: route.type })) {
				const review = await runReviewShift({
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
				});
				if (review.verdict === "reopen") return { action: "reopen", reason: review.reason, review };
				// No verdict twice is no silent accept: the ticket goes to needs-info, the landed commit stays.
				if (review.verdict === "none") return { action: NEEDS_INFO, reason: review.reason, review };
				return { action: "resolve", reason, review };
			}
			return { action: "resolve", reason };
		}
		if (decision.action === NEEDS_INFO) {
			await tracker.setStatus(ticket, NEEDS_INFO);
			return { action: NEEDS_INFO, reason: decision.reason };
		}

		if (freshHandoff && decision.action === "retry" && handoffCount <= maxHandoffs) {
			previousRoute = route;
			exceededKind = freshHandoff.kind;
			if (freshHandoff.kind === "verifyFailed" && verifyResult && !verifyResult.ok) {
				lastVerifyFailure = verifyResult.results.find((r) => r.code !== 0) ?? null;
				attempt++;
			}
			// Before starting the next shift, make sure the ticket budget isn't exhausted.
			const remainingTicket = remainingTicketBudget(ticket, config, ticketUsage);
			if (remainingTicket.exhausted) {
				await tracker.appendComment(ticket, `### Handoff blocked\n- Reason: ticket budget exhausted (${remainingTicket.reason})`);
				await tracker.setStatus(ticket, NEEDS_INFO);
				return { action: NEEDS_INFO, reason: `ticket budget exhausted: ${remainingTicket.reason}` };
			}
			continue;
		}

		if (verifyResult && !verifyResult.ok) {
			lastVerifyFailure = verifyResult.results.find((r) => r.code !== 0) ?? null;
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

/**
 * One review shift on the review tier, in a fresh context, after a ticket lands.
 * The reviewer reads the ticket, the spec and the landed diff, runs the verify gate
 * and ends with a verdict marker; the runner records it as `### Review` in Comments.
 * A review that ends without a valid verdict (an unknown verdict word counts as none)
 * is retried once, in a fresh context, on the next model of the review tier's chain;
 * a second miss is no silent accept — the ticket goes to needs-info for a human.
 * @returns {Promise<{ verdict: "accept" | "reopen" | "follow-up" | "none" | "skip", reason: string, warnings?: string[], followUp?: object }>}
 */
async function runReviewShift({ root, ticket, tracker, backend, verify, config, clock, cooldowns, log, type, landed, slots }) {
	const review = config.review;
	const now = clock.now();
	// Plan on the review tier as if the ticket were untyped and unrouted: the review is its own job.
	const plan = planShift({
		ticket: { ...ticket, type: undefined, model: undefined, skills: [], budget: undefined },
		config: { ...config, routing: {}, defaultTier: review.tier },
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

	const first = await runOneReviewShift({ root, ticket, backend, config, route, landed, log, slots });
	if (first.notRun) {
		await tracker.appendComment(ticket, `### Review\n- Not run: ${first.notRun}`);
		return { verdict: "skip", reason: first.notRun };
	}

	const warnings = [];
	let outcome = reviewVerdict(route, first.shift);
	let finalShift = first.shift;
	let retryRoute = undefined;
	if (!outcome.verdict) {
		// No verdict is not accept: once more, in a fresh context, on the next model of the chain.
		warnings.push(outcome.why);
		retryRoute = nextReviewRoute(route, config, review);
		const second = await runOneReviewShift({ root, ticket, backend, config, route: retryRoute, landed, log, slots });
		finalShift = second.shift ?? finalShift;
		outcome = second.notRun
			? { verdict: null, reason: null, why: `${retryRoute.model}: ${second.notRun}` }
			: reviewVerdict(retryRoute, second.shift);
		if (!outcome.verdict) warnings.push(outcome.why);
	}
	let verdict = outcome.verdict;
	let reason = outcome.reason;
	if (!verdict) {
		// Two review shifts, no verdict: recorded as none, and a human reviews by hand.
		verdict = "none";
		reason = NO_VERDICT_REASON;
	}

	// reopen puts the ticket back on the frontier: the landed commit stays, the next shift fixes forward.
	if (verdict === "reopen") await tracker.setStatus(ticket, READY);
	// none hands the ticket to a human: the landed commit stays, the review is recorded as none.
	if (verdict === "none") await tracker.setStatus(ticket, NEEDS_INFO);

	const verifyResult = ticket.verify.length ? await verify(ticket.verify, root) : null;
	let followUp;
	if (verdict === "follow-up") followUp = await createFollowUp(tracker, ticket, { root, type, reason, verify: ticket.verify });
	await tracker.appendComment(
		ticket,
		[
			formatReviewComment({ route, retryRoute, verdict, reason, warnings, verifyResult, shift: finalShift, followUp }),
			...(verdict === "none" ? [`<shiftwork:needs-info reason="${NO_VERDICT_REASON}"/>`] : []),
		].join("\n"),
	);
	return { verdict, reason, warnings, followUp };
}

/** Run one review shift on `route`: its own provider slot, the reviewer prompt, no handoffs, the wrap-up steer at its soft limit. */
async function runOneReviewShift({ root, ticket, backend, config, route, landed, log, slots }) {
	const releaseSlot = slots ? slots.acquire(route.provider) : undefined;
	if (slots && !releaseSlot) return { notRun: `${route.provider} is at its concurrency cap` };
	try {
		const shift = await runShift(
			backend,
			{
				root,
				cwd: root,
				route,
				prompt: buildReviewPrompt(ticket, { root, landed }),
				systemPrompt: config.reviewerPrompt ?? REVIEWER_PROMPT,
				softLimitPct: config.softLimitPct ?? 80,
				ticketPath: ticket.path,
				// A review is one shift: no handoffs, no in-place swaps.
				maxHandoffs: 0,
				// At its soft limit a review wraps up and gives its verdict; it never gets the worker handoff prompt.
				softLimitSteer: REVIEW_WRAP_UP_PROMPT,
			},
			(event) => log({ ticket, attempt: "review", event }),
		);
		return { shift };
	} finally {
		releaseSlot?.();
	}
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
		const failed = verifyResult.results.find((r) => r.code !== 0) ?? verifyResult;
		lines.push(`- Verify: failed at \`${failed.cmd}\` (exit ${failed.code})`);
		// The failing output, as in a shift report: a verdict of accept over a red gate needs its why.
		if (failed.outputTail) lines.push("", "```", failed.outputTail.trimEnd(), "```", "");
	} else lines.push("- Verify: not run");
	for (const w of shift.warnings ?? []) lines.push(`- Warning: ${w}`);
	for (const w of warnings) lines.push(`- Warning: ${w}`);
	const findings = reviewFindings(shift.text);
	if (findings.length) lines.push("- Findings:", "", ...findings);
	if (followUp?.created) lines.push(`- Follow-up: ${followUp.feature}/${followUp.number} — ${followUp.title}`);
	else if (followUp) lines.push(`- Follow-up: not filed — this tracker cannot create tickets; file it manually: ${followUp.title}`);
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
	const write = () =>
		runState.updateWorker(ticket, {
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

function rememberBlocked(blockedModels, route, kind) {
	const ref = route?.ref ?? route?.model;
	if (!BLOCKING_KINDS.has(kind) || !ref) return;
	if (!blockedModels.includes(ref)) blockedModels.push(ref);
}

function remainingTicketBudget(ticket, config, usage) {
	const ticketBudget = resolveTicketBudget(ticket, config);
	if (!ticketBudget) return { exhausted: false };
	for (const [key, limit] of Object.entries(ticketBudget)) {
		if (limit === undefined || limit === null) continue;
		const used = usage[key] ?? 0;
		if (used >= limit) return { exhausted: true, reason: `${key} (${used} / ${limit})` };
	}
	return { exhausted: false };
}

const COMPACT_INSTRUCTIONS = "Keep the current task, files touched, hypotheses and next steps. Drop chatter.";

/** Consume one shift's events into a result. */
async function runShift(backend, request, log) {
	const result = {
		usage: { input: 0, output: 0, totalTokens: 0 },
		costUsd: 0,
		turns: 0,
		text: "",
		error: null,
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
	let meter = createMeter(currentRoute.budget, request.softLimitPct ?? 80, { now: Date.now });

	let softFired = false;
	let softFiredThisTurn = false;
	let softGraceRemaining = 0;
	let exceededKind = null;
	let ticketSnapshot = null;
	let contextTokens = 0;

	async function hasAgentHandoff() {
		if (!request.ticketPath) return false;
		try {
			const text = await readFile(request.ticketPath, "utf8");
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
		meter = createMeter(next.budget, request.softLimitPct ?? 80, { now: Date.now });
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
		if (ticketSnapshot === null) ticketSnapshot = await readFile(request.ticketPath, "utf8").catch(() => "");
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
	try {
		for await (const event of shift.events) {
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
			} else if (event.type === "error") {
				result.error = event.message;
				result.errorHeaders = event.headers;
			} else if (event.type === "end") {
				result.stopReason = event.stopReason;
				break;
			}
		}
	} finally {
		await shift.close?.().catch(() => {});
	}
	if (exceededKind === "stop" && !result.handoff) {
		result.stopReason = "STOP file";
		result.handoff = { reason: "STOP file", kind: "stop", agentNote: await hasAgentHandoff() };
	}
	result.wallMin = (Date.now() - startedAt) / 60_000;
	const marker = result.text.match(MARKER);
	if (marker) result.needsInfo = marker[1];
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
		const failed = verifyResult.results.find((r) => r.code !== 0);
		lines.push(`- Verify: failed at \`${failed.cmd}\` (exit ${failed.code})`);
		if (failed.outputTail) lines.push("", "```", failed.outputTail.trimEnd(), "```", "");
	} else {
		lines.push("- Verify: not run");
	}
	for (const warning of shift.warnings ?? []) {
		lines.push(`- Warning: ${warning}`);
	}
	const outcome =
		decision.action === "resolve"
			? "resolved"
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
