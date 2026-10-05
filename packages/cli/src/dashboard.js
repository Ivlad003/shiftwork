import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAIMED, openCooldowns, openRepoTracker, openRunState, parseModelRef, RESOLVED, shiftworkPath, VERSION } from "shiftwork-core";
import { formatBudget } from "./dry-run.js";
import { readIssueState } from "./github-import.js";
import { parsePostKey } from "./github-post.js";
import { githubRows, keptTicketSearch, queueRows, TABS, ticketStatusColumn } from "./tui-controls.js";

// queueRows' `resolved` option: "skip" is the Queue tab's view, "only" the Resolved tab's, null the plain frame's.

/** One frame per second, per the spec. */
export const REFRESH_MS = 1000;
const LOG_TAIL = 8;
/** How much of a shift log's end the dashboard reads each second: plenty for LOG_TAIL lines. */
export const LOG_TAIL_BYTES = 64 * 1024;

const TAB_LABELS = { queue: "Queue", agents: "Agents", cooldowns: "Cooldowns", log: "Log", resolved: "Resolved", github: "GitHub" };

/** The keys every tab shares, the footer's second line. */
export const GLOBAL_KEYS = "r run · s stop · d dry-run · f filter · g dark-factory · q quits";

/**
 * The footer's first line while a search is open (GitHub #3): the prompt's keys while it is
 * being edited, list or details — and the keys a kept details search keeps (tui-polish/09).
 * Both prompts' `enter` only stops editing and keeps the search (tui-polish/10): the jump to
 * the next match is the kept search's `enter`, the one after this.
 */
const SEARCH_KEYS = {
	list: "letters add to the query · backspace delete · tab scope · enter keep · esc clear",
	ticket: "letters add to the query · backspace delete · enter keep · esc clear",
	kept: "enter next match · esc clear",
};

// Plain SGR codes, applied after fit() clips a line, so escapes are never cut and width counts visible columns.
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const FG_OFF = "\x1b[39m";
const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const REVERSE = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";
const STATUS_COLORS = { resolved: GREEN, claimed: CYAN, "needs-info": YELLOW };

/*
 * The status column's words (tui-polish/07), as a paint layer regex: `ticketStatusColumn` in
 * tui-controls.js writes them; here they are found in a rendered line and coloured by their
 * glyph — ▶ working cyan, ● next bold, ⧗ waits dim, ? needs you yellow, ✔ done green; the
 * plain words (✋ ○ ✖ ⏸) stay plain. The blockers of `⧗ waits 01, 03` are numbers joined `, `;
 * the two spaces after the padded column keep the title out of the match.
 */
const STATUS_COLUMN_RE =
	/(▶ working (?:pid \d+|\S+)|● next #\d+|⧗ waits(?: \d+(?:, \d+)*)?|\? needs you|✋ for human|○ triage|✔ done|✖ wontfix|⏸ paused)/g;
const TONE_ON = { "▶": CYAN, "●": BOLD, "⧗": DIM, "?": YELLOW, "✔": GREEN };
const TONE_OFF = { "▶": FG_OFF, "●": BOLD_OFF, "⧗": DIM_OFF, "?": FG_OFF, "✔": FG_OFF };

/** The keys of each tab, the footer's first line. */
const TAB_KEYS = {
	queue: "↑↓ move · ←→ fold · enter open · n run this · p pause · esc back",
	agents: "↑↓ move · enter log",
	cooldowns: "↑↓ move",
	log: "↑↓ move",
	resolved: "↑↓ move · ←→ fold · enter open · esc back",
	github: "↑↓ move · enter open in queue",
};

/** The issue statuses the GitHub tab's state column shows, derived from the feature's tickets. */
const NEEDS_INFO = "needs-info";

/**
 * Collect everything one dashboard frame needs: the tracker's tickets, the frontier,
 * live claims, the run state (`.shiftwork/shiftwork-run.json`), active cooldowns and a log
 * tail — the selected worker's when the view has one (`view.selectedWorker`, else the
 * first live worker's), plus, when details are open (`view.details`), that ticket's
 * body as `ticketDetails` (the What-to-build line and the latest shift report) —
 * and the GitHub tab's rows (`github`, from `.shiftwork/shiftwork-github.json` and the
 * tickets). A missing run state, log or issue state yields null/empty, never a throw.
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
	const github = await readGithubIssues(root, tickets);
	return { now, tickets, frontier, claims, run, cooldowns, log, ticketDetails, github };
}

/**
 * The GitHub tab's rows (github-watch, ticket 06), from `.shiftwork/shiftwork-github.json`:
 * one `{ number, title, feature, state }` per imported issue, sorted by number, plus
 * `syncedAt` (the time of the last sync, written by `syncIssues`). The state comes
 * from the feature's tickets: `closed` when the issue was closed (`done` posted),
 * `done` when every ticket is resolved, `needs-info` when one needs information,
 * `working` when one is claimed or resolved, else `planning`. An unreadable state
 * file yields empty rows, never a throw — the dashboard must not die for it.
 */
export async function readGithubIssues(root, tickets) {
	let state;
	try {
		state = await readIssueState(root);
	} catch {
		return { issues: [], syncedAt: null };
	}
	const issues = Object.values(state.issues ?? {})
		.map((entry) => ({
			number: entry.number,
			title: entry.title ?? null,
			feature: entry.feature,
			state: issueState(entry, tickets),
		}))
		.sort((a, b) => Number(a.number) - Number(b.number));
	return { issues, syncedAt: state.syncedAt ?? null };
}

/** One imported issue's state, derived from its feature's tickets. */
function issueState(entry, tickets) {
	const own = (tickets ?? []).filter((t) => t.feature === entry.feature && t.number);
	if (!own.length) return "planning";
	if ((entry.posted ?? []).some(isClosedPost)) return "closed";
	if (own.every((t) => t.status === RESOLVED)) return "done";
	if (own.some((t) => t.status === NEEDS_INFO)) return "needs-info";
	if (own.some((t) => t.status === CLAIMED || t.status === RESOLVED)) return "working";
	return "planning";
}

/** Whether a `posted` key is the issue-closed key (`done`), not `done-label`. */
function isClosedPost(key) {
	const parsed = parsePostKey(key);
	return parsed.kind === "done" && parsed.ticket === undefined;
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
	const dir = join("logs", ticket.feature, ticket.number);
	const path = join(dir, await currentShiftLogName(join(root, dir), shiftLogSlot(worker.attempt, worker.shift)));
	let text;
	try {
		text = await readTail(join(root, path), LOG_TAIL_BYTES);
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

/** The last `bytes` of a file, starting at a whole line (the partial first one dropped). */
async function readTail(file, bytes) {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
	} finally {
		await handle.close();
	}
}

/**
 * Shift log names: `attempt-<n>.jsonl`, and when an earlier run already wrote that
 * one, `attempt-<n>.<k>.jsonl` with the next free k (2, 3, …) — attempt numbers
 * restart each run, so one file never mixes two runs' sessions.
 */
const shiftLogName = (attempt, k = 1) => (k > 1 ? `attempt-${attempt}.${k}.jsonl` : `attempt-${attempt}.jsonl`);

/** The k of a shift log name for `attempt`, or 0 when it is another attempt's. */
/** The log slot of a shift: its attempt, or `<attempt>-a|b|merge` for a dual shift (ADR-0007), whose
 * candidates run at once and must not share a file. A worker's `shift` is that label for a dual shift. */
export function shiftLogSlot(attempt, dual) {
	return typeof dual === "string" && /^(?:a|b|merge)$/i.test(dual) ? `${attempt}-${dual.toLowerCase()}` : attempt;
}

function shiftLogIndex(name, attempt) {
	const prefix = `attempt-${attempt}.`;
	if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) return 0;
	const middle = name.slice(prefix.length, -".jsonl".length);
	if (middle === "") return 1;
	return /^[1-9]\d*$/.test(middle) ? Number(middle) : 0;
}

/** The newest log name for `attempt` in `dir` (the highest k); `attempt-<n>.jsonl` when there is none. */
export async function currentShiftLogName(dir, attempt) {
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		// No log yet.
	}
	const k = Math.max(1, ...names.map((name) => shiftLogIndex(name, attempt)));
	return shiftLogName(attempt, k);
}

/** The first free log name for `attempt` in `dir`: a new run never appends to an earlier run's file. */
function freeShiftLogName(dir, attempt) {
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return shiftLogName(attempt);
	}
	const taken = Math.max(0, ...names.map((name) => shiftLogIndex(name, attempt)));
	return shiftLogName(attempt, taken + 1);
}

/** Events the shift log skips: pi's extension UI requests are noise, not the shift's work. */
const isDroppedEvent = (event) => event?.type === "raw" && event.event?.type === "extension_ui_request";

/**
 * The runner's shift log: every shift event as NDJSON under
 * logs/<feature>/<NN>/attempt-<n>[.<k>].jsonl, one file per shift — a shift after an
 * `end` (a handoff, or the same attempt number in a later run or dark-factory pass)
 * opens the next free name, so no file mixes two sessions. Each file opens with a
 * `start` event naming the backend, model, tier, attempt, shift, run start and pid,
 * read from this runner's worker in `.shiftwork/shiftwork-run.json` (the runner writes it
 * before the shift's first event). `options` (tests): now, pid.
 */
export function createShiftLogger(root, { now = () => new Date(), pid = process.pid } = {}) {
	const runId = now().toISOString();
	const files = new Map(); // `${feature}/${number}/${attempt}` → { file, started, ended }
	return ({ ticket, attempt, dual, event }) => {
		if (isDroppedEvent(event)) return;
		const dir = join(root, "logs", ticket.feature, ticket.number);
		const slot = shiftLogSlot(attempt, dual);
		const key = `${ticket.feature}/${ticket.number}/${slot}`;
		// Probes and waits come before the shift is published: they never open a shift.
		const shiftEvent = event.type !== "probe" && event.type !== "wait";
		let log = files.get(key);
		if (!log || (shiftEvent && log.ended)) {
			mkdirSync(dir, { recursive: true });
			log = { file: join(dir, freeShiftLogName(dir, slot)), started: false, ended: false };
			files.set(key, log);
		}
		const write = (record) => appendFileSync(log.file, `${JSON.stringify({ at: now().toISOString(), ...record })}\n`);
		if (shiftEvent && !log.started) {
			log.started = true;
			const worker = readOwnWorker(root, pid, ticket, dual);
			const model = worker?.model ?? null;
			write({
				type: "start",
				backend: model ? parseModelRef(model).backend : null,
				model,
				tier: worker?.tier ?? null,
				attempt,
				shift: worker?.shift ?? null,
				runId,
				pid,
			});
		}
		write(event);
		if (event.type === "end") log.ended = true;
	};
}

/** This runner's worker for `ticket` in `.shiftwork/shiftwork-run.json` (the dual candidate's own
 * when `dual` names one), or null. */
function readOwnWorker(root, pid, ticket, dual) {
	const path = shiftworkPath(root, "shiftwork-run.json");
	if (!existsSync(path)) return null;
	try {
		const state = JSON.parse(readFileSync(path, "utf8"));
		const runners = Array.isArray(state?.runners) ? state.runners : [state];
		const runner = runners.find((r) => r?.pid === pid);
		const mine = (runner?.workers ?? []).filter((w) => w.ticket?.feature === ticket.feature && w.ticket?.number === ticket.number);
		return (dual === undefined ? mine[0] : mine.find((w) => String(w.shift) === String(dual))) ?? null;
	} catch {
		return null;
	}
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
	const shift = latestShiftReport(text);
	return { key, ticket, what: field(text, "What to build"), shift, reason: needsInfoReason(shift, text) };
}

/**
 * Why a needs-info ticket waits for you: the last shift report's `- Outcome: needs-info: …` line
 * — the runner writes the reason there — else a `<shiftwork:needs-info reason=…/>` marker in
 * the body (the review verdict form). null without either.
 */
function needsInfoReason(shiftLines, markdown) {
	for (const line of [...shiftLines].reverse()) {
		const outcome = line.match(/^- Outcome: needs-info: (.+)$/);
		if (outcome) return outcome[1].trim();
	}
	const marker = markdown.match(/<shiftwork:needs-info\s+reason="([^"]*)"\s*\/>/);
	return marker ? marker[1] : null;
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
		case "start":
			return [event.model, event.tier, event.attempt !== undefined ? `attempt ${event.attempt}` : null].filter(Boolean).join(" · ") || undefined;
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
 *
 * With `color: true` (the interactive view, unless `NO_COLOR` is set) SGR codes are
 * applied after clipping: the cursor row is reverse video across the width, the status
 * column is coloured (done green, working cyan, next bold, waits dim, needs you yellow),
 * the `● model` worker marker is cyan, cooldown rows are red, the active tab label is
 * bold and the `»` notice is yellow. `color` defaults to false, so `--once`, non-TTY
 * output and the plain-text fallback stay colourless — with the same status-column words.
 */
export function renderDashboard(state, { width, height, color = false } = {}) {
	return dashboardLayout(state, { width, height, color }).lines;
}

/**
 * One dashboard frame plus its hit map (GitHub #5): `{ lines, rows, tabs }`. `lines` is
 * exactly what `renderDashboard` returns. `rows` maps each visible list row of the current
 * tab to the screen line it sits on (`{ y, index }`, `index` the row's index in the tab's
 * rows, so the mouse layer can turn a click at `y` into `{ type: "click", row: index }`);
 * `tabs` is the column span of each tab label on line 0 (`{ tab, x0, x1 }`, visible columns,
 * colour codes aside). Both are clipped like the lines (a row past the height, a label past
 * the width is not a hit), and a scrolled list's `index` counts from the top of the tab's
 * rows, not the window. A plain frame (no `height`: `--once`, the fallback) has no hit map.
 */
export function dashboardLayout(state, { width, height, color = false } = {}) {
	if (height == null) {
		const lines = fitLines(renderPlain(state), width);
		return { lines: color ? paint(lines, { cursor: -1, redRows: [] }, width) : lines, rows: [], tabs: [] };
	}
	const frame = renderSized(state, height);
	const lines = fitLines(frame.lines, width);
	const max = width ?? Infinity;
	const tabs = max === Infinity ? frame.tabs : frame.tabs.filter((t) => t.x0 < max).map((t) => ({ ...t, x1: Math.min(t.x1, max) }));
	return {
		lines: color ? paint(lines, frame, max) : lines,
		rows: frame.rows.filter((row) => row.y < lines.length),
		tabs,
	};
}

/** Clip every line to `width` columns; no `width` leaves the frame as it is. */
function fitLines(lines, width) {
	const max = width ?? Infinity;
	return max === Infinity ? lines : lines.map((line) => fit(line, max));
}

/** Sprinkle SGR codes over an already-clipped frame: inline tokens, the details' search highlights, red cooldown rows, then reverse video over the cursor row, padded across the width. */
function paint(lines, { cursor, redRows, highlight }, width) {
	return lines.map((line, i) => {
		let out = paintTokens(line, i === 0);
		if (highlight && i >= highlight.from && i < highlight.to) out = unbracket(out, highlight.query);
		if (redRows.includes(i)) out = `${RED}${out}${FG_OFF}`;
		if (i === cursor && Number.isFinite(width)) {
			const pad = " ".repeat(Math.max(0, width - visibleColumns(out)));
			out = `${REVERSE}${out}${pad}${REVERSE_OFF}`;
		}
		return out;
	});
}

/** A details line's `[query]` search highlights (GitHub #3) become reverse video in colour. */
function unbracket(line, query) {
	return line.replace(new RegExp(`\\[(${escapeRe(query)})\\]`, "gi"), (m, text) => `${REVERSE}${text}${REVERSE_OFF}`);
}

/** A line's width in visible columns: SGR sequences don't count. */
function visibleColumns(line) {
	return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** The colourable tokens of one line: the notice, the status column, status words, worker markers, the active tab label. */
function paintTokens(line, isHeader) {
	let out = line.startsWith("»") ? `${YELLOW}${line}${FG_OFF}` : line;
	out = out.replace(STATUS_COLUMN_RE, (m) => {
		const tone = TONE_ON[m[0]];
		return tone ? `${tone}${m}${TONE_OFF[m[0]]}` : m;
	});
	out = out.replace(/ · (resolved|claimed|needs-info)(?=[ ·]|$)/g, (m, status) => ` · ${STATUS_COLORS[status]}${status}${FG_OFF}`);
	out = out.replace(/ · ● [^·]*/g, (m) => ` · ${CYAN}${m.slice(3)}${FG_OFF}`);
	if (isHeader) out = out.replace(/\[\d \w+\]/, (m) => `${BOLD}${m}${BOLD_OFF}`);
	return out;
}

// --- The sized frame: one tab, scrolled to the cursor ---

function renderSized(state, height) {
	const now = state.now ?? new Date();
	const tab = TABS.includes(state.tab) ? state.tab : "queue";
	const header = [headerLine(state, now, tab)];
	if (state.search) header.push(searchLine(state));
	if (state.notice) header.push(`» ${state.notice}`);
	const footer = [footerKeys(state, tab), GLOBAL_KEYS];
	const room = height - header.length - footer.length;
	const blank = room >= 2 ? 1 : 0;
	const body = tabBody(state, tab, Math.max(0, room - blank), now);
	const lines = [...header, ...(blank ? [""] : []), ...body.lines, ...footer];
	const cut = lines.length <= height ? lines : lines.slice(0, Math.max(0, height));
	const offset = header.length + blank;
	const visible = (i) => offset + i < cut.length; // a row past the cut height is not a hit
	// The details' ticket search (GitHub #3) highlights its lines: where they sit on screen.
	const to = Math.min(offset + body.lines.length, cut.length);
	const highlight = body.highlight && offset < to ? { query: body.highlight, from: offset, to } : null;
	return {
		lines: cut,
		cursor: body.cursor >= 0 && visible(body.cursor) ? offset + body.cursor : -1,
		redRows: body.redRows.filter(visible).map((i) => offset + i),
		rows: body.rows.filter((row) => visible(row.i)).map((row) => ({ y: offset + row.i, index: row.index })),
		tabs: tabSpans(now, tab),
		highlight,
	};
}

/**
 * The footer's first line: the search prompt's keys while its query is being edited
 * (`search.editing`); a kept search then brings the tab's keys back, so `q` quits again
 * (tui-polish/08) — except a kept details search, whose real keys stay instead of the tab's:
 * `enter` jumps to the next match and `esc` clears the search (tui-polish/09).
 */
function footerKeys(state, tab) {
	if (state.search?.editing) return state.search.scope === "ticket" ? SEARCH_KEYS.ticket : SEARCH_KEYS.list;
	if (keptTicketSearch(state)) return SEARCH_KEYS.kept;
	return TAB_KEYS[tab];
}

/**
 * The body of one tab: the queue's or the Resolved tab's rows or open details, the agents'
 * rows, the cooldowns, the log — as its lines plus where the cursor row and the red cooldown
 * rows sit among them.
 */
function tabBody(state, tab, height, now) {
	if (height <= 0) return { lines: [], cursor: -1, redRows: [], rows: [] };
	const cursor = { queue: 0, agents: 0, cooldowns: 0, log: 0, resolved: 0, github: 0, ...(state.cursor ?? {}) };
	const plain = (lines) => ({ lines: lines.slice(0, height), cursor: -1, redRows: [], rows: [] });
	/** The hit rows of a list window: each of its lines is one row of the tab's rows, from `start`. */
	const hitRows = (window, shift = 0) => window.lines.map((_, j) => ({ i: shift + j, index: window.start + j }));
	/** A tab whose rows sit under a one-line head: the cursor row index shifts by one. */
	const underHead = (head, window) => ({
		lines: [...head, ...window.lines].slice(0, height),
		cursor: window.cursor >= 0 ? window.cursor + 1 : -1,
		redRows: [],
		rows: hitRows(window, head.length),
	});
	switch (tab) {
		case "queue": {
			if (state.details) return detailsBody(state, height);
			const rows = renderQueueRows(state, -1);
			if (!rows.length) return plain(["Tickets: none (.scratch/<feature>/issues/*.md)"]);
			const at = clampCursor(cursor.queue, rows.length);
			const window = scrolled(renderQueueRows(state, at), at, height);
			return { lines: window.lines, cursor: window.cursor, redRows: [], rows: hitRows(window) };
		}
		case "resolved": {
			// The Queue's fully resolved features (GitHub #2), same rows, same cursor and fold.
			if (state.details) return detailsBody(state, height);
			const rows = renderQueueRows(state, -1, { resolved: "only" });
			if (!rows.length) return plain(["Resolved: none"]);
			const at = clampCursor(cursor.resolved, rows.length);
			const window = scrolled(renderQueueRows(state, at, { resolved: "only" }), at, height);
			return { lines: window.lines, cursor: window.cursor, redRows: [], rows: hitRows(window) };
		}
		case "agents": {
			const workers = state.run?.workers ?? [];
			const head = [agentsHead(state.run, state.cooldowns ?? [], now)];
			if (!workers.length) return plain(head);
			const at = clampCursor(cursor.agents, workers.length);
			const rows = workers.map((w, i) => `${i === at ? ">" : " "} ${agentRow(w, state.run, now)}`);
			return underHead(head, scrolled(rows, at, height - 1));
		}
		case "cooldowns": {
			const cooldowns = [...(state.cooldowns ?? [])].sort((a, b) => new Date(a.until) - new Date(b.until));
			if (!cooldowns.length) return plain(["Cooldowns: none"]);
			const at = clampCursor(cursor.cooldowns, cooldowns.length);
			const rows = cooldowns.map((c, i) => `${i === at ? ">" : " "} ${c.provider} (${c.kind ?? "limit"})  ${formatAge(leftMs(c, now))} left`);
			const window = scrolled(rows, at, height - 1);
			const lines = ["Cooldowns:", ...window.lines].slice(0, height);
			return { lines, cursor: window.cursor >= 0 ? window.cursor + 1 : -1, redRows: lines.slice(1).map((_, i) => i + 1), rows: hitRows(window, 1) };
		}
		case "log": {
			const log = state.log;
			if (!log) return plain(["Log: no current shift log"]);
			if (!log.lines.length) return plain([`Log: ${log.path} (no events yet)`]);
			const at = clampCursor(cursor.log, log.lines.length);
			const rows = log.lines.map((line, i) => `${i === at ? ">" : " "} ${line}`);
			return underHead([`Log: ${log.path}`], scrolled(rows, at, height - 1));
		}
		case "github": {
			const head = [githubHead(state, now)];
			const issues = githubRows(state);
			if (!issues.length) return plain([...head, "no issues imported (.shiftwork/shiftwork-github.json, written by run --dark-factory)"]);
			const at = clampCursor(cursor.github, issues.length);
			const rows = issues.map((issue, i) => `${i === at ? ">" : " "} ${githubIssueRow(issue)}`.trim());
			return underHead(head, scrolled(rows, at, height - 1));
		}
		default:
			return { lines: [], cursor: -1, redRows: [] };
	}
}

function clampCursor(cursor, length) {
	return Math.max(0, Math.min(cursor ?? 0, length - 1));
}

/**
 * The open details as a tab body (GitHub #3): their lines, plus the ticket search's
 * query when one is open — the paint layer turns its `[query]` brackets into reverse
 * video, and `renderDetails` has already scrolled to the current match.
 */
function detailsBody(state, height) {
	return { lines: renderDetails(state).slice(0, height), cursor: -1, redRows: [], rows: [], highlight: ticketSearch(state) };
}

/** The query of a ticket-scoped search (inside the open details), or null. */
function ticketSearch(state) {
	const search = state.search;
	if (!search || search.scope !== "ticket") return null;
	const query = String(search.query ?? "").trim();
	return query || null;
}

/** The window of `rows` that keeps row `at` (the cursor) visible, plus the cursor's index in that window. */
function scrolled(rows, at, max) {
	if (max <= 0) return { lines: [], cursor: -1, start: 0 };
	if (rows.length <= max) return { lines: rows, cursor: at, start: 0 };
	const start = Math.min(Math.max(0, at - max + 1), rows.length - max);
	return { lines: rows.slice(start, start + max), cursor: at - start, start };
}

// --- The plain frame: every tab's section, unbounded (--once, the fallback) ---

function renderPlain(state) {
	const now = state.now ?? new Date();
	const tab = TABS.includes(state.tab) ? state.tab : "queue";
	const lines = [headerLine(state, now, tab)];
	if (state.search) lines.push(searchLine(state));
	if (state.notice) lines.push(`» ${state.notice}`);
	lines.push("");
	if (state.details) lines.push(...renderDetails(state), "");
	lines.push(...renderQueueSection(state, now), "", ...renderAgentsSection(state, now), "");
	lines.push(...renderCooldowns(state.cooldowns ?? [], now), "", ...renderLog(state.log));
	lines.push("", ...renderGithubSection(state, now));
	if (state.dryRun) lines.push("", ...renderDryRun(state.dryRun, state.featureFilter ?? null));
	lines.push("", GLOBAL_KEYS);
	return lines;
}

/** The header line: version, time, the six tabs (the open one bracketed), `dark-factory` while such a runner is live, the feature filter. The search prompt, when one is open, gets its own line (GitHub #3, tui-polish/08). */
function headerLine(state, now, tab) {
	let line = `shiftwork tui ${VERSION} · ${stamp(now)} · ${headerTabs(tab).text}`;
	if (state.run?.live && state.run?.mode === "dark-factory") line = `${line} · dark-factory`;
	if (state.featureFilter) line = `${line} · filter: ${state.featureFilter}`;
	return line;
}

/** The search prompt on its own header line (tui-polish/08): the tab labels' line is long already, so the query and scope must not be clipped off it. */
function searchLine(state) {
	return `/ ${state.search.query ?? ""} · ${searchScopeLabel(state.search)}`;
}

/** The search prompt's scope as the header shows it. */
function searchScopeLabel(search) {
	if (search.scope === "feature") return search.feature ? `feature ${search.feature}` : "feature";
	return search.scope;
}

/** The header's tab labels joined for display: `1 Queue  2 Agents  …`, the open one bracketed. */
function headerTabs(tab) {
	const labels = TABS.map((t, i) => `${t === tab ? "[" : ""}${i + 1} ${TAB_LABELS[t]}${t === tab ? "]" : ""}`);
	const parts = [];
	const spans = [];
	let x = 0;
	labels.forEach((label, i) => {
		if (i) {
			parts.push("  ");
			x += 2;
		}
		spans.push({ tab: TABS[i], x0: x, x1: x + label.length });
		parts.push(label);
		x += label.length;
	});
	return { text: parts.join(""), spans };
}

/** Where each tab label sits on the header line (line 0): its span shifted past the version/time prefix. */
function tabSpans(now, tab) {
	const prefix = `shiftwork tui ${VERSION} · ${stamp(now)} · `.length;
	return headerTabs(tab).spans.map((span) => ({ tab: span.tab, x0: prefix + span.x0, x1: prefix + span.x1 }));
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
	// The plain frame lists every feature, resolved ones included, as it always has.
	lines.push(...renderQueueRows(state, -1, { resolved: null }));
	return lines;
}

/**
 * The queue's visible rows (tui-polish/07): `▾ feature 2/6 done · 2 next · 1 needs you` folders
 * (▸ collapsed; zero `next`/`needs you` parts omitted; `⏸` while the feature is paused,
 * feature-pause ticket 01), their tickets under — a fixed-width status
 * column (`ticketStatusColumn`'s words, padded to the widest one rendered) before the `NN title`,
 * so on a narrow terminal the column stays whole and the title is what gets clipped. A feature
 * row also carries its tickets' live workers, collapsed or not (GitHub #2's operator report):
 * `● 12 glm-5.3` for one, `● 2 agents (12 glm-5.3, 03 grok-4.7)` for several, a live claim without
 * a run-state worker (another runner) as `● 12 pid 4242`.
 */
function renderQueueRows(state, cursor, { resolved = "skip" } = {}) {
	const rows = queueRows(state, state, { resolved });
	const column = Math.max(0, ...rows.filter((r) => r.kind === "ticket").map((r) => r.label.length));
	return rows.map((row, i) => {
		const mark = i === cursor ? ">" : " ";
		if (row.kind === "feature") {
			const counts = [`${row.done}/${row.total} done`];
			if (row.next) counts.push(`${row.next} next`);
			if (row.needsYou) counts.push(`${row.needsYou} needs you`);
			const parts = [`${row.collapsed ? "▸" : "▾"} ${row.feature} ${counts.join(" · ")}`];
			if (row.paused) parts.push("⏸");
			if (row.workers?.length) parts.push(workerMarker(row.workers));
			return `${mark} ${parts.join(" · ")}`;
		}
		return `${mark}   ${row.label.padEnd(column)}  ${row.number} ${row.title ?? ""}`.trimEnd();
	});
}

/** A feature row's live workers: one worker's `● 12 glm-5.3`, several agents' summary list; a worker with no model (a claim of another runner, no run-state entry) keeps its pid. */
function workerMarker(workers) {
	const label = (w) => (w.model ? `${w.number} ${w.model}` : `${w.number} pid ${w.pid ?? "?"}`);
	return workers.length === 1 ? `● ${label(workers[0])}` : `● ${workers.length} agents (${workers.map(label).join(", ")})`;
}

/**
 * The details of the selected ticket: its fields — the first line carrying the status column's
 * words (tui-polish/07) and, for a needs-info ticket, the reason from its last shift report —
 * the dry-run route when known, the latest shift report.
 */
function renderDetails(state) {
	const key = state.details;
	const data = state.ticketDetails?.key === key ? state.ticketDetails : null;
	const ticket = data?.ticket ?? (state.tickets ?? []).find((t) => `${t.feature}/${t.number}` === key) ?? null;
	if (!ticket) return [`${key} · ticket not found`];
	const column = ticketStatusColumn(state, ticket);
	const lines = [[key, ticket.title, column.label].filter(Boolean).join(" · ")];
	if (ticket.status === NEEDS_INFO) lines.push(`Reason: ${data?.reason ?? "-"}`);
	lines.push(`Type: ${ticket.type ?? "-"}`);
	lines.push(`Model: ${ticket.model ?? "-"}`);
	lines.push(`Budget: ${ticket.budget ?? "-"}`);
	lines.push(`Verify: ${ticket.verify?.length ? ticket.verify.join(" · ") : "-"}`);
	lines.push(`Blocked by: ${ticket.blockedBy?.length ? ticket.blockedBy.join(", ") : "none"}`);
	const route = (state.dryRun?.lines ?? []).find((line) => line.startsWith(`${key}  `));
	if (route) lines.push(`Route: ${route}`);
	if (data) lines.push(`What to build: ${data.what ?? "-"}`);
	if (data?.shift?.length) lines.push("Last shift report:", ...data.shift.map((line) => `  ${line}`));
	return searchDetails(state, lines);
}

/**
 * A ticket-scoped search over the open details (GitHub #3): every match in the rendered
 * lines is bracketed (`[…query…]`, reverse video in colour), and the lines scroll so the
 * current match (`enter` advances it, wrapping) is at the top. No query — or one of the
 * other scopes — leaves the details as they are.
 */
function searchDetails(state, lines) {
	const query = ticketSearch(state);
	if (!query) return lines;
	const re = new RegExp(escapeRe(query), "gi");
	const marked = lines.map((line) => line.replace(re, (m) => `[${m}]`));
	const matchLines = lines.flatMap((line, i) => (line.match(re) ? [i] : []));
	if (!matchLines.length) return marked;
	const at = matchLines[(state.search.match ?? 0) % matchLines.length];
	return marked.slice(at);
}

/** A literal text as a RegExp body. */
function escapeRe(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// --- The GitHub tab: the imported issues and the time of the last sync ---

/** The GitHub tab's head line: how many issues are watched and when the last sync was. */
function githubHead(state, now) {
	const issues = githubRows(state);
	const count = issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "no issues";
	const synced = state.github?.syncedAt ?? null;
	const when = synced ? `last sync ${formatAge(now - new Date(synced))} ago` : "not synced yet";
	return `GitHub: ${count} · ${when}`;
}

/** The GitHub section of the plain frame: the head line, then one row per issue. */
function renderGithubSection(state, now) {
	const issues = githubRows(state);
	const lines = [githubHead(state, now)];
	if (!issues.length) return lines;
	return [...lines, ...issues.map((issue) => `  ${githubIssueRow(issue)}`)];
}

/** One GitHub issue row, shared by the tab body and the plain-frame section: `#N title · feature · state`. */
function githubIssueRow(issue) {
	return `#${issue.number} ${issue.title ?? ""} · ${issue.feature} · ${issue.state}`.trim();
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
