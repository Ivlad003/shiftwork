import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openCooldowns, openRepoTracker, openRunState, VERSION } from "shiftwork-core";
import { formatBudget } from "./dry-run.js";
import { queueRows, TABS } from "./tui-controls.js";

/** One frame per second, per the spec. */
export const REFRESH_MS = 1000;
const LOG_TAIL = 8;

const TAB_LABELS = { queue: "Queue", agents: "Agents", cooldowns: "Cooldowns", log: "Log" };

/** The keys every tab shares, the footer's second line. */
export const GLOBAL_KEYS = "r run · s stop · d dry-run · f filter · q quits";

/** The keys of each tab, the footer's first line. */
const TAB_KEYS = {
	queue: "↑↓ move · ←→ fold · enter open · n run this · esc back",
	agents: "↑↓ move · enter log",
	cooldowns: "↑↓ move",
	log: "↑↓ move",
};

/**
 * Collect everything one dashboard frame needs: the tracker's tickets, the frontier,
 * live claims, the run state (`.pi/shiftwork-run.json`), active cooldowns and a log
 * tail — the selected worker's when the view has one (`view.selectedWorker`, else the
 * first live worker's), plus, when details are open (`view.details`), that ticket's
 * body as `ticketDetails` (the What-to-build line and the latest shift report).
 * A missing run state or log yields null/empty, never a throw.
 */
export async function collectDashboardState(root, { now = new Date(), logTail = LOG_TAIL, view = {} } = {}) {
	const tracker = await openRepoTracker(root);
	const [tickets, frontier, claims, run, cooldowns] = await Promise.all([
		tracker.list(),
		tracker.frontier(),
		tracker.activeClaims(),
		openRunState(root).read(),
		openCooldowns(root).active(now),
	]);
	const log = await tailShiftLog(root, run, logTail, view.selectedWorker ?? null);
	const ticketDetails = view.details ? await readTicketDetails(tickets, view.details) : null;
	return { now, tickets, frontier, claims, run, cooldowns, log, ticketDetails };
}

/** The last `maxLines` events of the selected worker's log (else the first live worker's); null when none. */
export async function tailShiftLog(root, run, maxLines = LOG_TAIL, selected = null) {
	const workers = run?.workers ?? [];
	const keyOf = (w) => `${w.ticket?.feature ?? ""}/${w.ticket?.number ?? ""}`;
	const worker =
		(selected ? workers.find((w) => keyOf(w) === selected && w.attempt) : null) ??
		workers.find((w) => w.ticket?.feature && w.ticket?.number && w.attempt);
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

/** The open details: the ticket from the list plus, from its file, the What-to-build line and the latest shift report. */
async function readTicketDetails(tickets, key) {
	const [feature, number] = String(key).split("/");
	const ticket = (tickets ?? []).find((t) => t.feature === feature && t.number === number) ?? null;
	if (!ticket?.path) return { key, ticket, what: null, shift: [] };
	let text;
	try {
		text = await readFile(ticket.path, "utf8");
	} catch {
		return { key, ticket, what: null, shift: [] };
	}
	return { key, ticket, what: field(text, "What to build"), shift: latestShiftReport(text) };
}

function field(text, name) {
	const match = text.match(new RegExp(`^\\s*(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(.+?)\\s*$`, "im"));
	return match ? match[1].replace(/<!--.*?-->/g, "").trim() : null;
}

/** The last `### Shift …` block under `## Comments`, as its raw lines; empty without one. */
function latestShiftReport(markdown) {
	const comments = markdown.split(/^## /m).find((section) => section.startsWith("Comments"));
	if (!comments) return [];
	const blocks = comments.split(/^### /m).filter((block) => /^Shift /.test(block));
	if (!blocks.length) return [];
	const lines = blocks.at(-1).split("\n");
	while (lines.length && !lines.at(-1).trim()) lines.pop();
	return lines.map((line, i) => (i === 0 ? `### ${line}` : line));
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
 * One dashboard frame as an array of lines, pure in `state` (shape: collectDashboardState
 * merged with the view state: tab, cursor, collapsed, details, selectedWorker,
 * featureFilter, notice, dryRun).
 *
 * With a `height` the frame is one tab: a header (tabs, version, time, notice), the tab
 * body — lists scroll so the cursor row stays visible — and a footer with the tab's keys.
 * It returns at most `height` lines, each at most `width` columns.
 * Without a `height` (`--once`, the plain-text fallback) the Queue and Agents tabs are
 * printed one after the other, unbounded, then Cooldowns, Log and the dry-run panel.
 */
export function renderDashboard(state, { width, height } = {}) {
	const lines = height == null ? renderPlain(state) : renderSized(state, height);
	const max = width ?? Infinity;
	return max === Infinity ? lines : lines.map((line) => fit(line, max));
}

// --- The sized frame: one tab, scrolled to the cursor ---

function renderSized(state, height) {
	const now = state.now ?? new Date();
	const tab = TABS.includes(state.tab) ? state.tab : "queue";
	const header = [headerLine(state, now, tab)];
	if (state.notice) header.push(`» ${state.notice}`);
	const footer = [TAB_KEYS[tab], GLOBAL_KEYS];
	const room = height - header.length - footer.length;
	const blank = room >= 2 ? 1 : 0;
	const body = tabBody(state, tab, Math.max(0, room - blank), now);
	const lines = [...header, ...(blank ? [""] : []), ...body, ...footer];
	return lines.length <= height ? lines : lines.slice(0, Math.max(0, height));
}

/** The body of one tab: the queue's rows or open details, the agents' rows, the cooldowns, the log. */
function tabBody(state, tab, height, now) {
	if (height <= 0) return [];
	const cursor = { queue: 0, agents: 0, cooldowns: 0, log: 0, ...(state.cursor ?? {}) };
	switch (tab) {
		case "queue": {
			if (state.details) return renderDetails(state).slice(0, height);
			const rows = renderQueueRows(state, -1);
			if (!rows.length) return ["Tickets: none (.scratch/<feature>/issues/*.md)"].slice(0, height);
			const at = clampCursor(cursor.queue, rows.length);
			return scrollRows(renderQueueRows(state, at), at, height);
		}
		case "agents": {
			const workers = state.run?.workers ?? [];
			const head = [agentsHead(state.run, state.cooldowns ?? [], now)];
			if (!workers.length) return head.slice(0, height);
			const at = clampCursor(cursor.agents, workers.length);
			const rows = workers.map((w, i) => `${i === at ? ">" : " "} ${agentRow(w, state.run, now)}`);
			return [...head, ...scrollRows(rows, at, height - 1)].slice(0, height);
		}
		case "cooldowns": {
			const cooldowns = [...(state.cooldowns ?? [])].sort((a, b) => new Date(a.until) - new Date(b.until));
			if (!cooldowns.length) return ["Cooldowns: none"].slice(0, height);
			const at = clampCursor(cursor.cooldowns, cooldowns.length);
			const rows = cooldowns.map((c, i) => `${i === at ? ">" : " "} ${c.provider} (${c.kind ?? "limit"})  ${formatAge(leftMs(c, now))} left`);
			return ["Cooldowns:", ...scrollRows(rows, at, height - 1)].slice(0, height);
		}
		case "log": {
			const log = state.log;
			if (!log) return ["Log: no current shift log"].slice(0, height);
			if (!log.lines.length) return [`Log: ${log.path} (no events yet)`].slice(0, height);
			const at = clampCursor(cursor.log, log.lines.length);
			const rows = log.lines.map((line, i) => `${i === at ? ">" : " "} ${line}`);
			return [`Log: ${log.path}`, ...scrollRows(rows, at, height - 1)].slice(0, height);
		}
		default:
			return [];
	}
}

function clampCursor(cursor, length) {
	return Math.max(0, Math.min(cursor ?? 0, length - 1));
}

/** The window of `rows` that keeps row `at` (the cursor) visible. */
function scrollRows(rows, at, max) {
	if (rows.length <= max) return rows;
	const start = Math.min(Math.max(0, at - max + 1), rows.length - max);
	return rows.slice(start, start + max);
}

// --- The plain frame: every tab's section, unbounded (--once, the fallback) ---

function renderPlain(state) {
	const now = state.now ?? new Date();
	const tab = TABS.includes(state.tab) ? state.tab : "queue";
	const lines = [headerLine(state, now, tab)];
	if (state.notice) lines.push(`» ${state.notice}`);
	lines.push("");
	if (state.details) lines.push(...renderDetails(state), "");
	lines.push(...renderQueueSection(state, now), "", ...renderAgentsSection(state, now), "");
	lines.push(...renderCooldowns(state.cooldowns ?? [], now), "", ...renderLog(state.log));
	if (state.dryRun) lines.push("", ...renderDryRun(state.dryRun, state.featureFilter ?? null));
	lines.push("", GLOBAL_KEYS);
	return lines;
}

/** The header line: version, time, the four tabs (the open one bracketed) and the feature filter. */
function headerLine(state, now, tab) {
	const tabs = TABS.map((t, i) => `${t === tab ? "[" : ""}${i + 1} ${TAB_LABELS[t]}${t === tab ? "]" : ""}`).join("  ");
	const line = `shiftwork tui ${VERSION} · ${stamp(now)} · ${tabs}`;
	return state.featureFilter ? `${line} · filter: ${state.featureFilter}` : line;
}

// --- The Queue tab: feature folders and their tickets, the cursor row marked ---

function renderQueueSection(state, now) {
	const filter = state.featureFilter ?? null;
	const tickets = filter ? (state.tickets ?? []).filter((t) => t.feature === filter) : (state.tickets ?? []);
	if (!tickets.length) return ["Tickets: none (.scratch/<feature>/issues/*.md)"];
	const frontier = (state.frontier ?? []).filter((t) => !filter || t.feature === filter);
	const keyOf = (t) => `${t.feature}/${t.number}`;
	const lines = [`Frontier: ${frontier.map(keyOf).join(" · ") || "empty"} (${frontier.length} ready of ${tickets.length})`];
	if ((state.claims ?? []).length) {
		const list = state.claims.map((c) => `${keyOf(c.ticket)} pid ${c.pid} · ${formatAge(now - new Date(c.at))}`).join(", ");
		lines.push(`Claims: ${list}`);
	}
	lines.push(...renderQueueRows(state, -1));
	return lines;
}

/** The queue's visible rows: `▾ feature 1/3 resolved · 1 ready` folders (▸ collapsed), their tickets under, `> ` marks the cursor. */
function renderQueueRows(state, cursor) {
	return queueRows(state, state).map((row, i) => {
		const mark = i === cursor ? ">" : " ";
		if (row.kind === "feature") {
			return `${mark} ${row.collapsed ? "▸" : "▾"} ${row.feature} ${row.resolved}/${row.total} resolved · ${row.ready} ready`;
		}
		const parts = [`${row.number} ${row.title ?? ""}`.trim(), row.status];
		if (row.blockedBy?.length) parts.push(`blocked by ${row.blockedBy.join(", ")}`);
		if (row.worker) parts.push(`● ${row.worker.model ?? "?"}`);
		return `${mark}   ${parts.join(" · ")}`;
	});
}

/** The details of the selected ticket: its fields, the dry-run route when known, the latest shift report. */
function renderDetails(state) {
	const key = state.details;
	const data = state.ticketDetails?.key === key ? state.ticketDetails : null;
	const ticket = data?.ticket ?? (state.tickets ?? []).find((t) => `${t.feature}/${t.number}` === key) ?? null;
	if (!ticket) return [`${key} · ticket not found`];
	const lines = [[key, ticket.title, ticket.status].filter(Boolean).join(" · ")];
	lines.push(`Type: ${ticket.type ?? "-"}`);
	lines.push(`Model: ${ticket.model ?? "-"}`);
	lines.push(`Budget: ${ticket.budget ?? "-"}`);
	lines.push(`Verify: ${ticket.verify?.length ? ticket.verify.join(" · ") : "-"}`);
	lines.push(`Blocked by: ${ticket.blockedBy?.length ? ticket.blockedBy.join(", ") : "none"}`);
	const route = (state.dryRun?.lines ?? []).find((line) => line.startsWith(`${key}  `));
	if (route) lines.push(`Route: ${route}`);
	if (data) lines.push(`What to build: ${data.what ?? "-"}`);
	if (data?.shift?.length) lines.push("Last shift report:", ...data.shift.map((line) => `  ${line}`));
	return lines;
}

// --- The Agents tab: the runner line, one row per worker ---

function renderAgentsSection(state, now, cursor = -1) {
	const workers = state.run?.workers ?? [];
	const lines = [agentsHead(state.run, state.cooldowns ?? [], now)];
	lines.push(...workers.map((w, i) => `${i === cursor ? ">" : " "} ${agentRow(w, state.run, now)}`));
	return lines;
}

/** The runner line above the agents' rows: working/running when shifts are live, else the runner's state. */
function agentsHead(run, cooldowns, now) {
	const workers = run?.workers ?? [];
	if (run?.live && workers.length) {
		const started = run.startedAt ? ` · started ${formatAge(now - new Date(run.startedAt))} ago` : "";
		if (workers.length === 1) {
			const t = workers[0].ticket ?? {};
			return `Runner: working ${t.feature ?? "?"}/${t.number ?? "?"}${t.title ? ` · ${t.title}` : ""} (pid ${run.pid})${started}`;
		}
		return `Runner: running (pid ${run.pid}) · ${workers.length} workers${started}`;
	}
	return runnerHead(run, cooldowns, now);
}

/** One worker row: ticket, model ref, tier, shift/attempt, usage, budget, elapsed. */
function agentRow(w, run, now) {
	const t = w.ticket ?? {};
	const key = `${t.feature ?? "?"}/${t.number ?? "?"}`;
	const usage = w.usage ?? {};
	const parts = [t.title ? `${key} ${t.title}` : key, w.model ?? "?"];
	if (w.tier) parts.push(w.tier);
	parts.push(`shift ${w.shift ?? 1} · attempt ${w.attempt ?? 1}`, `${usage.tokens ?? 0} tokens`, formatMoney(usage.costUsd), `${usage.turns ?? 0} turns`);
	if (usage.contextPct) parts.push(`ctx ${usage.contextPct}%`);
	const budget = w.budget && Object.keys(w.budget).length ? formatBudget(w.budget) : null;
	if (budget) parts.push(budget);
	const started = w.startedAt ?? run?.startedAt;
	if (started) parts.push(`${formatAge(now - new Date(started))} elapsed`);
	return parts.join(" · ");
}

/** The runner's line when no shift is live: idle, waiting on cooldowns, between tickets, or how it ended. */
function runnerHead(run, cooldowns, now) {
	if (!run) return "Runner: idle (no run state)";
	if (run.live || run.running) {
		// Running but no ticket published: the runner is between shifts, usually waiting on a cooldown.
		if (cooldowns.length) {
			const waits = cooldowns.map((c) => `${c.provider} ${formatAge(leftMs(c, now))} left`).join(", ");
			return `Runner: waiting on cooldowns (${waits})`;
		}
		return "Runner: running · between tickets";
	}
	const parts = ["Runner: not running"];
	if (run.stoppedReason) parts.push(`stopped: ${run.stoppedReason}`);
	if (run.summary) parts.push(`resolved ${run.summary.resolved ?? 0} · needs-info ${run.summary.needsInfo ?? 0}`);
	if (run.finishedAt) parts.push(`finished ${formatAge(now - new Date(run.finishedAt))} ago`);
	return parts.join(" · ");
}

// --- The Cooldowns and Log sections, shared by the plain frame and their tabs ---

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

function renderDryRun(dryRun, filter) {
	if (dryRun.pending) return [`Dry-run${filter ? ` (feature ${filter})` : ""}: planning…`];
	return [`Dry-run${filter ? ` (feature ${filter})` : ""}:`, ...(dryRun.lines ?? []).map((line) => `  ${line}`)];
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

/** Clip one line to `width` columns with an ellipsis; a very narrow width just truncates. */
function fit(line, width) {
	if (line.length <= width) return line;
	return width <= 1 ? line.slice(0, Math.max(0, width)) : `${line.slice(0, width - 1)}…`;
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
