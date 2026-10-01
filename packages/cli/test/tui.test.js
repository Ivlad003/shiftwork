import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openRunState } from "shiftwork-core";
import { collectDashboardState, dashboardLayout, formatLogLine, renderDashboard, tailShiftLog } from "../src/dashboard.js";
import { queueRows } from "../src/tui-controls.js";
import { interactive, loadPiTui } from "../src/tui.js";

const parallelRunState = fileURLToPath(new URL("./fixtures/parallel-run-state.json", import.meta.url));

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = async (args, env = {}) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env } });
};

const now = new Date("2026-10-01T12:00:00Z");

/** SGR escape sequences stripped: what a line takes up in visible columns. */
const stripSgr = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

const ticket = (feature, number, title, status = "ready-for-agent") => ({
	feature,
	number,
	title,
	status,
	blockedBy: [],
	path: `/x/.scratch/${feature}/issues/${number}-slug.md`,
});

const base = { now, tickets: [], frontier: [], claims: [], run: null, cooldowns: [], log: null };

test("dashboard: idle runner, one ready ticket", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("f", "01", "First")],
		frontier: [ticket("f", "01", "First")],
	}).join("\n");

	assert.match(frame, /Runner: idle \(no run state\)/);
	assert.match(frame, /Frontier: f\/01 \(1 ready of 1\)/);
	assert.match(frame, /▾ f 0\/1 done · 1 next/);
	assert.match(frame, /● next #1  01 First/);
	assert.match(frame, /Cooldowns: none/);
	assert.match(frame, /Log: no current shift log/);
});

test("dashboard: running shift shows ticket, shift, model, budget use and context fill", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("orch", "11", "TUI dashboard", "claimed")],
		run: {
			pid: 1,
			running: true,
			live: true,
			startedAt: "2026-10-01T11:56:00Z",
			workers: [
				{
					ticket: { feature: "orch", number: "11", title: "TUI dashboard", path: "/x/11.md" },
					attempt: 2,
					shift: 3,
					model: "xai/grok-4.6",
					thinking: "high",
					budget: { maxCostUsd: 2, maxTokens: 200000 },
					usage: { tokens: 12345, costUsd: 0.25, turns: 5, contextPct: 38 },
				},
			],
			summary: { resolved: 0, needsInfo: 0 },
		},
		log: { path: join("logs", "orch", "11", "attempt-2.jsonl"), lines: ["11:59:58 turn · 12345 tokens"] },
	}).join("\n");

	assert.match(frame, /Runner: working orch\/11 · TUI dashboard \(pid 1\) · started 4m ago/);
	assert.match(frame, /orch\/11 TUI dashboard · xai\/grok-4\.6 · shift 3 · attempt 2/);
	assert.match(frame, /12345 tokens · \$0\.25 · 5 turns · ctx 38%/);
	assert.match(frame, /\$2 · 200000 tok/);
	assert.match(frame, /4m elapsed/);
	assert.match(frame, /Log: logs\/orch\/11\/attempt-2\.jsonl\n {2}11:59:58 turn · 12345 tokens/);
});

test("dashboard: a parallel: 2 run state lists every worker (fixture from a real run)", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-par-"));
	const fixture = JSON.parse(await readFile(parallelRunState, "utf8"));
	// The fixture was captured from a live parallel: 2 run; its runner pid is long
	// gone, so this process stands in to keep the run live for the reader.
	for (const runner of fixture.runners) runner.pid = process.pid;
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "shiftwork-run.json"), JSON.stringify(fixture));

	const run = await openRunState(root).read();
	const frame = renderDashboard({ ...base, run }).join("\n");

	assert.match(frame, /Runner: running \(pid \d+\) · 2 workers · started [0-9a-z ]+ ago/);
	assert.match(frame, /parallel\/01 First · fake\/m1 · shift 1 · attempt 1/);
	assert.match(frame, /parallel\/02 Second · fake\/m1 · shift 1 · attempt 1/);
	assert.match(frame, /120 tokens · \$0\.01 · 1 turns/);
});

test("dashboard: waiting on cooldowns shows the time left", () => {
	const frame = renderDashboard({
		...base,
		run: { pid: 1, running: true, live: true, startedAt: "2026-10-01T11:00:00Z", ticket: null, summary: { resolved: 1, needsInfo: 0 } },
		cooldowns: [{ provider: "xai", kind: "rate", until: "2026-10-01T12:05:00Z" }],
	}).join("\n");

	assert.match(frame, /Runner: waiting on cooldowns \(xai 5m left\)/);
	assert.match(frame, /Cooldowns:\n {2}xai \(rate\) {2}5m left/);
});

test("dashboard: a finished run shows why it ended", () => {
	const frame = renderDashboard({
		...base,
		run: {
			running: false,
			live: false,
			stoppedReason: "STOP file",
			summary: { resolved: 3, needsInfo: 1 },
			finishedAt: "2026-10-01T10:00:00Z",
		},
	}).join("\n");

	assert.match(frame, /Runner: not running · stopped: STOP file · resolved 3 · needs-info 1 · finished 2h ago/);
});

test("dashboard: an empty state renders without crashing", () => {
	const frame = renderDashboard({ now }).join("\n");
	assert.match(frame, /Runner: idle/);
	assert.match(frame, /Tickets: none/);
	assert.match(frame, /Cooldowns: none/);
	assert.match(frame, /Log: no current shift log/);
});

test("dashboard: the header lists the control keys", () => {
	const frame = renderDashboard({ now }).join("\n");
	assert.match(frame, /r run · s stop · d dry-run · f filter · g dark-factory · q quits/);
});

test("dashboard: a feature filter scopes the frontier and the ticket tables", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("a", "01", "One"), ticket("b", "01", "Two")],
		frontier: [ticket("a", "01", "One"), ticket("b", "01", "Two")],
		featureFilter: "b",
	}).join("\n");

	assert.match(frame, /filter: b/);
	assert.match(frame, /Frontier: b\/01 \(1 ready of 1\)/);
	assert.match(frame, /▾ b 0\/1 done · 1 next/);
	assert.match(frame, /● next #2  01 Two/); // its place in the frontier order, not the ticket list
	assert.doesNotMatch(frame, /01 One/);
	assert.doesNotMatch(frame, /▾ a /);
});

test("dashboard: a notice and the dry-run panel render", () => {
	const frame = renderDashboard({
		...base,
		notice: "runner started (pid 4242)",
		dryRun: { lines: ["f/01  type=git  tier=quick  model=fake/m1"] },
	}).join("\n");

	assert.match(frame, /» runner started \(pid 4242\)/);
	assert.match(frame, /Dry-run:\n {2}f\/01 {2}type=git/);

	const pending = renderDashboard({ ...base, featureFilter: "f", dryRun: { pending: true } }).join("\n");
	assert.match(pending, /Dry-run \(feature f\): planning…/);
});

test("dashboard: a ticket a worker holds shows the model ref, prefix included", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("f", "01", "Held", "claimed")],
		run: {
			pid: 1,
			live: true,
			workers: [{ ticket: { feature: "f", number: "01", title: "Held" }, model: "claude:sonnet", attempt: 1, shift: 1 }],
		},
	}).join("\n");

	assert.match(frame, /▶ working claude:sonnet  01 Held/);
});

test("dashboard: collapsed features use ▸ and hide their tickets", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("parallel", "01", "First"), ticket("parallel", "02", "Second")],
		frontier: [ticket("parallel", "01", "First")],
		collapsed: ["parallel"],
	}).join("\n");

	assert.match(frame, /▸ parallel 0\/2 done · 1 next/);
	assert.doesNotMatch(frame, /01 First/);
	assert.doesNotMatch(frame, /▾ parallel/);
});

test("dashboard: a feature row carries its live workers, collapsed or not; none shows no marker", () => {
	const one = renderDashboard({
		...base,
		tickets: [ticket("tui-polish", "12", "Held", "claimed"), ticket("empty", "01", "Nothing")],
		frontier: [ticket("empty", "01", "Nothing")],
		collapsed: ["tui-polish"],
		run: { pid: 7, live: true, workers: [{ ticket: { feature: "tui-polish", number: "12" }, model: "glm-5.3", attempt: 1, shift: 1 }] },
	}).join("\n");

	assert.match(one, /▸ tui-polish 0\/1 done · ● 12 glm-5\.3/); // the marker shows on the collapsed feature row too, the zero next part is omitted
	assert.match(one, /▾ empty 0\/1 done · 1 next(?! · ●)/); // a feature with no workers shows no marker

	const two = renderDashboard({
		...base,
		tickets: [ticket("tui-polish", "12", "Held", "claimed"), ticket("tui-polish", "03", "Elsewhere", "claimed")],
		frontier: [],
		run: {
			pid: 7,
			live: true,
			workers: [
				{ ticket: { feature: "tui-polish", number: "12" }, model: "glm-5.3", attempt: 1, shift: 1 },
				{ ticket: { feature: "tui-polish", number: "03" }, model: "grok-4.7", attempt: 1, shift: 1 },
			],
		},
	}).join("\n");

	assert.match(two, /▾ tui-polish 0\/2 done · ● 2 agents \(12 glm-5\.3, 03 grok-4\.7\)/);

	// A live claim with no run-state worker (another runner) keeps its pid in place of a model.
	const claimed = renderDashboard({
		...base,
		tickets: [ticket("tui-polish", "12", "Held", "claimed")],
		frontier: [],
		claims: [{ ticket: { feature: "tui-polish", number: "12" }, pid: 4242, at: "2026-10-01T11:59:00Z" }],
	}).join("\n");
	assert.match(claimed, /▾ tui-polish 0\/1 done · ● 12 pid 4242/);

	// The marker is coloured like the ticket row's: cyan when colour is on.
	const colored = renderDashboard(
		{
			...base,
			tickets: [ticket("tui-polish", "12", "Held", "claimed")],
			frontier: [],
			collapsed: ["tui-polish"],
			run: { pid: 7, live: true, workers: [{ ticket: { feature: "tui-polish", number: "12" }, model: "glm-5.3", attempt: 1, shift: 1 }] },
		},
		{ width: 60, height: 24, color: true },
	).join("\n");
	assert.match(colored, /\x1b\[36m● 12 glm-5\.3/);
});

test("dashboard: details render the ticket's fields, route and latest shift report", () => {
	const held = {
		...ticket("f", "03", "Tabbed rendering", "ready-for-agent"),
		type: "code",
		model: "anthropic/claude-sonnet",
		budget: "$2 · 50 turns",
		verify: ["npm test", "node packages/cli/bin/shiftwork.js tui --once"],
		blockedBy: ["02"],
	};
	const withShift = renderDashboard({
		...base,
		tickets: [held],
		details: "f/03",
		dryRun: { lines: ["f/03  type=code  tier=standard  model=anthropic/claude-sonnet"] },
		ticketDetails: {
			key: "f/03",
			ticket: held,
			what: "render the tab of the spec",
			shift: ["### Shift 1 — pi opencode-go/glm-5.3 (medium)", "- Outcome: new attempt"],
		},
	}).join("\n");

	assert.match(withShift, /f\/03 · Tabbed rendering · ⧗ waits 02/);
	assert.match(withShift, /Type: code/);
	assert.match(withShift, /Model: anthropic\/claude-sonnet/);
	assert.match(withShift, /Budget: \$2 · 50 turns/);
	assert.match(withShift, /Verify: npm test · node packages\/cli\/bin\/shiftwork\.js tui --once/);
	assert.match(withShift, /Blocked by: 02/);
	assert.match(withShift, /Route: f\/03 {2}type=code/);
	assert.match(withShift, /What to build: render the tab of the spec/);
	assert.match(withShift, /Last shift report:\n {2}### Shift 1 — pi opencode-go\/glm-5\.3 \(medium\)/);

	const bare = {
		...ticket("f", "01", "No comments"),
		type: "docs",
	};
	const without = renderDashboard({
		...base,
		tickets: [bare],
		details: "f/01",
		ticketDetails: { key: "f/01", ticket: bare, what: "a short task", shift: [] },
	}).join("\n");

	assert.match(without, /Type: docs/);
	assert.match(without, /Model: -/);
	assert.match(without, /What to build: a short task/);
	assert.doesNotMatch(without, /Last shift report/);
	assert.doesNotMatch(without, /### Shift/);
});

test("dashboard: feature rows count done, next and needs you, omitting the zero parts", () => {
	const tickets = [
		ticket("f", "01", "One", "resolved"),
		ticket("f", "02", "Two", "resolved"),
		ticket("f", "03", "Ask", "needs-info"),
		ticket("g", "01", "Next up"),
		ticket("shipped", "01", "Old", "resolved"),
		ticket("shipped", "02", "Older", "resolved"),
	];
	const state = { ...base, tickets, frontier: [tickets[3]] };
	const frame = renderDashboard(state).join("\n");

	assert.match(frame, /▾ f 2\/3 done · 1 needs you/); // the zero next part is omitted
	assert.match(frame, /▾ g 0\/1 done · 1 next/); // the zero needs-you part is omitted
	assert.match(frame, /▾ shipped 2\/2 done(?! ·)/); // only the fraction is left
	assert.doesNotMatch(frame, /\/\d+ resolved|· \d+ ready/); // the old counts are gone
});

test("renderDashboard: at a narrow width the status column stays whole, the title is what gets clipped", () => {
	const tickets = [
		{ ...ticket("f", "01", "A very long title that cannot fit"), blockedBy: ["03"] }, // 03 is needs-info: an unresolved blocker
		ticket("f", "02", "Done one", "resolved"),
		ticket("f", "03", "Ask", "needs-info"),
	];
	const state = { ...base, tickets, frontier: [] };
	const lines = renderDashboard({ ...state, tab: "queue" }, { width: 40, height: 14 });

	for (const line of lines) assert.ok(line.length <= 40, line);
	// Every status column is fully visible, padded to the widest one rendered.
	assert.ok(lines.some((line) => line.slice(4).startsWith("⧗ waits 03")), lines.join("\n"));
	assert.ok(lines.some((line) => line.slice(4).startsWith("? needs you")), lines.join("\n"));
	assert.ok(lines.some((line) => line.slice(4).startsWith("✔ done")), lines.join("\n"));
	// The long title is the clipped part, ellipsis and all.
	const clipped = lines.find((line) => line.includes("A very long title"));
	assert.ok(clipped, lines.join("\n"));
	assert.equal(clipped.length, 40);
	assert.match(clipped, /…$/);
	assert.match(clipped, /01 A very long title/);
});

test("dashboard: details carry the status column's label, and a needs-info ticket its reason", () => {
	const ask = { ...ticket("f", "04", "Ask", "needs-info"), type: "code" };
	const frame = renderDashboard({
		...base,
		tickets: [ask, ticket("f", "05", "Done", "resolved")],
		details: "f/04",
		ticketDetails: {
			key: "f/04",
			ticket: ask,
			what: "ask something",
			shift: ["### Shift 2 — pi opencode-go/glm-5.3 (medium)", "- Outcome: needs-info: verify failed twice"],
			reason: "verify failed twice",
		},
	}).join("\n");

	assert.match(frame, /f\/04 · Ask · \? needs you/);
	assert.match(frame, /Reason: verify failed twice/); // the reason from the last shift report
	assert.doesNotMatch(frame, /f\/04 · Ask · needs-info/); // the machine word is gone

	// Without a reason on record the line still shows, with a dash.
	const bare = renderDashboard({
		...base,
		tickets: [ask],
		details: "f/04",
		ticketDetails: { key: "f/04", ticket: ask, what: "ask something", shift: [], reason: null },
	}).join("\n");
	assert.match(bare, /Reason: -/);
});

test("dashboard: the Resolved tab lists the fully resolved features; the header shows 5 Resolved", () => {
	const tickets = [ticket("f", "01", "Open"), ticket("shipped", "01", "Old", "resolved"), ticket("shipped", "02", "Older", "resolved")];
	const state = { ...base, tickets, frontier: [tickets[0]] };

	const sized = renderDashboard({ ...state, tab: "resolved" }, { width: 120, height: 20 }).join("\n"); // 120: the six-tab header needs the room
	assert.match(sized, /\[5 Resolved\]/);
	assert.match(sized, /6 GitHub/);
	assert.match(sized, /▾ shipped 2\/2 done/); // zero next/needs-you parts are omitted
	assert.match(sized, /✔ done  01 Old/);
	assert.match(sized, /✔ done  02 Older/);
	assert.doesNotMatch(sized, /▾ f /); // the open feature stays on the Queue

	// The Queue tab no longer lists the fully resolved feature.
	const queue = renderDashboard({ ...state, tab: "queue" }, { width: 120, height: 20 }).join("\n");
	assert.match(queue, /▾ f 0\/1 done · 1 next/);
	assert.doesNotMatch(queue, /shipped/);

	// The plain frame (--once, the fallback) lists every feature as it always has.
	const plain = renderDashboard(state).join("\n");
	assert.match(plain, /▾ shipped 2\/2 done/);
	assert.match(plain, /▾ f 0\/1 done · 1 next/);

	// An empty Resolved tab says so.
	const empty = renderDashboard(
		{ ...state, tickets: [tickets[0]], frontier: [tickets[0]], tab: "resolved" },
		{ width: 120, height: 20 },
	).join("\n");
	assert.match(empty, /Resolved: none/);
});

test("renderDashboard: each tab fits height and width; a 40-ticket queue keeps the cursor row visible", () => {
	const tickets = Array.from({ length: 40 }, (_, i) => {
		const number = String(i + 1).padStart(2, "0");
		return ticket("big", number, `Ticket ${number}`);
	});
	const last = tickets.at(-1);
	const longLog = Array.from({ length: 30 }, (_, i) => `12:00:00 turn · line ${i + 1}`);
	const state = {
		...base,
		tickets,
		frontier: tickets,
		cursor: { queue: 40, agents: 4, cooldowns: 4, log: 29 },
		run: {
			pid: 9,
			live: true,
			startedAt: "2026-10-01T11:00:00Z",
			workers: Array.from({ length: 5 }, (_, i) => ({
				ticket: { feature: "big", number: String(i + 1).padStart(2, "0"), title: `Ticket ${String(i + 1).padStart(2, "0")}` },
				model: "claude:sonnet",
				tier: "standard",
				attempt: 1,
				shift: 1,
				usage: { tokens: 10, costUsd: 0.01, turns: 1, contextPct: 4 },
			})),
		},
		cooldowns: Array.from({ length: 5 }, (_, i) => ({
			provider: `p${i}`,
			kind: "rate",
			until: "2026-10-01T12:10:00Z",
		})),
		log: { path: join("logs", "big", "40", "attempt-1.jsonl"), lines: longLog },
	};
	const width = 48;
	const height = 12;

	for (const tab of ["queue", "agents", "cooldowns", "log"]) {
		const lines = renderDashboard({ ...state, tab }, { width, height });
		assert.ok(lines.length <= height, `${tab}: ${lines.length} lines`);
		for (const line of lines) {
			assert.ok(line.length <= width, `${tab}: ${line.length} > ${width}: ${line}`);
		}
		// With colour on the escapes ride on top of the clipped line: the visible width still fits.
		const colored = renderDashboard({ ...state, tab }, { width, height, color: true });
		assert.ok(colored.length <= height, `${tab} color: ${colored.length} lines`);
		for (const line of colored) {
			assert.ok(stripSgr(line).length <= width, `${tab} color: ${stripSgr(line).length} > ${width}: ${line}`);
		}
	}

	const queue = renderDashboard({ ...state, tab: "queue" }, { width, height });
	assert.equal(queue.some((line) => line.includes(`${last.number} ${last.title}`)), true);
	assert.match(queue.join("\n"), /> {3}● next #40 {2,}40 Ticket 40/); // the column pads to the widest label (a working one here)
	assert.equal(
		renderDashboard({ ...state, tab: "queue" }, { width, height }).join("\n").includes("Ticket 01"),
		false,
	);
});

test("renderDashboard color: reverse-video cursor row, the coloured status column, markers, notice and cooldowns; off means no escapes", () => {
	const tickets = [
		ticket("f", "01", "Done", "resolved"),
		ticket("f", "02", "Held", "claimed"),
		ticket("f", "03", "Ask", "needs-info"),
		{ ...ticket("f", "04", "Wait"), blockedBy: ["03"] },
		ticket("f", "05", "Next"),
	];
	const state = {
		...base,
		tickets,
		frontier: [tickets[4]],
		notice: "runner started (pid 4242)",
		cursor: { queue: 1, cooldowns: 0 },
		run: {
			pid: 1,
			live: true,
			workers: [{ ticket: { feature: "f", number: "02", title: "Held" }, model: "claude:sonnet", attempt: 1, shift: 1 }],
		},
		cooldowns: [
			{ provider: "xai", kind: "rate", until: "2026-10-01T12:05:00Z" },
			{ provider: "grok", kind: "limit", until: "2026-10-01T12:07:00Z" },
		],
	};

	const lines = renderDashboard({ ...state, tab: "queue" }, { width: 60, height: 24, color: true });
	const text = lines.join("\n");

	assert.match(lines[0], /\x1b\[1m\[1 Queue\]\x1b\[22m/); // the active tab label is bold
	assert.match(text, /\x1b\[33m» runner started/); // the notice is yellow
	const cursorRow = lines.find((line) => line.includes("\x1b[7m"));
	assert.match(cursorRow, /01 Done/); // the cursor row, reverse video
	assert.match(cursorRow, /\x1b\[32m✔ done/); // done green
	assert.equal(stripSgr(cursorRow).length, 60); // reverse video across the visible width
	assert.match(text, /\x1b\[36m▶ working claude:sonnet/); // working cyan
	assert.match(text, /\x1b\[33m\? needs you/); // needs you yellow
	assert.match(text, /\x1b\[2m⧗ waits 03/); // waits dim, blockers included
	assert.match(text, /\x1b\[1m● next #1\x1b\[22m/); // next bold

	const cooldowns = renderDashboard({ ...state, tab: "cooldowns" }, { width: 60, height: 24, color: true });
	assert.match(cooldowns.find((line) => line.includes("xai (rate)")), /\x1b\[7m/); // the cursor row is still reverse video
	assert.match(cooldowns.find((line) => line.includes("grok (limit)")), /^\x1b\[31m/); // cooldown rows are red

	for (const tab of ["queue", "agents", "cooldowns", "log"]) {
		for (const line of renderDashboard({ ...state, tab }, { width: 60, height: 24 })) {
			assert.equal(line.includes("\x1b["), false, `${tab}: ${line}`); // colour off: no escapes
		}
	}
});

test("renderDashboard: a list search filters the queue, the header shows the prompt on its own line, the footer the search keys while editing", () => {
	const tickets = [ticket("f", "01", "First widget"), ticket("f", "02", "Second thing"), ticket("g", "01", "Another widget")];
	const state = { ...base, tickets, frontier: tickets, search: { query: "widget", scope: "global", feature: "f", editing: true, match: 0 } };
	const lines = renderDashboard(state, { width: 80, height: 20 }); // 80: the prompt's own line keeps it whole at any width (tui-polish/08)
	const frame = lines.join("\n");

	assert.match(lines[1], /^\/ widget · global$/); // the header shows the prompt on its own line, not clipped off the tab labels
	assert.doesNotMatch(lines[0], /widget/); // the tab-labels line stays as it was
	assert.match(frame, /▾ f 0\/2 done · 2 next/); // the matching tickets' feature rows stay, counts of the whole feature
	assert.match(frame, /● next #1  01 First widget/);
	assert.match(frame, /● next #3  01 Another widget/); // matches from several features
	assert.doesNotMatch(frame, /02 Second thing/); // a non-matching ticket leaves the list
	assert.match(frame, /letters add to the query · backspace delete/); // the footer swaps in the search keys while editing
	assert.match(frame, /q quits/); // the shared keys stay

	// A kept search (enter stopped editing) keeps the prompt line but brings the tab's keys back: `q` quits again.
	const kept = renderDashboard({ ...state, search: { ...state.search, editing: false } }, { width: 80, height: 20 }).join("\n");
	assert.match(kept, /^\/ widget · global$/m);
	assert.match(kept, /↑↓ move · ←→ fold · enter open/);
	assert.doesNotMatch(kept, /letters add to the query/);
	assert.doesNotMatch(kept, /·\/ widget · global/); // the prompt is its own line, not appended to the header

	// A feature scope narrows to the feature captured when the prompt opened.
	const scoped = renderDashboard(
		{ ...state, search: { ...state.search, scope: "feature", feature: "f" } },
		{ width: 80, height: 20 },
	).join("\n");
	assert.match(scoped, /^\/ widget · feature f$/m);
	assert.match(scoped, /01 First widget/);
	assert.doesNotMatch(scoped, /Another widget/);
});

test("renderDashboard: a ticket-scoped search highlights the details' matches, and enter scrolls to the next", () => {
	const t = { ...ticket("f", "03", "Tabbed rendering", "ready-for-agent"), type: "code" };
	const state = {
		...base,
		tickets: [t],
		frontier: [],
		details: "f/03",
		ticketDetails: {
			key: "f/03",
			ticket: t,
			what: "render the tab of the spec",
			shift: ["### Shift 1 — pi opencode-go/glm-5.3 (medium)", "- Outcome: done rendering"],
		},
		search: { query: "render", scope: "ticket", feature: null, editing: true, match: 0 },
	};
	const lines = renderDashboard(state, { width: 80, height: 24 }); // 80: the prompt's own line keeps it whole at any width (tui-polish/08)
	const text = lines.join("\n");

	assert.match(lines[1], /^\/ render · ticket$/); // the header shows the prompt on its own line
	assert.match(text, /Type: code/); // the first match ("Tabbed [render]ing") is at the top, all lines shown
	assert.match(text, /What to build: \[render\] the tab of the spec/);
	assert.match(text, /done \[render\]ing/); // every match in the details is bracketed
	assert.match(lines.at(-2), /enter next match/); // the footer's details-search keys while editing

	// A kept search (enter stopped editing) keeps its real keys in the footer — not the tab's (tui-polish/09).
	const kept = renderDashboard({ ...state, search: { ...state.search, editing: false } }, { width: 80, height: 24 }).join("\n");
	assert.match(kept, /^\/ render · ticket$/m);
	assert.match(kept, /^enter next match · esc clear$/m); // enter jumps to the next match, esc clears the search
	assert.doesNotMatch(kept, /esc back/); // the tab's keys leave while the kept details search stays
	assert.doesNotMatch(kept, /letters add to the query/);

	// enter's next match scrolls the details so that match's line is at the top.
	const next = renderDashboard({ ...state, search: { ...state.search, match: 1 } }, { width: 160, height: 24 }).join("\n");
	assert.doesNotMatch(next, /Type: code/);
	assert.match(next, /What to build: \[render\]/);

	// In colour the brackets become reverse video.
	const colored = renderDashboard(state, { width: 160, height: 24, color: true }).join("\n");
	assert.match(colored, /\x1b\[7mrender\x1b\[27m/);
	assert.doesNotMatch(colored, /\[render\]/);
});

test("dashboardLayout: each list row's y and each tab label's span match the rendered lines, a scrolled list included", () => {
	const tickets = Array.from({ length: 40 }, (_, i) => ticket("big", String(i + 1).padStart(2, "0"), `Ticket ${i + 1}`));
	const state = { ...base, tickets, frontier: tickets, cursor: { queue: 39 } }; // the cursor on the last row: the list is scrolled
	const rows = queueRows(state, state); // the Queue tab's rows, as the hit map indexes them

	const layout = dashboardLayout(state, { width: 80, height: 12 });
	assert.deepEqual(renderDashboard(state, { width: 80, height: 12 }), layout.lines); // renderDashboard keeps its return type

	// The body is a window of 8 rows under the header line and a blank, scrolled to the cursor.
	assert.equal(layout.rows.length, 8);
	assert.ok(layout.rows[0].index > 0, "the list is scrolled");
	for (const [i, { y, index }] of layout.rows.entries()) {
		assert.equal(y, 2 + i); // header line, blank, then the body — one row per line
		const row = rows[index];
		const line = stripSgr(layout.lines[y]);
		if (row.kind === "ticket") assert.ok(line.slice(4).startsWith(row.label), `y ${y} → row ${index}: ${line}`); // the status column, then the number and title
		else assert.ok(line.slice(4).startsWith(`▾ ${row.feature} `), `y ${y} → row ${index}: ${line}`);
		if (i) {
			// consecutive rows of the window: y and index advance together
			assert.equal(y, layout.rows[i - 1].y + 1);
			assert.equal(index, layout.rows[i - 1].index + 1);
		}
	}
	assert.equal(layout.rows.at(-1).index, 39); // the cursor row, scrolled into view

	// The tab labels' spans point at the labels on line 0, colour or not.
	const TABS = ["queue", "agents", "cooldowns", "log", "resolved", "github"];
	const LABELS = { queue: "Queue", agents: "Agents", cooldowns: "Cooldowns", log: "Log", resolved: "Resolved", github: "GitHub" };
	const labelOf = (tab) => `${TABS.indexOf(tab) + 1} ${LABELS[tab]}`;
	for (const color of [false, true]) {
		const frame = dashboardLayout(state, { width: 120, height: 12, color }); // 120: the six-tab header needs the room
		const header = stripSgr(frame.lines[0]);
		assert.deepEqual(frame.tabs.map((t) => t.tab), TABS);
		for (const span of frame.tabs) {
			const label = labelOf(span.tab);
			assert.equal(header.slice(span.x0, span.x1), span.tab === "queue" ? `[${label}]` : label); // queue is the open tab
		}
	}

	// A narrower frame clips the labels like the lines: a label past the width is not a hit.
	const narrow = dashboardLayout(state, { width: 60, height: 12 });
	const narrowHeader = stripSgr(narrow.lines[0]);
	assert.ok(narrow.tabs.length > 0 && narrow.tabs.length < TABS.length);
	for (const span of narrow.tabs) {
		assert.ok(span.x0 < 60 && span.x1 <= 60, `${span.tab}: ${span.x0}–${span.x1}`);
		const visible = narrowHeader.slice(span.x0, span.x1).replace(/…$/, ""); // a clipped label ends with fit's ellipsis
		const label = span.tab === "queue" ? `[${labelOf(span.tab)}]` : labelOf(span.tab);
		assert.ok(label.startsWith(visible), `${span.tab}: ${visible}`);
	}

	// A plain frame (--once, the fallback) has no hit map.
	const plain = dashboardLayout(state, { width: 80 });
	assert.deepEqual(plain.rows, []);
	assert.deepEqual(plain.tabs, []);
});

test("collectDashboardState: an empty repo has no run, no log and no tickets", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-empty-"));
	const state = await collectDashboardState(root, { now });

	assert.equal(state.run, null);
	assert.equal(state.log, null);
	assert.deepEqual(state.tickets, []);
	assert.deepEqual(state.cooldowns, []);
	renderDashboard(state); // must not throw
});

test("collectDashboardState: tails the selected worker's log, else the first", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-log-pick-"));
	await mkdir(join(root, ".scratch", "f", "issues"), { recursive: true });
	await writeFile(join(root, ".scratch", "f", "issues", "01-first.md"), "# 01: First\n\n**Status:** claimed\n");
	await writeFile(join(root, ".scratch", "f", "issues", "02-second.md"), "# 02: Second\n\n**Status:** claimed\n");
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "shiftwork-run.json"),
		JSON.stringify({
			runners: [
				{
					pid: process.pid,
					running: true,
					workers: [
						{ ticket: { feature: "f", number: "01" }, attempt: 1 },
						{ ticket: { feature: "f", number: "02" }, attempt: 2 },
					],
				},
			],
		}),
	);
	await mkdir(join(root, "logs", "f", "01"), { recursive: true });
	await mkdir(join(root, "logs", "f", "02"), { recursive: true });
	await writeFile(join(root, "logs", "f", "01", "attempt-1.jsonl"), `${JSON.stringify({ at: "2026-10-01T11:00:00Z", type: "turn", usage: { totalTokens: 1 } })}\n`);
	await writeFile(join(root, "logs", "f", "02", "attempt-2.jsonl"), `${JSON.stringify({ at: "2026-10-01T11:00:01Z", type: "turn", usage: { totalTokens: 99 } })}\n`);

	const first = await collectDashboardState(root, { now });
	assert.equal(first.log.path, join("logs", "f", "01", "attempt-1.jsonl"));
	assert.match(first.log.lines[0], /1 tokens/);

	const selected = await collectDashboardState(root, { now, view: { selectedWorker: "f/02" } });
	assert.equal(selected.log.path, join("logs", "f", "02", "attempt-2.jsonl"));
	assert.match(selected.log.lines[0], /99 tokens/);
});

test("collectDashboardState: open details read the ticket body and the latest shift report", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-details-"));
	await mkdir(join(root, ".scratch", "f", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "f", "issues", "01-with-shift.md"),
		[
			"# 01: With shift",
			"",
			"**What to build:** the tabbed frame",
			"",
			"**Blocked by:** 02",
			"",
			"**Status:** ready-for-agent",
			"**Type:** code",
			"**Model:** anthropic/claude-sonnet",
			"**Budget:** $2",
			"**Verify:** `npm test`",
			"",
			"## Comments",
			"",
			"### Shift 1 — pi fake/m1 (low)",
			"- Outcome: new attempt",
			"",
			"### Shift 2 — pi opencode-go/glm-5.3 (medium)",
			"- Outcome: resolved",
			"",
		].join("\n"),
	);
	await writeFile(
		join(root, ".scratch", "f", "issues", "02-no-comments.md"),
		"# 02: No comments\n\n**What to build:** nothing extra\n\n**Status:** resolved\n",
	);
	// A needs-info ticket: the reason sits in its last shift report's outcome line.
	await writeFile(
		join(root, ".scratch", "f", "issues", "03-question.md"),
		[
			"# 03: Question",
			"",
			"**What to build:** ask something",
			"",
			"**Status:** needs-info",
			"",
			"## Comments",
			"",
			"### Shift 1 — pi fake/m1 (low)",
			"- Outcome: needs-info: need the prod API key before anything else",
			"",
		].join("\n"),
	);

	const closed = await collectDashboardState(root, { now });
	assert.equal(closed.ticketDetails, null);

	const withShift = await collectDashboardState(root, { now, view: { details: "f/01" } });
	assert.equal(withShift.ticketDetails.key, "f/01");
	assert.equal(withShift.ticketDetails.what, "the tabbed frame");
	assert.equal(withShift.ticketDetails.shift[0], "### Shift 2 — pi opencode-go/glm-5.3 (medium)");
	assert.equal(
		withShift.ticketDetails.shift.some((line) => line.includes("Shift 1")),
		false,
	);
	const frame = renderDashboard({ ...withShift, details: "f/01" }).join("\n");
	assert.match(frame, /Type: code/);
	assert.match(frame, /What to build: the tabbed frame/);
	assert.match(frame, /Last shift report:/);
	assert.match(frame, /### Shift 2 — pi opencode-go\/glm-5\.3 \(medium\)/);
	assert.doesNotMatch(frame, /### Shift 1 /);

	const bare = await collectDashboardState(root, { now, view: { details: "f/02" } });
	assert.equal(bare.ticketDetails.what, "nothing extra");
	assert.deepEqual(bare.ticketDetails.shift, []);
	const bareFrame = renderDashboard({ ...bare, details: "f/02" }).join("\n");
	assert.match(bareFrame, /What to build: nothing extra/);
	assert.doesNotMatch(bareFrame, /Last shift report/);

	// The needs-info ticket's reason comes from its last shift report's outcome line.
	const ask = await collectDashboardState(root, { now, view: { details: "f/03" } });
	assert.equal(ask.ticketDetails.reason, "need the prod API key before anything else");
	const askFrame = renderDashboard({ ...ask, details: "f/03" }).join("\n");
	assert.match(askFrame, /f\/03 · Question · \? needs you/);
	assert.match(askFrame, /Reason: need the prod API key before anything else/);
});

test("collectDashboardState: the GitHub tab's rows come from .pi/shiftwork-github.json, the state from the tickets", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-gh-"));
	const body = (title, status) => `# ${title}\n\n**Blocked by:** None\n\n**Status:** ${status}\n\n**Type:** code\n`;
	const feature = async (name, tickets) => {
		await mkdir(join(root, ".scratch", name, "issues"), { recursive: true });
		for (const [file, title, status] of tickets) await writeFile(join(root, ".scratch", name, "issues", file), body(title, status));
	};
	await feature("gh-8-plan", [["01-plan.md", "Plan", "ready-for-agent"]]);
	await feature("gh-9-work", [["01-plan.md", "Plan", "resolved"], ["02-thing.md", "Thing", "claimed"]]);
	await feature("gh-10-question", [["02-thing.md", "Thing", "needs-info"]]);
	await feature("gh-11-done", [["02-thing.md", "Thing", "resolved"]]);
	await feature("gh-12-closed", [["02-thing.md", "Thing", "resolved"]]);
	await mkdir(join(root, ".pi"), { recursive: true });
	const entry = (number, feature, title, posted) => ({ number, feature, title, importedAt: "2026-10-01T10:00:00Z", lastCommentId: null, posted });
	await writeFile(
		join(root, ".pi", "shiftwork-github.json"),
		JSON.stringify({
			syncedAt: "2026-10-01T11:55:00Z",
			issues: {
				"12": entry(12, "gh-12-closed", "Closed", ["working", "done"]),
				"11": entry(11, "gh-11-done", "Done", ["working"]),
				"10": entry(10, "gh-10-question", "Question", ["needs-info:02"]),
				"9": entry(9, "gh-9-work", "Work", ["working"]),
				"8": entry(8, "gh-8-plan", "Plan", []),
			},
		}),
	);

	const state = await collectDashboardState(root, { now });
	assert.deepEqual(state.github.issues, [
		{ number: 8, title: "Plan", feature: "gh-8-plan", state: "planning" },
		{ number: 9, title: "Work", feature: "gh-9-work", state: "working" },
		{ number: 10, title: "Question", feature: "gh-10-question", state: "needs-info" },
		{ number: 11, title: "Done", feature: "gh-11-done", state: "done" },
		{ number: 12, title: "Closed", feature: "gh-12-closed", state: "closed" },
	]);
	assert.equal(state.github.syncedAt, "2026-10-01T11:55:00Z");

	// The GitHub tab lists the issues with their state and the time of the last sync.
	const frame = renderDashboard({ ...state, tab: "github" }, { width: 120, height: 24 }).join("\n");
	assert.match(frame, /GitHub: 5 issues · last sync 5m ago/);
	assert.match(frame, /#8 Plan · gh-8-plan · planning/);
	assert.match(frame, /#9 Work · gh-9-work · working/);
	assert.match(frame, /#10 Question · gh-10-question · needs-info/);
	assert.match(frame, /#11 Done · gh-11-done · done/);
	assert.match(frame, /#12 Closed · gh-12-closed · closed/);
	assert.match(renderDashboard({ ...state }).join("\n"), /GitHub: 5 issues · last sync 5m ago/); // the plain frame keeps the section

	// An unreadable state file yields no rows, never a crash.
	await writeFile(join(root, ".pi", "shiftwork-github.json"), "not json");
	const broken = await collectDashboardState(root, { now });
	assert.deepEqual(broken.github, { issues: [], syncedAt: null });
});

test("dashboard: the header shows dark-factory while a dark-factory runner is live", () => {
	const run = { pid: 7, running: true, live: true, mode: "dark-factory", workers: [], summary: { resolved: 0, needsInfo: 0 } };
	assert.match(renderDashboard({ ...base, run }).join("\n"), /6 GitHub · dark-factory/);
	// A normal runner, or a finished one, shows no mode in the header.
	assert.doesNotMatch(renderDashboard({ ...base, run: { ...run, mode: null } }).join("\n"), /GitHub · dark-factory/);
	assert.doesNotMatch(renderDashboard({ ...base, run: { ...run, live: false } }).join("\n"), /GitHub · dark-factory/);
});

test("tailShiftLog: a missing log file gives an empty tail, not a crash", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-nolog-"));
	const log = await tailShiftLog(root, { workers: [{ ticket: { feature: "f", number: "01" }, attempt: 1 }] });

	assert.equal(log.path, join("logs", "f", "01", "attempt-1.jsonl"));
	assert.deepEqual(log.lines, []);
	assert.equal(await tailShiftLog(root, null), null);
});

test("formatLogLine: known events are compact, junk passes through", () => {
	assert.equal(formatLogLine(JSON.stringify({ at: "2026-10-01T11:59:58.123Z", type: "turn", usage: { totalTokens: 120 } })), "11:59:58 turn · 120 tokens");
	assert.equal(formatLogLine(JSON.stringify({ at: "2026-10-01T11:59:59Z", type: "wait", until: "2026-10-01T12:05:00Z" })), "11:59:59 wait · until 12:05:00");
	assert.equal(formatLogLine("not json  "), "not json");
});

test("shiftwork tui --once prints one frame and exits", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-once-"));
	await mkdir(join(root, ".scratch", "f", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "f", "issues", "01-first.md"),
		"# 01: First\n\n**Blocked by:** None\n\n**Status:** claimed\n",
	);
	// A fully resolved feature: the plain frame of --once still lists it, Queue tab or not.
	await mkdir(join(root, ".scratch", "shipped", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "shipped", "issues", "01-old.md"),
		"# 01: Old\n\n**Blocked by:** None\n\n**Status:** resolved\n",
	);
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "shiftwork-run.json"),
		JSON.stringify({
			runners: [
				{
					pid: process.pid, // alive, so the child sees the run as live
					running: true,
					startedAt: new Date().toISOString(),
					workers: [
						{
							ticket: { feature: "f", number: "01", title: "First", path: join(root, ".scratch", "f", "issues", "01-first.md") },
							attempt: 1,
							shift: 1,
							model: "fake/m1",
							thinking: "low",
							usage: { tokens: 120, costUsd: 0.25, turns: 1, contextPct: 12 },
						},
					],
				},
			],
		}),
	);
	await mkdir(join(root, "logs", "f", "01"), { recursive: true });
	await writeFile(
		join(root, "logs", "f", "01", "attempt-1.jsonl"),
		`${JSON.stringify({ at: new Date().toISOString(), type: "turn", usage: { totalTokens: 120 } })}\n`,
	);

	const { stdout, stderr } = await exec(["tui", "--once", "--dir", root]);

	assert.equal(stderr, "");
	assert.doesNotMatch(stdout, /\x1b\[/); // --once stays colourless
	assert.match(stdout, /Runner: working f\/01 · First \(pid \d+\)/);
	assert.match(stdout, /f\/01 First · fake\/m1 · shift 1 · attempt 1/);
	assert.match(stdout, /120 tokens · \$0\.25 · 1 turns · ctx 12%/);
	assert.match(stdout, /▶ working fake\/m1  01 First/);
	assert.match(stdout, /▾ shipped 1\/1 done/); // the plain frame keeps resolved features
	assert.match(stdout, /✔ done +01 Old/); // the plain frame's column pads across every feature's labels
	assert.match(stdout, /Log: logs\/f\/01\/attempt-1\.jsonl/);
	assert.match(stdout, /turn · 120 tokens/);
});

test("shiftwork tui --once works on an empty repo", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-blank-"));
	const { stdout, stderr } = await exec(["tui", "--once", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /Runner: idle \(no run state\)/);
	assert.match(stdout, /Tickets: none/);
	assert.match(stdout, /Cooldowns: none/);
});

test("loadPiTui resolves pi-tui next to a managed-install pi package, and reports why it can't", async () => {
	const modules = join(await mkdtemp(join(tmpdir(), "sw-tui-managed-")), "releases", "1.0.0", "node_modules", "@earendil-works");
	const piRoot = join(modules, "pi-coding-agent");
	const tuiRoot = join(modules, "pi-tui");
	await mkdir(piRoot, { recursive: true });
	await mkdir(tuiRoot, { recursive: true });
	await writeFile(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0" }));
	await writeFile(join(tuiRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
	await writeFile(join(tuiRoot, "index.js"), "export const Text = 'stub';\n");

	const found = await loadPiTui({ piRoot, locate: ({ root }) => ({ root }) });
	assert.equal(found.kit.Text, "stub");

	const missing = await loadPiTui({
		locate: () => {
			throw new Error("pi not found: set pi.root");
		},
	});
	assert.equal(missing.kit, undefined);
	assert.match(missing.error.message, /pi\.root/);
});

test("shiftwork tui --help describes the tabs and keys", async () => {
	const { stdout, stderr } = await exec(["tui", "--help"]);

	assert.equal(stderr, "");
	assert.match(stdout, /Queue/);
	assert.match(stdout, /Agents/);
	assert.match(stdout, /Cooldowns/);
	assert.match(stdout, /Log/);
	assert.match(stdout, /1–6/);
	assert.match(stdout, /Resolved/);
	assert.match(stdout, /GitHub/);
	assert.match(stdout, /g toggles dark-factory/);
	assert.match(stdout, /n runs the selected ticket/);
	assert.match(stdout, /\/ opens a search prompt/); // search: / filters the list or the details (GitHub #3)
	assert.match(stdout, /letters — n, r, s, d, f, q and digits/);
	assert.match(stdout, /▶ working glm-5\.3/); // the status column's legend (tui-polish/07)
	assert.match(stdout, /● next #1 — its place in the order the runner/);
	assert.match(stdout, /⧗ waits 01, 03/);
	assert.match(stdout, /\? needs you/);
	assert.match(stdout, /✋ for human/);
	assert.match(stdout, /○ triage/);
	assert.match(stdout, /✔ done/);
	assert.match(stdout, /✖ wontfix/);
	assert.match(stdout, /⏸ paused/);
	assert.match(stdout, /2\/6 done · 2 next · 1 needs you/);
	assert.match(stdout, /TuiAltScreen/);
	assert.match(stdout, /colour/i);
	assert.match(stdout, /NO_COLOR/);
});

async function waitFor(check, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await check();
		if (found) return found;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A Terminal that records size, one resize, and input — no real TTY. */
class StubTerminal {
	constructor({ columns = 80, rows = 24 } = {}) {
		this.columns = columns;
		this.rows = rows;
		this.writes = [];
		this.started = false;
		this.stopped = false;
		this._onInput = null;
		this._onResize = null;
	}
	start(onInput, onResize) {
		this.started = true;
		this._onInput = onInput;
		this._onResize = onResize;
	}
	stop() {
		this.stopped = true;
	}
	write(data) {
		this.writes.push(data);
	}
	drainInput() {
		return Promise.resolve();
	}
	get kittyProtocolActive() {
		return false;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	send(data) {
		this._onInput?.(data);
	}
	resize(columns, rows) {
		this.columns = columns;
		this.rows = rows;
		this._onResize?.();
	}
}

class StubText {
	constructor(text = "") {
		this.frames = [];
		this.text = text;
	}
	setText(text) {
		this.text = text;
		this.frames.push(text);
	}
	invalidate() {}
	render() {
		return this.text.split("\n");
	}
}

class StubTuiAltScreen {
	constructor(terminal) {
		this.terminal = terminal;
		this.listeners = [];
		this.layoutRoot = null;
		this.children = [];
		this.renders = 0;
		this.started = false;
		this.stopped = false;
	}
	setLayoutRoot(component) {
		this.layoutRoot = component;
	}
	addChild(component) {
		this.children.push(component);
	}
	addInputListener(listener) {
		this.listeners.push(listener);
		return () => {};
	}
	requestRender() {
		this.renders += 1;
	}
	start() {
		this.started = true;
		this.terminal.start((data) => {
			for (const listener of this.listeners) {
				const result = listener(data);
				if (result?.consume) return;
			}
		}, () => this.requestRender());
	}
	stop() {
		this.stopped = true;
		this.terminal.stop();
	}
}

test("interactive: stub terminal size, one resize, a key chunk reaching handleKey", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-stub-"));
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "demo", "issues", "01-first.md"),
		"# 01: First\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n",
	);
	await writeFile(
		join(root, ".scratch", "demo", "issues", "02-second.md"),
		"# 02: Second\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n",
	);

	const terminal = new StubTerminal({ columns: 80, rows: 24 });
	const keys = [];
	let text;
	const kit = {
		ProcessTerminal: class {},
		TuiAltScreen: StubTuiAltScreen,
		Text: class extends StubText {
			constructor(initial) {
				super(initial);
				text = this;
			}
		},
	};

	const done = interactive(root, kit, { terminal, onKey: (key) => keys.push(key) });

	const first = await waitFor(() => (text?.frames.length ? text.text : false));
	const firstLines = first.split("\n");
	assert.ok(firstLines.length <= 24, `first frame ${firstLines.length} lines`);
	for (const line of firstLines) {
		assert.ok(stripSgr(line).length <= 80, `first frame line ${stripSgr(line).length} > 80`);
	}
	assert.match(first, /\[1 Queue\]/);
	assert.match(first, /\x1b\[7m/); // colour on by default

	const before = text.frames.length;
	terminal.resize(40, 10);
	const resized = await waitFor(() => (text.frames.length > before ? text.text : false));
	const resizedLines = resized.split("\n");
	assert.ok(resizedLines.length <= 10, `resized frame ${resizedLines.length} lines`);
	for (const line of resizedLines) {
		assert.ok(stripSgr(line).length <= 40, `resized line ${stripSgr(line).length} > 40: ${line}`);
	}

	terminal.send("\x1b[B\x1b[B2");
	await waitFor(() => keys.includes("2"));
	assert.deepEqual(
		keys.filter((k) => k === "down" || k === "2"),
		["down", "down", "2"],
	);

	terminal.send("q");
	assert.equal(await done, 0);
	assert.equal(terminal.stopped, true);
});

test("interactive: a click event delivered to the layout root's handleMouse changes the view", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-mouse-"));
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "demo", "issues", "01-first.md"),
		"# 01: First\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n**Type:** docs\n",
	);
	await writeFile(
		join(root, ".scratch", "demo", "issues", "02-second.md"),
		"# 02: Second\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n**Type:** docs\n",
	);

	const terminal = new StubTerminal({ columns: 80, rows: 24 });
	let text;
	let ui;
	const kit = {
		ProcessTerminal: class {},
		TuiAltScreen: class extends StubTuiAltScreen {
			constructor(t) {
				super(t);
				ui = this;
			}
		},
		Text: class extends StubText {
			constructor(initial) {
				super(initial);
				text = this;
			}
		},
	};
	const done = interactive(root, kit, { terminal });
	const first = await waitFor(() => (text?.frames.length ? text.text : false));
	const header = () => stripSgr(text.text.split("\n")[0]);

	// A click on a tab label (line 0) switches tabs.
	const agentsX = header().indexOf("2 Agents");
	assert.ok(agentsX >= 0, header());
	assert.deepEqual(ui.layoutRoot.handleMouse({ type: "click", button: "left", x: agentsX + 1, y: 0 }), { handled: true });
	await waitFor(() => header().includes("[2 Agents]"));

	// And a click on the Queue label switches back.
	ui.layoutRoot.handleMouse({ type: "click", button: "left", x: header().indexOf("1 Queue") + 1, y: 0 });
	await waitFor(() => header().includes("[1 Queue]"));

	// A click on a list row moves the cursor there; a second click on it opens the details.
	const rowY = text.text.split("\n").findIndex((line) => /02 Second/.test(stripSgr(line)));
	assert.ok(rowY > 0, text.text);
	ui.layoutRoot.handleMouse({ type: "click", button: "left", x: 10, y: rowY });
	await waitFor(() => stripSgr(text.text.split("\n")[rowY]).startsWith(">")); // the cursor row
	ui.layoutRoot.handleMouse({ type: "click", button: "left", x: 10, y: rowY });
	await waitFor(() => /demo\/02 · Second · ● next #2/.test(stripSgr(text.text))); // the details view, its first line carrying the status column

	// The wheel moves the cursor too: esc closes the details, then the wheel scrolls up.
	terminal.send("\x1b");
	await waitFor(() => !/demo\/02 · Second/.test(stripSgr(text.text)));
	ui.layoutRoot.handleMouse({ type: "wheel", button: "none", x: 10, y: rowY, wheelDelta: -1 });
	await waitFor(() => stripSgr(text.text.split("\n")[rowY - 1]).startsWith(">"));

	terminal.send("q");
	assert.equal(await done, 0);
});

test("interactive: NO_COLOR disables colour in the interactive view", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-nocolor-"));
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "demo", "issues", "01-first.md"),
		"# 01: First\n\n**Blocked by:** None\n\n**Status:** claimed\n",
	);

	const frame = async () => {
		const terminal = new StubTerminal({ columns: 80, rows: 24 });
		let text;
		const kit = {
			ProcessTerminal: class {},
			TuiAltScreen: StubTuiAltScreen,
			Text: class extends StubText {
				constructor(initial) {
					super(initial);
					text = this;
				}
			},
		};
		const done = interactive(root, kit, { terminal });
		const first = await waitFor(() => (text?.frames.length ? text.text : false));
		terminal.send("q");
		assert.equal(await done, 0);
		return first;
	};

	assert.match(await frame(), /\x1b\[7m/); // colour on without NO_COLOR
	try {
		process.env.NO_COLOR = "1";
		assert.doesNotMatch(await frame(), /\x1b\[/); // NO_COLOR turns it off
	} finally {
		delete process.env.NO_COLOR;
	}
});
