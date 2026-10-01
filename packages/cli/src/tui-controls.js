import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openRunState, RESOLVED } from "shiftwork-core";
import { collectDryRunLines } from "./dry-run.js";

/** The keys the TUI handles: r run · s stop (with handoff) · d dry-run · f feature filter · g dark-factory · / search · q quit. */
export const TUI_KEYS = ["r", "s", "d", "f", "g", "/", "q", "\x03"];

/** The six tabs, switched with `1`–`6` (and `tab`, which cycles): the phase-5 spec's four, Resolved (GitHub #2) and GitHub (github-watch). */
export const TABS = ["queue", "agents", "cooldowns", "log", "resolved", "github"];

const ARROWS = { A: "up", B: "down", C: "right", D: "left" };

/**
 * The rows the Queue tab shows and its cursor moves over (spec stories 1, 2, 4, 7):
 * one `feature` folder row, then its `ticket` rows — a collapsed feature hides its tickets.
 * A `featureFilter` narrows the list to that feature. A feature whose tickets are all
 * resolved leaves the Queue for the Resolved tab (GitHub #2): `resolved: "only"` lists
 * just those features (the Resolved tab's rows), `resolved: null` keeps them (the plain
 * frame of `--once`). A `global`- or `feature`-scoped search (GitHub #3) narrows the list
 * to tickets whose number or title contains the query, keeping their feature rows; a
 * `feature` scope only within the feature the prompt captured. Pure, and shared with rendering.
 */
export function queueRows(dashboard, view, { resolved = "skip" } = {}) {
	const filter = view?.featureFilter ?? null;
	const search = searchFilter(view);
	const collapsed = new Set(view?.collapsed ?? []);
	const tickets = (dashboard?.tickets ?? []).filter((t) => !filter || t.feature === filter);
	const frontier = new Set((dashboard?.frontier ?? []).map((t) => `${t.feature}/${t.number}`));
	const workerOf = new Map(
		(dashboard?.run?.workers ?? [])
			.filter((w) => w.ticket?.feature && w.ticket?.number)
			.map((w) => [`${w.ticket.feature}/${w.ticket.number}`, w]),
	);
	const rows = [];
	for (const feature of [...new Set(tickets.map((t) => t.feature))].sort()) {
		const own = tickets.filter((t) => t.feature === feature);
		const done = own.length > 0 && own.every((t) => t.status === RESOLVED);
		// The Queue and the Resolved tab split on it; null keeps both.
		if (resolved === "only" ? !done : resolved === "skip" && done) continue;
		if (search?.feature && feature !== search.feature) continue;
		const shown = search ? own.filter(search.matches) : own;
		if (search && !shown.length) continue; // a feature with no matching ticket leaves the list
		rows.push({
			kind: "feature",
			feature,
			collapsed: collapsed.has(feature),
			resolved: own.filter((t) => t.status === RESOLVED).length,
			ready: own.filter((t) => frontier.has(`${t.feature}/${t.number}`)).length,
			total: own.length,
		});
		if (collapsed.has(feature)) continue;
		for (const t of shown) {
			rows.push({
				kind: "ticket",
				feature: t.feature,
				number: t.number,
				title: t.title,
				status: t.status,
				blockedBy: t.blockedBy ?? [],
				frontier: frontier.has(`${t.feature}/${t.number}`),
				worker: workerOf.get(`${t.feature}/${t.number}`) ?? null,
			});
		}
	}
	return rows;
}

/**
 * The rows the Resolved tab shows (GitHub #2): the same shape as the Queue's, but only
 * the features whose tickets are all resolved. Honours `collapsed` and `featureFilter` too.
 */
export function resolvedRows(dashboard, view) {
	return queueRows(dashboard, view, { resolved: "only" });
}

/**
 * The rows the GitHub tab shows (github-watch, ticket 06): one per issue in
 * `.pi/shiftwork-github.json` — `{ number, title, feature, state }` (state from
 * the feature's tickets, derived by `readGithubIssues` in dashboard.js) — one
 * row per watched issue, sorted by issue number. Pure, and shared with rendering.
 */
export function githubRows(dashboard) {
	return [...(dashboard?.github?.issues ?? [])].sort((a, b) => Number(a.number) - Number(b.number));
}

/** The rows one tab's cursor moves over: the Queue's and the Resolved tab's folders and tickets, the live shifts, the cooldowns, the log lines, the GitHub issues. */
function tabRows(tab, dashboard, view) {
	switch (tab) {
		case "queue":
		case "resolved":
			return folderRows(tab, dashboard, view);
		case "agents":
			return dashboard?.run?.workers ?? [];
		case "cooldowns":
			return dashboard?.cooldowns ?? [];
		case "log":
			return dashboard?.log?.lines ?? [];
		case "github":
			return githubRows(dashboard);
		default:
			return [];
	}
}

/** The view state with every optional field filled in and each tab's cursor clamped to its rows. */
function normalize(state, dashboard) {
	const cursor = { queue: 0, agents: 0, cooldowns: 0, log: 0, resolved: 0, github: 0, ...state.cursor };
	for (const tab of TABS) {
		const rows = tabRows(tab, dashboard, state);
		cursor[tab] = rows.length ? Math.max(0, Math.min(cursor[tab] ?? 0, rows.length - 1)) : 0;
	}
	return {
		...state,
		tab: TABS.includes(state.tab) ? state.tab : "queue",
		cursor,
		collapsed: [...(state.collapsed ?? [])],
		details: state.details ?? null,
		selectedWorker: state.selectedWorker ?? null,
	};
}

/**
 * The pure key reducer: (state, key, dashboard) → { state, effects }.
 * State: { tab, cursor: { queue, agents, cooldowns, log, resolved, github }, collapsed, details, selectedWorker,
 * run, features, featureFilter, notice, dryRun, search }. It is never mutated; `dashboard` (the latest
 * frame, shape `collectDashboardState`) bounds the cursors and decides whether `n` may start.
 * While the search prompt is open for typing (`search.editing`, GitHub #3) its keys go to the
 * query: printable keys — `n`, `r`, `s`, `d`, `f`, `q` and digits included — are text, not commands.
 * Effects are data for the executor: { type: "start-runner" | "stop-runner" | "dry-run", feature,
 * ticket, darkFactory } or { type: "quit" }. A second `r` while a runner is live is refused with a notice
 * (spec story 28); `n` is refused the same way, and when the selected row is not a ready
 * frontier ticket. `g` toggles dark-factory: it starts `run --dark-factory` detached when no
 * runner is live (github-watch, ticket 06) and writes STOP when one is. An unrecognized key
 * leaves the state untouched.
 */
export function reduceKey(state, key, dashboard = {}) {
	const editing = editSearchKey(state, key, dashboard);
	if (editing) return editing;
	switch (key) {
		case "r": {
			if (state.run?.live) {
				return { state: { ...normalize(state, dashboard), notice: `a runner is already working (pid ${state.run.pid})` }, effects: [] };
			}
			return {
				state: { ...normalize(state, dashboard), notice: "starting the runner…" },
				effects: [{ type: "start-runner", feature: state.featureFilter ?? null }],
			};
		}
		case "s": {
			const notice = state.run?.live
				? `STOP file written · runner pid ${state.run.pid} hands off and stops`
				: "STOP file written (no live runner)";
			return { state: { ...normalize(state, dashboard), notice }, effects: [{ type: "stop-runner" }] };
		}
		case "d":
			return {
				state: { ...normalize(state, dashboard), notice: null, dryRun: { pending: true } },
				effects: [{ type: "dry-run", feature: state.featureFilter ?? null }],
			};
		case "f": {
			const order = [null, ...(state.features ?? [])];
			const next = order[(order.indexOf(state.featureFilter ?? null) + 1) % order.length];
			return {
				state: { ...normalize(state, dashboard), featureFilter: next, notice: next ? `filter: ${next}` : "filter: all features" },
				effects: [],
			};
		}
		case "g": {
			// The dark-factory toggle: start `run --dark-factory` detached when idle, STOP when live.
			if (state.run?.live) {
				return {
					state: { ...normalize(state, dashboard), notice: `STOP file written · runner pid ${state.run.pid} hands off and stops` },
					effects: [{ type: "stop-runner" }],
				};
			}
			return {
					state: { ...normalize(state, dashboard), notice: "starting dark-factory…" },
					effects: [{ type: "start-runner", feature: null, darkFactory: true }],
			};
		}
		case "q":
		case "\x03":
			return { state: normalize(state, dashboard), effects: [{ type: "quit" }] };
		case "1":
		case "2":
		case "3":
		case "4":
		case "5":
		case "6":
			return { state: { ...normalize(state, dashboard), tab: TABS[Number(key) - 1] }, effects: [] };
		case "tab": {
			const current = TABS.includes(state.tab) ? state.tab : "queue";
			return { state: { ...normalize(state, dashboard), tab: TABS[(TABS.indexOf(current) + 1) % TABS.length] }, effects: [] };
		}
		case "up":
		case "k":
			return moveCursor(state, dashboard, -1);
		case "down":
		case "j":
			return moveCursor(state, dashboard, 1);
		case "left":
			return collapse(state, dashboard, true);
		case "right":
			return collapse(state, dashboard, false);
		case "/":
			return openSearch(state, dashboard);
		case "enter": {
			// While a kept ticket-scoped search is open, enter scrolls to its next match.
			if (keptTicketSearch(state)) {
				const norm = normalize(state, dashboard);
				return { state: { ...norm, search: { ...norm.search, match: (norm.search.match ?? 0) + 1 } }, effects: [] };
			}
			return enterKey(state, dashboard);
		}
		case "esc": {
			// esc leaves a kept search first, then closes the details.
			const norm = normalize(state, dashboard);
			if (norm.search) return { state: { ...norm, search: null }, effects: [] };
			if (!norm.details) return { state: norm, effects: [] };
			return { state: { ...norm, details: null }, effects: [] };
		}
		case "backspace": {
			const norm = normalize(state, dashboard);
			if (!norm.details) return { state: norm, effects: [] };
			return { state: { ...norm, details: null }, effects: [] };
		}
		case "n":
			return startSelected(state, dashboard);
		default:
			return { state, effects: [] };
	}
}

/**
 * The pure mouse-action reducer (GitHub #5): (state, action, dashboard) → { state, effects },
 * the same shape as `reduceKey`. Actions, as built by `mouseAction` from a TuiMouseEvent and
 * the layout's hit map: `{ type: "click", tab }` switches tabs; `{ type: "click", row }` moves
 * the current tab's cursor to that row of its rows, and a click on the row already under the
 * cursor acts as `enter`; `{ type: "wheel", delta }` moves the cursor by `delta` rows (negative
 * scrolls up), clamped. An action the view can't take — a row off the list, an unknown tab —
 * leaves the state untouched. Pure: no I/O, testable without a terminal.
 */
export function reduceMouse(state, action, dashboard = {}) {
	switch (action?.type) {
		case "click": {
			if (TABS.includes(action.tab) && action.tab !== state.tab) {
				return { state: { ...normalize(state, dashboard), tab: action.tab }, effects: [] };
			}
			if (Number.isInteger(action.row)) {
				const norm = normalize(state, dashboard);
				const rows = tabRows(norm.tab, dashboard, norm);
				if (action.row < 0 || action.row >= rows.length) return { state: norm, effects: [] };
				if (norm.cursor[norm.tab] === action.row) return enterKey(norm, dashboard); // a second click opens it, like enter
				return { state: { ...norm, cursor: { ...norm.cursor, [norm.tab]: action.row } }, effects: [] };
			}
			return { state, effects: [] };
		}
		case "wheel": {
			const norm = normalize(state, dashboard);
			const rows = tabRows(norm.tab, dashboard, norm);
			if (!rows.length) return { state: norm, effects: [] };
			const delta = Number(action.delta) || 0;
			const next = Math.max(0, Math.min(norm.cursor[norm.tab] + delta, rows.length - 1));
			return { state: { ...norm, cursor: { ...norm.cursor, [norm.tab]: next } }, effects: [] };
		}
		default:
			return { state, effects: [] };
	}
}

/**
 * Map one normalized TuiMouseEvent (pi-tui's shape: type click/wheel, zero-based `x`/`y`,
 * `wheelDelta`) to a reducer mouse action, through the layout's hit map (`dashboardLayout`'s
 * `rows` and `tabs`): a click on line 0 within a tab label's span switches tabs, a click on
 * a list row's line moves the cursor there, the wheel moves it. null when the event hits
 * nothing the view reacts to — another event type, a click off every label and row, or no
 * layout yet.
 */
export function mouseAction(event, layout) {
	if (!event || !layout) return null;
	if (event.type === "wheel") {
		const delta = Number(event.wheelDelta) || 0;
		return delta ? { type: "wheel", delta } : null;
	}
	if (event.type !== "click") return null;
	if (event.y === 0) {
		const span = (layout.tabs ?? []).find((t) => event.x >= t.x0 && event.x < t.x1);
		return span ? { type: "click", tab: span.tab } : null;
	}
	const row = (layout.rows ?? []).find((r) => r.y === event.y);
	return row ? { type: "click", row: row.index } : null;
}

/** Move the current tab's cursor one row, clamped at both ends of its rows. */
function moveCursor(state, dashboard, step) {
	const norm = normalize(state, dashboard);
	const rows = tabRows(norm.tab, dashboard, norm);
	if (!rows.length) return { state: norm, effects: [] };
	const next = Math.max(0, Math.min(norm.cursor[norm.tab] + step, rows.length - 1));
	return { state: { ...norm, cursor: { ...norm.cursor, [norm.tab]: next } }, effects: [] };
}

/** The rows of the tab whose rows are feature folders with tickets: the Queue's and the Resolved tab's. */
function folderRows(tab, dashboard, view) {
	return tab === "resolved" ? resolvedRows(dashboard, view) : queueRows(dashboard, view);
}

/** Collapse (or expand) the feature under the Queue or Resolved cursor; the other tabs have no folders. */
function collapse(state, dashboard, fold) {
	const norm = normalize(state, dashboard);
	if (norm.tab !== "queue" && norm.tab !== "resolved") return { state: norm, effects: [] };
	const row = folderRows(norm.tab, dashboard, norm)[norm.cursor[norm.tab]];
	if (!row) return { state: norm, effects: [] };
	const collapsed = new Set(norm.collapsed);
	if (fold) collapsed.add(row.feature);
	else collapsed.delete(row.feature);
	return { state: normalize({ ...norm, collapsed: [...collapsed] }, dashboard), effects: [] };
}

/** Enter: open the selected ticket's details (Queue, Resolved), select a worker's log (Agents), or jump to the issue's feature (GitHub). */
function enterKey(state, dashboard) {
	const norm = normalize(state, dashboard);
	if (norm.tab === "queue" || norm.tab === "resolved") {
		const row = folderRows(norm.tab, dashboard, norm)[norm.cursor[norm.tab]];
		if (row?.kind !== "ticket") return { state: norm, effects: [] };
		return { state: { ...norm, details: `${row.feature}/${row.number}` }, effects: [] };
	}
	if (norm.tab === "agents") {
		const worker = (dashboard?.run?.workers ?? [])[norm.cursor.agents];
		if (!worker) return { state: norm, effects: [] };
		const selectedWorker = worker.ticket?.feature && worker.ticket?.number ? `${worker.ticket.feature}/${worker.ticket.number}` : null;
		return { state: { ...norm, tab: "log", selectedWorker }, effects: [] };
	}
	if (norm.tab === "github") {
		const row = githubRows(dashboard)[norm.cursor.github];
		if (!row?.feature) return { state: norm, effects: [] };
		// Open the issue's feature in the Queue tab, the cursor on its folder row — clearing a
		// feature filter that would hide it. A fully resolved feature lives on the Resolved tab.
		const findFolder = (rows) => rows.findIndex((r) => r.kind === "feature" && r.feature === row.feature);
		let view = norm;
		let tab = "queue";
		let at = findFolder(queueRows(dashboard, view));
		if (at < 0 && norm.featureFilter) {
			view = { ...norm, featureFilter: null };
			at = findFolder(queueRows(dashboard, view));
		}
		if (at < 0) {
			tab = "resolved";
			at = findFolder(resolvedRows(dashboard, view));
		}
		return { state: { ...view, tab, cursor: { ...view.cursor, [tab]: at < 0 ? view.cursor[tab] : at } }, effects: [] };
	}
	return { state: norm, effects: [] };
}

/**
 * The active list search (GitHub #3): while a `global`- or `feature`-scoped query is set,
 * the list keeps only tickets whose number or title contains it (case-insensitive); a
 * `feature` scope only within the feature the prompt captured. A `ticket` scope (searching
 * inside open details) and an empty query do not filter the list. null otherwise.
 */
function searchFilter(view) {
	const search = view?.search ?? null;
	if (!search || (search.scope !== "global" && search.scope !== "feature")) return null;
	const query = String(search.query ?? "").trim().toLowerCase();
	if (!query) return null;
	return {
		matches: (t) => `${t.number} ${t.title ?? ""}`.toLowerCase().includes(query),
		feature: search.scope === "feature" ? search.feature ?? null : null,
	};
}

/**
 * `/` opens the search prompt (GitHub #3): inside open details with scope `ticket`; on
 * the Queue or Resolved tab with scope `global`, capturing the feature under the cursor
 * for the `feature` scope `tab` toggles to; anywhere else it does nothing. A query already
 * kept reopens with itself.
 */
function openSearch(state, dashboard) {
	const norm = normalize(state, dashboard);
	const scope = norm.details
		? "ticket"
		: norm.tab === "queue" || norm.tab === "resolved"
				? norm.search && (norm.search.scope === "global" || norm.search.scope === "feature") ? norm.search.scope : "global"
				: null;
	if (!scope) return { state, effects: [] };
	return {
		state: {
			...norm,
			search: {
				query: norm.search?.query ?? "",
				scope,
				feature: featureUnderCursor(norm, dashboard),
				editing: true,
				match: norm.search?.match ?? 0,
			},
		},
		effects: [],
	};
}

/** The feature of the row under the Queue or Resolved cursor (the folder's or the ticket's), captured when the search prompt opens. */
function featureUnderCursor(state, dashboard) {
	if (state.tab !== "queue" && state.tab !== "resolved") return null;
	const row = folderRows(state.tab, dashboard, state)[state.cursor[state.tab]];
	return row?.feature ?? null;
}

/** A kept (not editing) ticket-scoped search with a query: `enter` scrolls to its next match. */
function keptTicketSearch(state) {
	const search = state.search;
	return Boolean(search && !search.editing && search.scope === "ticket" && String(search.query ?? "").trim());
}

/**
 * The search prompt's keys while it is open for typing (`search.editing`, GitHub #3):
 * printable keys append to the query — `n`, `r`, `s`, `d`, `f`, `q` and digits are text,
 * not commands — `backspace` deletes the last character, `tab` toggles the scope between
 * `global` and `feature` (the feature captured when the prompt opened), `enter` stops
 * editing and keeps the filter, `esc` clears the query and closes the prompt. Anything
 * else — arrows, Ctrl-C — falls through to the usual keys. null when the prompt is closed
 * or the key is not the prompt's.
 */
function editSearchKey(state, key, dashboard) {
	const search = state.search;
	if (!search?.editing) return null;
	if ([...key].length === 1) {
		const code = key.codePointAt(0);
		if (code >= 0x20 && code !== 0x7f) {
			return { state: normalize({ ...state, search: { ...search, query: (search.query ?? "") + key } }, dashboard), effects: [] };
		}
	}
	switch (key) {
		case "backspace":
			return { state: normalize({ ...state, search: { ...search, query: (search.query ?? "").slice(0, -1) } }, dashboard), effects: [] };
		case "tab": {
			if (search.scope === "ticket") return null; // the details search has one scope
			return { state: normalize({ ...state, search: { ...search, scope: search.scope === "feature" ? "global" : "feature" } }, dashboard), effects: [] };
		}
		case "enter":
			return { state: normalize({ ...state, search: { ...search, editing: false } }, dashboard), effects: [] };
		case "esc":
			return { state: normalize({ ...state, search: null }, dashboard), effects: [] };
		default:
			return null;
	}
}

/**
 * `n`: start the selected Queue ticket, refused with a notice unless it is a ready frontier
 * ticket and no runner is live. On the Resolved tab every ticket is resolved, so the notice
 * says it is not on the frontier: status resolved.
 */
function startSelected(state, dashboard) {
	const norm = normalize(state, dashboard);
	const run = state.run ?? dashboard?.run;
	if (run?.live) {
		return { state: { ...norm, notice: `a runner is already working (pid ${run.pid})` }, effects: [] };
	}
	const rows = folderRows(norm.tab, dashboard, norm);
	const row = rows[norm.tab === "queue" || norm.tab === "resolved" ? norm.cursor[norm.tab] : norm.cursor.queue];
	if (row?.kind !== "ticket") {
		const where = row ? `the feature ${row.feature}` : "an empty queue";
		return { state: { ...norm, notice: `no ticket selected: the cursor is on ${where}` }, effects: [] };
	}
	const spec = `${row.feature}/${row.number}`;
	const onFrontier = (dashboard?.frontier ?? []).some((t) => t.feature === row.feature && t.number === row.number);
	if (!onFrontier) {
		return { state: { ...norm, notice: `${spec} is not on the frontier: ${refusalReason(dashboard, row)}` }, effects: [] };
	}
	return {
		state: { ...norm, notice: `starting ${spec}…` },
		effects: [{ type: "start-runner", feature: null, ticket: spec }],
	};
}

/** Why a ticket is not on the frontier, in `run --ticket`'s words: claimed, blocked, or its status. */
function refusalReason(dashboard, row) {
	const claim = (dashboard?.claims ?? []).find((c) => c.ticket?.feature === row.feature && c.ticket?.number === row.number);
	if (claim) return `claimed by pid ${claim.pid}`;
	const tickets = dashboard?.tickets ?? [];
	const blockers = (row.blockedBy ?? []).filter((n) => tickets.find((t) => t.feature === row.feature && t.number === n)?.status !== RESOLVED);
	if (blockers.length) return `blocked by ${blockers.join(", ")}`;
	return `status ${row.status}`;
}

/**
 * Decode raw terminal input into key names: the arrow escape sequences, `enter`, `esc`, `tab`,
 * `backspace`, Ctrl-C (as `"\x03"`, like today) and printable characters — several keys may
 * arrive in one chunk. Kitty keyboard-protocol CSI-u sequences (`ESC[<code>[;<mods>[:<event>]]u`,
 * which the terminal sends because pi-tui enables the protocol) decode to the same names:
 * `ESC[27u` is `esc`, `ESC[99;5u` is Ctrl-C; release events (`:3`) are dropped, repeats keep
 * the key. Unknown escape sequences are consumed, not decoded into garbage.
 */
export function decodeKeys(data) {
	const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
	const keys = [];
	for (let i = 0; i < text.length; ) {
		const ch = text[i];
		if (ch === "\x1b") {
			const seq = text[i + 1];
			if ((seq === "[" || seq === "O") && ARROWS[text[i + 2]]) {
				keys.push(ARROWS[text[i + 2]]);
				i += 3;
				continue;
			}
			if (seq === "[") {
				// Another CSI sequence (page keys, F keys, kitty CSI-u…): consume it through
				// its final byte; a CSI-u one decodes to its key.
				const rest = text.slice(i + 2);
				const end = rest.search(/[A-Za-z~]/);
				if (end < 0) {
					i = text.length;
					continue;
				}
				if (rest[end] === "u") {
					const key = decodeCsiU(rest.slice(0, end));
					if (key !== null) keys.push(key);
				}
				i += end + 3;
				continue;
			}
			keys.push("esc");
			i += 1;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			keys.push("enter");
			i += 1;
			continue;
		}
		if (ch === "\t") {
			keys.push("tab");
			i += 1;
			continue;
		}
		if (ch === "\x7f" || ch === "\x08") {
			keys.push("backspace");
			i += 1;
			continue;
		}
		if (ch === "\x03") {
			keys.push("\x03");
			i += 1;
			continue;
		}
		const code = text.codePointAt(i);
		if (code >= 0x20 && code !== 0x7f) {
			keys.push(String.fromCodePoint(code));
			i += code > 0xffff ? 2 : 1;
			continue;
		}
		i += 1; // any other control byte is not a key
	}
	return keys;
}

/** The kitty CSI-u codes with a key name the reducer understands: Esc, enter, tab, backspace. */
const CSI_U_KEYS = { 27: "esc", 13: "enter", 9: "tab", 127: "backspace" };

/**
 * Decode one kitty CSI-u sequence's parameters (`<code>[;<mods>[:<event>]]`): the named keys
 * map to their key names, `c` with Ctrl (mods 5) to `"\x03"`, other printables without Ctrl/Alt
 * to their character, release events (`:3`) to null (dropped). Any other combination — a
 * Ctrl/Alt-modified printable, a control code — is consumed (null) rather than a garbage key.
 */
function decodeCsiU(params) {
	const [keyPart = "", modPart = ""] = params.split(";");
	const code = Number(keyPart.split(":")[0]) || 0;
	const mods = Number(modPart.split(":")[0]) || 1; // the bitmask + 1
	const event = modPart.split(":")[1] ?? "1"; // 1 press, 2 repeat, 3 release
	if (event === "3") return null; // key released: not a key press
	const ctrl = (mods - 1) & 4;
	const alt = (mods - 1) & 2;
	if (code === 99 && ctrl) return "\x03"; // Ctrl-C keeps today's key name
	if (code in CSI_U_KEYS) return CSI_U_KEYS[code];
	if (!ctrl && !alt && code >= 0x20 && code !== 0x7f) return String.fromCodePoint(code);
	return null;
}

/**
 * Key handling for the interactive TUI: the latest dashboard state goes in through
 * `setDashboard`, keys through `handleKey` (decoded names go straight through), and `view`
 * (the tabbed view state: tab, cursors, collapsed features, details, selectedWorker,
 * featureFilter, notice, dryRun, search) is merged over the dashboard state for rendering.
 * `onChange` fires after every change.
 * Effects are injectable so tests can drive them with a stub runner.
 */
export function createTuiControls({ root, start, stop, plan, onChange, onQuit } = {}) {
	const effects = {
		"start-runner": start ??
			((root_, effect) => startDetachedRunner(root_, { feature: effect.feature, ticket: effect.ticket, darkFactory: effect.darkFactory })),
		"stop-runner": stop ?? writeStopFile,
		"dry-run": plan ?? ((root_, effect) => collectDryRunLines(root_, { feature: effect.feature })),
	};
	let dashboard = { run: null, tickets: [] };
	let view = {
		tab: "queue",
		cursor: { queue: 0, agents: 0, cooldowns: 0, log: 0, resolved: 0, github: 0 },
		collapsed: [],
		details: null,
		selectedWorker: null,
		featureFilter: null,
		notice: null,
		dryRun: null,
		search: null,
	};
	let quit = onQuit ?? (() => {});

	const emit = () => onChange?.(view);
	const setView = (next) => {
		view = next;
		emit();
	};

	async function execute(effect) {
		try {
			switch (effect.type) {
				case "start-runner": {
					const res = await effects["start-runner"](root, effect);
					setView({
						...view,
						notice: res.started ? `runner started (pid ${res.pid}) · logs: ${relative(root, res.logFile)}` : res.reason,
					});
					break;
				}
				case "stop-runner":
					await effects["stop-runner"](root, effect);
					break; // the reducer already set the notice
				case "dry-run": {
					const lines = await effects["dry-run"](root, effect);
					setView({ ...view, dryRun: { lines } });
					break;
				}
				case "quit":
					quit();
					break;
			}
		} catch (error) {
			setView({ ...view, dryRun: effect.type === "dry-run" ? null : view.dryRun, notice: `${effect.type} failed: ${error.message}` });
		}
	}

	/** Merge a reducer's next state over the view; every action goes through this. */
	const apply = (state) => {
		setView({
			tab: state.tab ?? view.tab,
			cursor: state.cursor ?? view.cursor,
			collapsed: state.collapsed ?? view.collapsed,
			details: state.details ?? null,
			selectedWorker: state.selectedWorker ?? null,
			featureFilter: state.featureFilter ?? null,
			notice: state.notice ?? null,
			dryRun: state.dryRun ?? null,
			search: state.search ?? null,
		});
	};

	return {
		get view() {
			return view;
		},
		setDashboard(state) {
			dashboard = state ?? { run: null, tickets: [] };
		},
		onQuit(fn) {
			quit = fn;
		},
		/** Feed one key through the reducer and run its effects. Returns the effects it ran. */
		async handleKey(key) {
			const features = [...new Set((dashboard.tickets ?? []).map((t) => t.feature))].sort();
			const { state, effects: list } = reduceKey({ ...view, run: dashboard.run, features }, key, dashboard);
			apply(state);
			for (const effect of list) await execute(effect);
			return list;
		},
		/** Feed one mouse action (`mouseAction`'s shape) through the reducer and run its effects. */
		async handleMouse(action) {
			const features = [...new Set((dashboard.tickets ?? []).map((t) => t.feature))].sort();
			const { state, effects: list } = reduceMouse({ ...view, run: dashboard.run, features }, action, dashboard);
			apply(state);
			for (const effect of list) await execute(effect);
			return list;
		},
	};
}

/**
 * Start `shiftwork run` detached, like `/shift run`: output goes to logs/runner-<ts>.log,
 * a stale STOP file is removed first, and the run state is claimed at once so the
 * dashboard is live before the runner's own first write. Refused while a runner is live.
 * `darkFactory: true` starts `run --dark-factory` instead, and the run state entry
 * records `mode: "dark-factory"` — the header shows it while the runner is live.
 */
export async function startDetachedRunner(root, { feature, ticket, darkFactory, bin } = {}) {
	const runState = openRunState(root);
	const current = await runState.read();
	if (current?.live) {
		return { started: false, reason: `a runner is already working (pid ${current.pid})` };
	}
	const cli = bin ?? process.env.SHIFTWORK_BIN ?? fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));

	// A STOP file left by an earlier stop would end the new run immediately.
	const stopFile = join(root, "STOP");
	const removedStop = existsSync(stopFile);
	if (removedStop) await rm(stopFile, { force: true });

	await mkdir(join(root, "logs"), { recursive: true });
	const logFile = join(root, "logs", `runner-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
	const log = openSync(logFile, "a");
	const args = [
		cli,
		"run",
		...(darkFactory ? ["--dark-factory"] : []),
		...(feature ? ["--feature", feature] : []),
		...(ticket ? ["--ticket", ticket] : []),
	];
	const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ["ignore", log, log] });
	child.unref();
	await runState.update({
		pid: child.pid,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		stoppedReason: null,
		mode: darkFactory ? "dark-factory" : null,
		workers: [],
		summary: { resolved: 0, needsInfo: 0 },
		logFile,
	});
	return { started: true, pid: child.pid, logFile, removedStop };
}

/** Write the STOP file: the runner hands off (ticket 02), releases the ticket and exits. */
export async function writeStopFile(root) {
	await writeFile(join(root, "STOP"), `Stopped from shiftwork tui at ${new Date().toISOString()}\n`);
}
