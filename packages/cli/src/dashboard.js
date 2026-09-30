import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { formatTicketsTable, openCooldowns, openRepoTracker, openRunState, RESOLVED, VERSION } from "shiftwork-core";
import { formatBudget } from "./dry-run.js";

/** One frame per second, per the spec. */
export const REFRESH_MS = 1000;
const LOG_TAIL = 8;

/**
 * Collect everything one dashboard frame needs: the tracker's tickets, the frontier,
 * live claims, the run state (`.pi/shiftwork-run.json`), active cooldowns and the tail
 * of the current shift log. A missing run state or log yields null/empty, never a throw.
 */
export async function collectDashboardState(root, { now = new Date(), logTail = LOG_TAIL } = {}) {
	const tracker = await openRepoTracker(root);
	const [tickets, frontier, claims, run, cooldowns] = await Promise.all([
		tracker.list(),
		tracker.frontier(),
		tracker.activeClaims(),
		openRunState(root).read(),
		openCooldowns(root).active(now),
	]);
	const log = await tailShiftLog(root, run, logTail);
	return { now, tickets, frontier, claims, run, cooldowns, log };
}

/** The last `maxLines` events of the log the current attempt is writing; null when no shift is live. */
export async function tailShiftLog(root, run, maxLines = LOG_TAIL) {
	// The first live worker's log: with several workers, one tail is shown.
	const worker = (run?.workers ?? []).find((w) => w.ticket?.feature && w.ticket?.number && w.attempt);
	if (!worker) return null;
	const ticket = worker.ticket;
	const path = join("logs", ticket.feature, ticket.number, `attempt-${worker.attempt}.jsonl`);
	let text;
	try {
		text = await readFile(join(root, path), "utf8");
	} catch {
		return { path, lines: [] };
	}
	const lines = text
		.trimEnd()
		.split("\n")
		.filter(Boolean)
		.slice(-maxLines)
		.map(formatLogLine);
	return { path, lines };
}

/** One NDJSON log event as a compact line; an unparseable line passes through trimmed. */
export function formatLogLine(raw) {
	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		return clip(raw);
	}
	const at = typeof event.at === "string" ? event.at.slice(11, 19) : "??:??:??";
	const detail = logDetail(event);
	return `${at} ${event.type ?? "event"}${detail ? ` · ${detail}` : ""}`;
}

function logDetail(event) {
	switch (event.type) {
		case "turn":
			return `${event.usage?.totalTokens ?? 0} tokens`;
		case "cost":
			return formatMoney(event.costUsd);
		case "context":
			return `ctx ${event.percent ?? 0}%`;
		case "end":
			return event.stopReason;
		case "error":
			return clip(event.message, 60);
		case "wait":
			return `until ${typeof event.until === "string" ? event.until.slice(11, 19) : event.until}`;
		case "probe":
			return `${event.provider} ${event.ok ? "ok" : "still limited"}`;
		default:
			return undefined;
	}
}

/**
 * One dashboard frame as an array of lines, pure in `state` (shape: collectDashboardState).
 * Sections: the live runner, the frontier with per-feature ticket tables, cooldowns, the log tail.
 */
export function renderDashboard(state) {
	const now = state.now ?? new Date();
	const claims = state.claims ?? [];
	const cooldowns = state.cooldowns ?? [];
	const filter = state.featureFilter ?? null;
	const tickets = filter ? (state.tickets ?? []).filter((t) => t.feature === filter) : (state.tickets ?? []);
	const frontier = filter ? (state.frontier ?? []).filter((t) => t.feature === filter) : (state.frontier ?? []);
	const keys = `r run · s stop · d dry-run · f filter · q quits`;
	const lines = [`shiftwork tui ${VERSION} · ${stamp(now)} · ${keys}${filter ? ` · filter: ${filter}` : ""}`];
	if (state.notice) lines.push(`» ${state.notice}`);
	lines.push("");
	lines.push(...renderRunner(state.run, cooldowns, now), "");
	lines.push(...renderFeatures(tickets, frontier, claims, now), "");
	lines.push(...renderCooldowns(cooldowns, now), "");
	lines.push(...renderLog(state.log));
	if (state.dryRun) lines.push("", ...renderDryRun(state.dryRun, filter));
	return lines;
}

function renderDryRun(dryRun, filter) {
	if (dryRun.pending) return [`Dry-run${filter ? ` (feature ${filter})` : ""}: planning…`];
	return [`Dry-run${filter ? ` (feature ${filter})` : ""}:`, ...(dryRun.lines ?? []).map((line) => `  ${line}`)];
}

function renderRunner(run, cooldowns, now) {
	if (!run) return ["Runner: idle (no run state)"];
	const workers = run.workers ?? [];
	if (run.live && workers.length) {
		const started = `  started ${formatAge(now - new Date(run.startedAt ?? now))} ago`;
		if (workers.length === 1) {
			const w = workers[0];
			const t = w.ticket ?? {};
			const lines = [
				`Runner: working ${t.feature ?? "?"}/${t.number ?? "?"}${t.title ? ` · ${t.title}` : ""} (pid ${run.pid})`,
				`  shift ${w.shift ?? 1} · attempt ${w.attempt ?? 1} · ${w.model ?? "?"}${w.thinking ? ` · thinking ${w.thinking}` : ""}`,
				`  usage: ${formatUsage(w.usage ?? {})}`,
			];
			if (w.budget) lines.push(`  budget: ${formatBudget(w.budget)}`);
			lines.push(started);
			return lines;
		}
		const lines = [`Runner: running (pid ${run.pid}) · ${workers.length} workers`];
		for (const w of workers) {
			const t = w.ticket ?? {};
			lines.push(
				`  ${t.feature ?? "?"}/${t.number ?? "?"}${t.title ? ` · ${t.title}` : ""} · shift ${w.shift ?? 1} · attempt ${w.attempt ?? 1} · ${w.model ?? "?"}`,
				`    usage: ${formatUsage(w.usage ?? {})}`,
		);
		}
		lines.push(started);
		return lines;
	}
	if (run.live || run.running) {
		// Running but no ticket published: the runner is between shifts, usually waiting on a cooldown.
		if (cooldowns.length) {
			const waits = cooldowns.map((c) => `${c.provider} ${formatAge(leftMs(c, now))} left`).join(", ");
			return [`Runner: waiting on cooldowns (${waits})`];
		}
		return ["Runner: running · between tickets"];
	}
	const parts = ["Runner: not running"];
	if (run.stoppedReason) parts.push(`stopped: ${run.stoppedReason}`);
	if (run.summary) parts.push(`resolved ${run.summary.resolved ?? 0} · needs-info ${run.summary.needsInfo ?? 0}`);
	if (run.finishedAt) parts.push(`finished ${formatAge(now - new Date(run.finishedAt))} ago`);
	return [parts.join(" · ")];
}

function renderFeatures(tickets, frontier, claims, now) {
	if (!tickets.length) return ["Tickets: none (.scratch/<feature>/issues/*.md)"];
	const keyOf = (t) => `${t.feature}/${t.number}`;
	const lines = [`Frontier: ${frontier.map(keyOf).join(" · ") || "empty"} (${frontier.length} ready of ${tickets.length})`];
	if (claims.length) {
		const list = claims.map((c) => `${keyOf(c.ticket)} pid ${c.pid} · ${formatAge(now - new Date(c.at))}`).join(", ");
		lines.push(`Claims: ${list}`);
	}
	for (const feature of [...new Set(tickets.map((t) => t.feature))].sort()) {
		const own = tickets.filter((t) => t.feature === feature);
		lines.push("", `${feature} (${own.filter((t) => t.status === RESOLVED).length}/${own.length} resolved)`);
		lines.push(...formatTicketsTable(own).split("\n"));
	}
	return lines;
}

function renderCooldowns(cooldowns, now) {
	if (!cooldowns.length) return ["Cooldowns: none"];
	const sorted = [...cooldowns].sort((a, b) => new Date(a.until) - new Date(b.until));
	return ["Cooldowns:", ...sorted.map((c) => `  ${c.provider} (${c.kind ?? "limit"})  ${formatAge(leftMs(c, now))} left`)];
}

function renderLog(log) {
	if (!log) return ["Log: no current shift log"];
	if (!log.lines.length) return [`Log: ${log.path} (no events yet)`];
	return [`Log: ${log.path}`, ...log.lines.map((line) => `  ${line}`)];
}

function formatUsage(usage) {
	const parts = [`${usage.tokens ?? 0} tokens`, formatMoney(usage.costUsd), `${usage.turns ?? 0} turns`];
	if (usage.contextPct) parts.push(`ctx ${usage.contextPct}%`);
	return parts.join(" · ");
}

function leftMs(cooldown, now) {
	return Math.max(0, new Date(cooldown.until).getTime() - now.getTime());
}

function formatMoney(usd) {
	return `$${Number((usd ?? 0).toFixed(4))}`;
}

function stamp(date) {
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function clip(text, max = 72) {
	const line = String(text ?? "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatAge(ms) {
	ms = Math.max(0, ms);
	if (ms < 1000) return "0s";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	const remMin = min % 60;
	if (h < 24) return remMin ? `${h}h ${remMin}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const remH = h % 24;
	return remH ? `${d}d ${remH}h` : `${d}d`;
}
