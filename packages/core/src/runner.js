import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyError, cooldownMs } from "./classify.js";
import { openCooldowns } from "./cooldowns.js";
import { createMeter } from "./meter.js";
import { chooseHandoffMode, planShift, resolveTicketBudget } from "./planner.js";
import { buildShiftPrompt, SOFT_LIMIT_STEER, WORKER_PROMPT } from "./prompt.js";
import { noRunState, openRunState } from "./run-state.js";

const NEEDS_INFO = "needs-info";
const RESOLVED = "resolved";
const READY = "ready-for-agent";
const STOP_FILE = "STOP";
const WAIT_STEP_MS = 60_000;
/** Only the runner's own shift reports: "### Shift N — <backend> <model> (<thinking>)". */
const SHIFT_REPORT = /^### Shift (\d+) — \S+ \S+ \([^)]*\)$/gm;
const MARKER = /<shiftwork:needs-info\s+reason="([^"]*)"\s*\/>/;

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
	const summary = { resolved: [], needsInfo: [], stoppedReason: undefined };
	const seen = new Set();
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
		summary: { resolved: 0, needsInfo: 0 },
	});

	for (;;) {
		if (checkStop(root)) {
			summary.stoppedReason = "STOP file";
			break;
		}
		const frontier = (await tracker.frontier()).filter(
			(t) => !seen.has(t.path) && (!options.feature || t.feature === options.feature),
		);
		if (frontier.length === 0) break;
		const ticket = frontier[0];
		seen.add(ticket.path);

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
			if (outcome.action === "resolve") summary.resolved.push({ ...ticket, reason: outcome.reason });
			else summary.needsInfo.push({ ...ticket, reason: outcome.reason });
			await state.update({ summary: { resolved: summary.resolved.length, needsInfo: summary.needsInfo.length } });
		} finally {
			await tracker.release(claim);
		}
		if (options.once) break;
	}

	if (!summary.stoppedReason && checkStop(root)) {
		summary.stoppedReason = "STOP file";
	}

	summary.exitCode = summary.stoppedReason ? 3 : summary.needsInfo.length > 0 ? 2 : 0;
	await state.update({
		running: false,
		finishedAt: new Date().toISOString(),
		ticket: null,
		stoppedReason: summary.stoppedReason ?? null,
		summary: { resolved: summary.resolved.length, needsInfo: summary.needsInfo.length },
	});
	return summary;
}

async function workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log, classify, classifyTicket, clock, cooldowns, runState }) {
	const cwd = workspace ? (await workspace.prepare(ticket)).cwd : root;
	const earlier = [...(await readFile(ticket.path, "utf8")).matchAll(SHIFT_REPORT)].map((m) => Number(m[1]));
	const firstShift = earlier.length ? Math.max(...earlier) + 1 : 1;
	let shiftNumber = firstShift;
	let handoffCount = 0;
	let attempt = 1;
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
		const route = { ...plan, backend: backend.name };
		const prompt = buildShiftPrompt(ticket, { root, attempt, absolute: cwd !== root });
		const softLimitPct = config.softLimitPct ?? 80;
		const getDiffStat = workspace ? () => workspace.diffStat(ticket) : undefined;
		const publish = await publishShift(runState ?? noRunState(), { ticket, attempt, shift: shiftNumber, route });
		const shift = await runShift(
			backend,
			{
				cwd,
				route,
				prompt,
				systemPrompt: config.workerPrompt ?? WORKER_PROMPT,
				softLimitPct,
				getDiffStat,
				ticketPath: ticket.path,
				maxHandoffs,
				planHandoff: (kind, fromRoute) =>
					planShift({ ticket, config, classification, history: historyOf({ previousRoute: fromRoute, exceededKind: kind }) }),
			},
			(event) => {
				log({ ticket, attempt, event });
				publish(event);
			},
		);

		accumulateUsage(ticketUsage, shift);

		const limit = shift.error ? classify(shift.error, shift.errorHeaders, clock.now()) : null;
		const provider = route.model.split("/")[0];
		const until = limit ? (limit.resetAt ?? new Date(clock.now().getTime() + cooldownMs(config, limit.kind))) : undefined;
		if (limit) await cooldowns.add(provider, until, limit.kind);
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
			if (!landed.ok) decision = { action: NEEDS_INFO, reason: `verify gate passed but landing failed: ${landed.message}` };
		}
		if (workspace && decision.action === NEEDS_INFO && notes.length === 0) {
			notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}

		await tracker.appendComment(ticket, [shiftReport({ number: shiftNumber, route, shift, verifyResult, decision, classificationNote }), ...notes].join("\n"));
		shiftNumber++;

		if (decision.action === "resolve") {
			await tracker.setStatus(ticket, RESOLVED);
			return { action: "resolve", reason: notes.length ? notes[notes.length - 1].replace(/^- Landed: /, "") : "verify passed" };
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
		} else if (event.type === "context") {
			usage.contextPct = event.percent ?? usage.contextPct;
		} else {
			return;
		}
		write();
	};
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

	async function checkLimit(limit) {
		if (!limit) return false;
		if (limit.level === "soft" && shift.steer) {
			const isFirst = !softFired;
			softFired = true;
			if (isFirst) {
				softFiredThisTurn = true;
				softGraceRemaining = 2;
				exceededKind = limit.kind;
				ticketSnapshot = await readFile(request.ticketPath, "utf8").catch(() => "");
				await shift.steer(SOFT_LIMIT_STEER).catch(() => {});
			}
		} else if (limit.level === "hard") {
			return tryInPlace(limit.reason, limit.kind);
		}
		return false;
	}
	try {
		for await (const event of shift.events) {
			log(event);
			let limit = null;
			if (event.type === "turn") {
				result.turns++;
				result.usage.input += event.usage?.input ?? 0;
				result.usage.output += event.usage?.output ?? 0;
				result.usage.totalTokens += event.usage?.totalTokens ?? 0;
				result.costUsd += event.costUsd ?? 0;
				// Feed a diff-stat snapshot after each turn so stall detection can work.
				if (request.getDiffStat) {
					try {
						const stat = await request.getDiffStat();
						limit = meter.observe({ type: "diffStat", stat });
					} catch {}
				}
			} else if (event.type === "context") {
				contextTokens = event.tokens ?? contextTokens;
			}

			limit = meter.observe(event) ?? limit;
			if (await checkLimit(limit)) break;

			if (softFired) {
				if (event.type === "turn" && !softFiredThisTurn) {
					softGraceRemaining--;
				}
				softFiredThisTurn = false;

				if (await hasAgentHandoff()) {
					// Stop the agent before anyone else touches its worktree.
					await shift.abort().catch(() => {});
					result.stopReason = result.stopReason ?? "agent-handoff";
					result.handoff = { reason: "agent handoff", kind: exceededKind, agentNote: true };
					break;
				}

				if (softGraceRemaining <= 0) {
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
	const outcome = decision.action === "resolve" ? "resolved" : decision.action === "retry" ? "new attempt" : `needs-info: ${decision.reason}`;
	lines.push(`- Outcome: ${outcome}`);
	return lines.join("\n");
}
