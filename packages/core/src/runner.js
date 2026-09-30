import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMeter } from "./meter.js";
import { planShift, resolveTicketBudget } from "./planner.js";
import { buildShiftPrompt, WORKER_PROMPT } from "./prompt.js";

const NEEDS_INFO = "needs-info";
const RESOLVED = "resolved";
const READY = "ready-for-agent";
const STOP_FILE = "STOP";
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
 * Every dependency is injected: tracker, backend, verify, log.
 */
export async function runFrontier({ root, tracker, backend, verify, config, workspace, log = () => {}, options = {} }) {
	const maxAttempts = config.maxAttempts ?? 3;
	const summary = { resolved: [], needsInfo: [], stoppedReason: undefined };
	const seen = new Set();

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
			const outcome = await workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log });
			if (outcome.action === "stop") {
				summary.stoppedReason = outcome.reason;
				break;
			}
			if (outcome.action === "resolve") summary.resolved.push({ ...ticket, reason: outcome.reason });
			else summary.needsInfo.push({ ...ticket, reason: outcome.reason });
		} finally {
			await tracker.release(claim);
		}
		if (options.once) break;
	}

	if (!summary.stoppedReason && checkStop(root)) {
		summary.stoppedReason = "STOP file";
	}

	summary.exitCode = summary.stoppedReason ? 3 : summary.needsInfo.length > 0 ? 2 : 0;
	return summary;
}

async function workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log }) {
	const cwd = workspace ? (await workspace.prepare(ticket)).cwd : root;
	const earlier = [...(await readFile(ticket.path, "utf8")).matchAll(/^### Shift (\d+) — /gm)].map((m) => Number(m[1]));
	const firstShift = earlier.length ? Math.max(...earlier) + 1 : 1;
	let shiftNumber = firstShift;
	let handoffCount = 0;
	let attempt = 1;
	let previousRoute = undefined;
	let exceededKind = undefined;
	let lastVerifyFailure = undefined;
	const ticketUsage = { maxTokens: 0, maxCostUsd: 0, maxTurns: 0, maxWallMin: 0 };
	const maxHandoffs = config.maxHandoffs ?? 3;

	for (;;) {
		const plan = planShift({
			ticket,
			config,
			history: { previousRoute, exceededKind, ticketUsage },
		});
		const route = { ...plan, backend: backend.name };
		const prompt = buildShiftPrompt(ticket, { root, attempt, absolute: cwd !== root });
		const softLimitPct = config.softLimitPct ?? 80;
		const getDiffStat = workspace ? () => workspace.diffStat(ticket) : undefined;
		const shift = await runShift(
			backend,
			{ cwd, route, prompt, systemPrompt: config.workerPrompt ?? WORKER_PROMPT, softLimitPct, getDiffStat },
			(event) => log({ ticket, attempt, event }),
		);

		accumulateUsage(ticketUsage, shift);

		const hasVerify = ticket.verify.length > 0;
		const verifyResult = shift.needsInfo === null && !shift.handoff && hasVerify ? await verify(ticket.verify, cwd) : null;
		let decision = decideNext({
			attempt,
			maxAttempts,
			needsInfo: shift.needsInfo,
			hasVerify,
			verifyOk: verifyResult?.ok ?? false,
		});

		const notes = [];
		let nextRoute = undefined;
		if (shift.handoff) {
			handoffCount++;
			const handoffHistory = { previousRoute: route, exceededKind: shift.handoff.kind, ticketUsage };
			nextRoute = { ...planShift({ ticket, config, history: handoffHistory }), backend: backend.name };
			const handoffNote = await buildHandoffNote({
				shiftNumber,
				from: route,
				to: nextRoute,
				reason: shift.handoff.reason,
				shift,
				verifyResult: verifyResult ?? lastVerifyFailure,
				getDiffStat,
			});
			notes.push(handoffNote);
			if (handoffCount > maxHandoffs) {
				notes.push(`- Handoff limit: ${maxHandoffs} handoffs already used`);
				decision = { action: NEEDS_INFO, reason: `maxHandoffs (${maxHandoffs}) exceeded` };
			}
		}

		if (workspace && decision.action === "resolve") {
			const landed = await workspace.land(ticket);
			notes.push(`- Landed: ${landed.message}`);
			if (!landed.ok) decision = { action: NEEDS_INFO, reason: `verify gate passed but landing failed: ${landed.message}` };
		}
		if (workspace && decision.action === NEEDS_INFO && notes.length === 0) {
			notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}

		await tracker.appendComment(ticket, [shiftReport({ number: shiftNumber, route, shift, verifyResult, decision }), ...notes].join("\n"));
		shiftNumber++;

		if (decision.action === "resolve") {
			await tracker.setStatus(ticket, RESOLVED);
			return { action: "resolve", reason: notes.length ? notes[notes.length - 1].replace(/^- Landed: /, "") : "verify passed" };
		}
		if (decision.action === NEEDS_INFO) {
			await tracker.setStatus(ticket, NEEDS_INFO);
			return { action: NEEDS_INFO, reason: decision.reason };
		}

		if (shift.handoff && handoffCount <= maxHandoffs) {
			previousRoute = route;
			exceededKind = shift.handoff.kind;
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
		}

		if (checkStop(root)) {
			await tracker.setStatus(ticket, READY);
			return { action: "stop", reason: "STOP file" };
		}
	}
}

function accumulateUsage(target, shift) {
	target.maxTokens += shift.usage.totalTokens ?? 0;
	target.maxCostUsd += shift.costUsd ?? 0;
	target.maxTurns += shift.turns ?? 0;
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

const SOFT_LIMIT_PROMPT = `You are near a Shiftwork budget limit. Finish your current step, then append a \`### Handoff\` note to the ticket describing what was done, what remains, hypotheses, and files touched, then stop.`;

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
	const meter = createMeter(request.route.budget, request.softLimitPct ?? 80, { now: Date.now });
	async function checkLimit(limit) {
		if (!limit) return false;
		if (limit.level === "soft" && shift.steer) {
			await shift.steer(SOFT_LIMIT_PROMPT).catch(() => {});
		} else if (limit.level === "hard") {
			await shift.abort().catch(() => {});
			result.stopReason = "budget";
			result.handoff = { reason: limit.reason, kind: limit.kind };
		}
		return limit.level === "hard";
	}
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
		}

		limit = meter.observe(event) ?? limit;
		if (await checkLimit(limit)) break;

		if (event.type === "text") {
			result.text += `${event.text}\n`;
		} else if (event.type === "error") {
			result.error = event.message;
		} else if (event.type === "end") {
			result.stopReason = event.stopReason;
			break;
		}
	}
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

function shiftReport({ number, route, shift, verifyResult, decision }) {
	const lines = [`### Shift ${number} — ${route.backend} ${route.model} (${route.thinking})`];
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
