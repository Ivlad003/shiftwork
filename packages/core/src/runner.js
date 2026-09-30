import { planShift } from "./planner.js";
import { buildShiftPrompt, WORKER_PROMPT } from "./prompt.js";

const NEEDS_INFO = "needs-info";
const RESOLVED = "resolved";
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

/**
 * Work the frontier until nothing is left (or one ticket with `once`).
 * Every dependency is injected: tracker, backend, verify, log.
 */
export async function runFrontier({ root, tracker, backend, verify, config, workspace, log = () => {}, options = {} }) {
	const maxAttempts = config.maxAttempts ?? 3;
	const summary = { resolved: [], needsInfo: [] };
	const seen = new Set();

	for (;;) {
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
			if (outcome.action === "resolve") summary.resolved.push(ticket);
			else summary.needsInfo.push({ ...ticket, reason: outcome.reason });
		} finally {
			await tracker.release(claim);
		}
		if (options.once) break;
	}

	summary.exitCode = summary.needsInfo.length > 0 ? 2 : 0;
	return summary;
}

async function workTicket({ root, ticket, tracker, backend, verify, config, workspace, maxAttempts, log }) {
	const cwd = workspace ? (await workspace.prepare(ticket)).cwd : root;
	for (let attempt = 1; ; attempt++) {
		const route = { ...planShift({ ticket, config }), backend: backend.name };
		const prompt = buildShiftPrompt(ticket, { root, attempt, absolute: cwd !== root });
		const shift = await runShift(backend, { cwd, route, prompt, systemPrompt: config.workerPrompt ?? WORKER_PROMPT }, (event) =>
			log({ ticket, attempt, event }),
		);

		const hasVerify = ticket.verify.length > 0;
		const verifyResult = shift.needsInfo === null && hasVerify ? await verify(ticket.verify, cwd) : null;
		let decision = decideNext({
			attempt,
			maxAttempts,
			needsInfo: shift.needsInfo,
			hasVerify,
			verifyOk: verifyResult?.ok ?? false,
		});

		const notes = [];
		if (workspace && decision.action === "resolve") {
			const landed = await workspace.land(ticket);
			notes.push(`- Landed: ${landed.message}`);
			if (!landed.ok) decision = { action: NEEDS_INFO, reason: `verify gate passed but landing failed: ${landed.message}` };
		}
		if (workspace && decision.action === NEEDS_INFO && notes.length === 0) {
			notes.push(`- Branch kept: ${(await workspace.keep(ticket)).branch}`);
		}

		await tracker.appendComment(ticket, [shiftReport({ attempt, route, shift, verifyResult, decision }), ...notes].join("\n"));
		if (decision.action === "resolve") {
			await tracker.setStatus(ticket, RESOLVED);
			return decision;
		}
		if (decision.action === NEEDS_INFO) {
			await tracker.setStatus(ticket, NEEDS_INFO);
			return decision;
		}
	}
}

/** Consume one shift's events into a result. */
async function runShift(backend, request, log) {
	const result = { usage: { input: 0, output: 0, totalTokens: 0 }, costUsd: 0, turns: 0, text: "", error: null, stopReason: null, needsInfo: null };
	let shift;
	try {
		shift = await backend.startShift(request);
	} catch (error) {
		result.error = error.message;
		result.stopReason = "error";
		return result;
	}
	for await (const event of shift.events) {
		log(event);
		if (event.type === "turn") {
			result.turns++;
			result.usage.input += event.usage?.input ?? 0;
			result.usage.output += event.usage?.output ?? 0;
			result.usage.totalTokens += event.usage?.totalTokens ?? 0;
			result.costUsd += event.costUsd ?? 0;
		} else if (event.type === "text") {
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

function shiftReport({ attempt, route, shift, verifyResult, decision }) {
	const lines = [`### Shift ${attempt} — ${route.backend} ${route.model} (${route.thinking})`];
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
	const outcome = decision.action === "resolve" ? "resolved" : decision.action === "retry" ? "new attempt" : `needs-info: ${decision.reason}`;
	lines.push(`- Outcome: ${outcome}`);
	return lines.join("\n");
}
