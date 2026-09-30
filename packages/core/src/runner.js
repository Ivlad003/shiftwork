import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyError, cooldownMs } from "./classify.js";
import { openCooldowns } from "./cooldowns.js";
import { applyProfileContext, createMeter } from "./meter.js";
import { chooseHandoffMode, cooldownKey, parseModelRef, planShift, resolveTicketBudget } from "./planner.js";
import { buildReviewPrompt, buildShiftPrompt, REVIEWER_PROMPT, SOFT_LIMIT_STEER, STOP_STEER, WORKER_PROMPT } from "./prompt.js";
import { noRunState, openRunState } from "./run-state.js";

const NEEDS_INFO = "needs-info";
const RESOLVED = "resolved";
const READY = "ready-for-agent";
const STOP_FILE = "STOP";
const WAIT_STEP_MS = 60_000;
/** Only the runner's own shift reports: "### Shift N — <backend> <model> (<thinking>)". */
const SHIFT_REPORT = /^### Shift (\d+) — \S+ \S+ \([^)]*\)$/gm;
const MARKER = /<shiftwork:needs-info\s+reason="([^"]*)"\s*\/>/;
const REVIEW_MARKER = /<shiftwork:review\s+verdict="([^"]*)"\s+reason="([^"]*)"\s*\/>/g;
const REVIEW_VERDICTS = new Set(["accept", "reopen", "follow-up"]);
/** Review findings kept in the ticket; the full review text stays in the review log. */
const REVIEW_FINDING_LINES = 40;

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
	const time = clock ?? {
		now: () => new Date(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	const cooldownStore = cooldowns ?? openCooldowns(root);
	const state = runState ?? (root ? openRunState(root) : noRunState());
	await state.update({
		pid: process.pid,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		feature: options.feature ?? null,
		ticket: null,
		summary: { resolved: 0, needsInfo: 0, reopened: 0 },
	});

	for (;;) {
		if (checkStop(root)) {
			summary.stoppedReason = "STOP file";
			break;
		}
		const frontier = (await tracker.frontier()).filter(
			(t) => !seen.has(seenKey(t)) && (!options.feature || t.feature === options.feature),
		);
		if (frontier.length === 0) break;
		const ticket = frontier[0];
		seen.add(seenKey(ticket));

		const claim = await tracker.claim(ticket);
		if (!claim) continue;
		try {
			const outcome = await workTicket({
				root,
				ticket,
				tracker,
				backend,
				verify,
				config,
				workspace,
				maxAttempts,
				log,
				classify,
				classifyTicket,
				clock: time,
				cooldowns: cooldownStore,
				runState: state,
			});
			if (outcome.action === "stop") {
				summary.stoppedReason = outcome.reason;
				break;
			}
			if (outcome.action === "resolve") summary.resolved.push({ ...ticket, reason: outcome.reason, review: outcome.review });
			else if (outcome.action === "reopen") summary.reopened.push({ ...ticket, reason: outcome.reason, review: outcome.review });
			else summary.needsInfo.push({ ...ticket, reason: outcome.reason });
			await state.update({
				summary: {
					resolved: summary.resolved.length,
					needsInfo: summary.needsInfo.length,
					reopened: summary.reopened.length,
				},
			});
		} finally {
			await tracker.release(claim);
		}
		if (options.once) break;
	}

	if (!summary.stoppedReason && checkStop(root)) {
		summary.stoppedReason = "STOP file";
	}

	summary.exitCode = summary.stoppedReason ? 3 : summary.needsInfo.length > 0 || summary.reopened.length > 0 ? 2 : 0;
	await state.update({
		running: false,
		finishedAt: new Date().toISOString(),
		ticket: null,
		stoppedReason: summary.stoppedReason ?? null,
		summary: {
			resolved: summary.resolved.length,
			needsInfo: summary.needsInfo.length,
			reopened: summary.reopened.length,
		},
	});
	return summary;
}

async function workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log, classify, classifyTicket, clock, cooldowns, runState }) {
	const cwd = workspace ? (await workspace.prepare(ticket)).cwd : root;
	const earlier = [...(await readFile(ticket.path, "utf8")).matchAll(SHIFT_REPORT)].map((m) => Number(m[1]));
	const firstShift = earlier.length ? Math.max(...earlier) + 1 : 1;
	let shiftNumber = firstShift;
	let firstPlan = true;
	let handoffCount = 0;
	let attempt = 1;
	let landedMessage = undefined;
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
		const plan = planShift({
			ticket,
			config,
			classification,
			history: historyOf(),
			cooldowns: await cooldowns.active(now),
			now,
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
		const prompt = buildShiftPrompt(ticket, { root, attempt, absolute: cwd !== root });
		const softLimitPct = config.softLimitPct ?? 80;
		const getDiffStat = workspace ? () => workspace.diffStat(ticket) : undefined;
		const publish = await publishShift(runState ?? noRunState(), { ticket, attempt, shift: shiftNumber, route });
		const shift = await runShift(
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
				planHandoff: (kind, fromRoute) =>
					planShift({ ticket, config, classification, history: historyOf({ previousRoute: fromRoute, exceededKind: kind }) }),
			},
			(event) => {
				log({ ticket, attempt, event });
				publish(event);
			},
		);

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
		const limitGate = limit && ticket.verify.length > 0 && shift.needsInfo === null ? await verify(ticket.verify, cwd) : null;
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

		if (workspace?.hasChanges && decision.action === "resolve" && !(await workspace.hasChanges(ticket))) {
			decision = { action: NEEDS_INFO, reason: "verify gate passed but no shift changed anything: the gate doesn't test this ticket" };
		}
		if (workspace && decision.action === "resolve") {
			const landed = await workspace.land(ticket);
			notes.push(`- Landed: ${landed.message}`);
			if (landed.ok) landedMessage = landed.message;
			if (!landed.ok) decision = { action: NEEDS_INFO, reason: `verify gate passed but landing failed: ${landed.message}` };
		}
		if (workspace && decision.action === NEEDS_INFO && notes.length === 0) {
			notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}

		await tracker.appendComment(ticket, [shiftReport({ number: shiftNumber, route, shift, verifyResult, decision, classificationNote }), ...notes].join("\n"));
		shiftNumber++;

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
				});
				if (review.verdict === "reopen") return { action: "reopen", reason: review.reason, review };
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
 * @returns {Promise<{ verdict: "accept" | "reopen" | "follow-up" | "skip", reason: string, warning?: string, followUp?: object }>}
 */
async function runReviewShift({ root, ticket, tracker, backend, verify, config, clock, cooldowns, log, type, landed }) {
	const review = config.review;
	const now = clock.now();
	// Plan on the review tier as if the ticket were untyped and unrouted: the review is its own job.
	const plan = planShift({
		ticket: { ...ticket, type: undefined, model: undefined, skills: [], budget: undefined },
		config: { ...config, routing: {}, defaultTier: review.tier },
		cooldowns: await cooldowns.active(now),
		now,
	});
	const why =
		plan.wait
			? `every ${review.tier} model is cooling until ${new Date(plan.wait).toISOString()}`
			: (plan.stop ?? `no ${review.tier} model available`);
	if (!plan.model) {
		await tracker.appendComment(ticket, `### Review\n- Not run: ${why}`);
		return { verdict: "skip", reason: why };
	}

	const shift = await runShift(
		backend,
		{
			root,
			cwd: root,
			route: plan,
			prompt: buildReviewPrompt(ticket, { root, landed }),
			systemPrompt: config.reviewerPrompt ?? REVIEWER_PROMPT,
			softLimitPct: config.softLimitPct ?? 80,
			ticketPath: ticket.path,
			// A review is one shift: no handoffs, no in-place swaps.
			maxHandoffs: 0,
		},
		(event) => log({ ticket, attempt: "review", event }),
	);

	const markers = [...shift.text.matchAll(REVIEW_MARKER)];
	const marker = markers[markers.length - 1];
	let verdict = marker?.[1];
	let reason = marker?.[2];
	let warning;
	if (!marker) {
		warning = shift.error ? `review shift failed: ${shift.error}; treated as accept` : "review ended without a verdict marker; treated as accept";
	} else if (!REVIEW_VERDICTS.has(verdict)) {
		warning = `unknown review verdict "${verdict}"; treated as accept`;
	}
	if (warning) {
		verdict = "accept";
		reason = reason?.trim() || "no verdict given";
	}

	// reopen puts the ticket back on the frontier: the landed commit stays, the next shift fixes forward.
	if (verdict === "reopen") await tracker.setStatus(ticket, READY);

	const verifyResult = ticket.verify.length ? await verify(ticket.verify, root) : null;
	let followUp;
	if (verdict === "follow-up") followUp = await createFollowUp(tracker, ticket, { type, reason, verify: ticket.verify });
	await tracker.appendComment(
		ticket,
		formatReviewComment({ route: plan, verdict, reason, warning, verifyResult, shift, followUp }),
	);
	return { verdict, reason, warning, followUp };
}

/** File the follow-up ticket: a new ticket in the feature, blocked by nothing, with the reviewed ticket's verify gate. */
async function createFollowUp(tracker, ticket, { type, reason, verify }) {
	const title = truncate(`Follow-up to ${ticket.feature}/${ticket.number}: ${reason}`, 80);
	const what =
		`${/[.!?…]$/.test(reason) ? reason : `${reason}.`} Filed by the review of ${ticket.feature}/${ticket.number} — see its "### Review" block in ${ticket.path}.`;
	if (typeof tracker.createTicket !== "function") {
		return { created: false, feature: ticket.feature, title, what };
	}
	return { ...(await tracker.createTicket(ticket.feature, { title, what, type, verify })), created: true };
}

function formatReviewComment({ route, verdict, reason, warning, verifyResult, shift, followUp }) {
	const lines = [`### Review — ${route.backend} ${route.model} (${route.thinking})`, `- Verdict: ${verdict} — ${reason}`];
	if (verifyResult?.ok) lines.push("- Verify: passed");
	else if (verifyResult) {
		const failed = verifyResult.results.find((r) => r.code !== 0) ?? verifyResult;
		lines.push(`- Verify: failed at \`${failed.cmd}\` (exit ${failed.code})`);
	} else lines.push("- Verify: not run");
	for (const w of shift.warnings ?? []) lines.push(`- Warning: ${w}`);
	if (warning) lines.push(`- Warning: ${warning}`);
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
 * Publish what the runner is doing now, so a reader of the run state sees the
 * current ticket, shift, model and budget use as they change.
 * @returns {Promise<(event: object) => void>} a sink for the shift's events
 */
async function publishShift(runState, { ticket, attempt, shift, route }) {
	const usage = { tokens: 0, costUsd: 0, turns: 0, contextPct: 0 };
	const write = () =>
		runState.update({
			ticket: { feature: ticket.feature, number: ticket.number, title: ticket.title, path: ticket.path },
			attempt,
			shift,
			model: route.model,
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
	for (const cooldown of await cooldowns.active(now)) {
		if (cooldown.exact) continue;
		const last = new Date(cooldown.probedAt ?? cooldown.at ?? 0).getTime();
		if (!force && now.getTime() - last < everyMs) continue;
		const model = models.find((m) => cooldownKey(m) === cooldown.provider || parseModelRef(m).provider === cooldown.provider);
		if (!model) continue;
		const ok = await backend.probe(model).catch(() => false);
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
	if (!BLOCKING_KINDS.has(kind) || !route?.model) return;
	if (!blockedModels.includes(route.model)) blockedModels.push(route.model);
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
			if (isFirst) await beginGrace(SOFT_LIMIT_STEER, limit.kind);
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
	const lines = [`### Handoff — shift ${shiftNumber}, ${from.model} → ${to?.model ?? "(no target)"}, reason: ${reason}`];
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

function shiftReport({ number, route, shift, verifyResult, decision, classificationNote }) {
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
			: decision.action === "retry"
				? "new attempt"
				: decision.action === "stop"
					? `stopped: ${decision.reason}`
					: `needs-info: ${decision.reason}`;
	lines.push(`- Outcome: ${outcome}`);
	return lines.join("\n");
}
