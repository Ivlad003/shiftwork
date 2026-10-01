import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openRunState } from "shiftwork-core";
import { collectDashboardState, formatLogLine, renderDashboard, tailShiftLog } from "../src/dashboard.js";
import { interactive, loadPiTui } from "../src/tui.js";

const parallelRunState = fileURLToPath(new URL("./fixtures/parallel-run-state.json", import.meta.url));

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = async (args, env = {}) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env } });
};

const now = new Date("2026-10-01T12:00:00Z");

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
	assert.match(frame, /▾ f 0\/1 resolved · 1 ready/);
	assert.match(frame, /01 First · ready-for-agent/);
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
	assert.match(frame, /r run · s stop · d dry-run · f filter · q quits/);
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
	assert.match(frame, /▾ b 0\/1 resolved · 1 ready/);
	assert.match(frame, /01 Two · ready-for-agent/);
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

	assert.match(frame, /01 Held · claimed · ● claude:sonnet/);
});

test("dashboard: collapsed features use ▸ and hide their tickets", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("parallel", "01", "First"), ticket("parallel", "02", "Second")],
		frontier: [ticket("parallel", "01", "First")],
		collapsed: ["parallel"],
	}).join("\n");

	assert.match(frame, /▸ parallel 0\/2 resolved · 1 ready/);
	assert.doesNotMatch(frame, /01 First/);
	assert.doesNotMatch(frame, /▾ parallel/);
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

	assert.match(withShift, /f\/03 · Tabbed rendering · ready-for-agent/);
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
	}

	const queue = renderDashboard({ ...state, tab: "queue" }, { width, height });
	assert.equal(queue.some((line) => line.includes(`${last.number} ${last.title}`)), true);
	assert.match(queue.join("\n"), />   40 Ticket 40/);
	assert.equal(
		renderDashboard({ ...state, tab: "queue" }, { width, height }).join("\n").includes("Ticket 01"),
		false,
	);
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
	assert.match(stdout, /Runner: working f\/01 · First \(pid \d+\)/);
	assert.match(stdout, /f\/01 First · fake\/m1 · shift 1 · attempt 1/);
	assert.match(stdout, /120 tokens · \$0\.25 · 1 turns · ctx 12%/);
	assert.match(stdout, /01 First · claimed · ● fake\/m1/);
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
	assert.match(stdout, /1–4/);
	assert.match(stdout, /n runs the selected ticket/);
	assert.match(stdout, /TuiAltScreen/);
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
		assert.ok(line.length <= 80, `first frame line ${line.length} > 80`);
	}
	assert.match(first, /\[1 Queue\]/);

	const before = text.frames.length;
	terminal.resize(40, 10);
	const resized = await waitFor(() => (text.frames.length > before ? text.text : false));
	const resizedLines = resized.split("\n");
	assert.ok(resizedLines.length <= 10, `resized frame ${resizedLines.length} lines`);
	for (const line of resizedLines) {
		assert.ok(line.length <= 40, `resized line ${line.length} > 40: ${line}`);
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
