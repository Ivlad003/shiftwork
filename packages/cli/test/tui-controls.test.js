import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openRunState } from "shiftwork-core";
import { collectDryRunLines } from "../src/dry-run.js";
import { createTuiControls, decodeKeys, queueRows, reduceKey, startDetachedRunner, writeStopFile } from "../src/tui-controls.js";

const stubRunner = fileURLToPath(new URL("./fixtures/stub-runner.js", import.meta.url));
const argvRunner = fileURLToPath(new URL("./fixtures/argv-runner.js", import.meta.url));

async function waitFor(check, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await check();
		if (found) return found;
		if (Date.now() > deadline) throw new Error("timed out waiting for the runner");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// --- The pure reducer: (state, key) → state + effects ---

const idle = { run: null, features: [], featureFilter: null, notice: null, dryRun: null };

test("reducer: r starts a runner, scoped to the feature filter", () => {
	const { state, effects } = reduceKey(idle, "r");
	assert.deepEqual(effects, [{ type: "start-runner", feature: null }]);
	assert.match(state.notice, /starting/);
	assert.equal(idle.notice, null); // the input state is never mutated

	const scoped = reduceKey({ ...idle, featureFilter: "orch" }, "r");
	assert.deepEqual(scoped.effects, [{ type: "start-runner", feature: "orch" }]);
});

test("reducer: a second r while a runner is live is refused (spec story 28)", () => {
	const run = { pid: 42, live: true, running: true };
	const { state, effects } = reduceKey({ ...idle, run }, "r");
	assert.deepEqual(effects, []);
	assert.match(state.notice, /already working \(pid 42\)/);
});

test("reducer: s stops with a handoff; the notice says who finishes the shift", () => {
	const live = reduceKey({ ...idle, run: { pid: 42, live: true } }, "s");
	assert.deepEqual(live.effects, [{ type: "stop-runner" }]);
	assert.match(live.state.notice, /STOP file written · runner pid 42 hands off and stops/);

	const noRunner = reduceKey(idle, "s");
	assert.deepEqual(noRunner.effects, [{ type: "stop-runner" }]);
	assert.match(noRunner.state.notice, /STOP file written \(no live runner\)/);
});

test("reducer: d asks for a dry-run and shows a pending panel", () => {
	const { state, effects } = reduceKey({ ...idle, featureFilter: "orch" }, "d");
	assert.deepEqual(effects, [{ type: "dry-run", feature: "orch" }]);
	assert.deepEqual(state.dryRun, { pending: true });
});

test("reducer: f cycles the feature filter through all features and back to all", () => {
	const features = ["orch", "pi-runner"];
	let state = { ...idle, features };
	({ state } = reduceKey(state, "f"));
	assert.equal(state.featureFilter, "orch");
	({ state } = reduceKey(state, "f"));
	assert.equal(state.featureFilter, "pi-runner");
	({ state } = reduceKey(state, "f"));
	assert.equal(state.featureFilter, null);
	assert.match(state.notice, /all features/);
});

test("reducer: q and Ctrl-C quit; any other key is ignored", () => {
	assert.deepEqual(reduceKey(idle, "q").effects, [{ type: "quit" }]);
	assert.deepEqual(reduceKey(idle, "\x03").effects, [{ type: "quit" }]);
	const { state, effects } = reduceKey(idle, "x");
	assert.deepEqual(effects, []);
	assert.deepEqual(state, idle);
});

// --- The effects, driven by the controls over a temp repo ---

async function repo(tickets = {}, { config = true } = {}) {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-keys-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "issues", file), body);
	}
	if (config) {
		await mkdir(join(root, ".pi"), { recursive: true });
		await writeFile(
			join(root, ".pi", "shiftwork.json"),
			JSON.stringify({
				model: "fake/m1",
				routing: { git: { tier: "quick", thinking: "low" }, docs: { tier: "quick" } },
				tiers: { quick: { chain: ["fake/m1"] } },
			}),
		);
	}
	return root;
}

const ticketBody = `# 07: Widget ticket\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n**Type:** git\n`;

/** Controls whose start effect spawns the stub runner instead of the real CLI. */
function stubControls(root, extra = {}) {
	return createTuiControls({
		root,
		start: (root_, effect) => startDetachedRunner(root_, { feature: effect.feature, bin: stubRunner }),
		...extra,
	});
}

test("r starts the stub runner detached; s stops it with a STOP file", async () => {
	const root = await repo({ "demo/07-widget.md": ticketBody });
	const controls = stubControls(root);
	controls.setDashboard({ run: null, tickets: [{ feature: "demo", number: "07" }] });
	await controls.handleKey("f"); // filter: demo — the run is scoped to it

	const effects = await controls.handleKey("r");
	assert.deepEqual(effects, [{ type: "start-runner", feature: "demo" }]);
	assert.match(controls.view.notice, /runner started \(pid \d+\) · logs: logs\/runner-.*\.log/);

	// The runner is its own process, live in the run state, and got the feature filter.
	const state = await waitFor(async () => {
		const s = await openRunState(root).read();
		return s?.workers?.length ? s : false;
	});
	assert.equal(state.live, true);
	assert.notEqual(state.pid, process.pid);
	assert.equal(state.feature, "demo");

	// s writes the STOP file; the stub runner hands off and exits.
	await controls.handleKey("s");
	assert.match(await readFile(join(root, "STOP"), "utf8"), /Stopped from shiftwork tui/);
	const finished = await waitFor(async () => {
		const s = await openRunState(root).read();
		return s && !s.live && s.stoppedReason ? s : false;
	});
	assert.equal(finished.stoppedReason, "STOP file");
});

test("a second runner is refused: no new process, a warning notice", async () => {
	const root = await repo({});
	const controls = stubControls(root);
	controls.setDashboard({ run: null, tickets: [] });

	await controls.handleKey("r");
	const first = await openRunState(root).read();
	controls.setDashboard({ run: first, tickets: [] }); // the next frame would see the live runner

	const effects = await controls.handleKey("r");
	assert.deepEqual(effects, []);
	assert.match(controls.view.notice, /already working \(pid \d+\)/);
	assert.equal((await openRunState(root).read()).pid, first.pid);

	// Even racing the first frame, startDetachedRunner itself refuses a live runner.
	const again = await startDetachedRunner(root, { bin: stubRunner });
	assert.equal(again.started, false);
	assert.match(again.reason, /already working/);

	await writeStopFile(root); // let the stub exit
	await waitFor(async () => !(await openRunState(root).read())?.live);
});

test("starting removes a stale STOP file that would end the new run", async () => {
	const root = await repo({});
	await writeFile(join(root, "STOP"), "left over\n");
	const res = await startDetachedRunner(root, { bin: stubRunner });
	assert.equal(res.started, true);
	assert.equal(res.removedStop, true);
	assert.equal(existsSync(join(root, "STOP")), false);
	await writeStopFile(root);
	await waitFor(async () => !(await openRunState(root).read())?.live);
});

test("d fills the dry-run panel with the route of each frontier ticket", async () => {
	const root = await repo({ "demo/07-widget.md": ticketBody });
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	const controls = createTuiControls({ root, plan: (root_, effect) => collectDryRunLines(root_, { ...effect, agentDir }) });
	controls.setDashboard({ run: null, tickets: [{ feature: "demo", number: "07" }] });

	const effects = await controls.handleKey("d");
	assert.deepEqual(effects, [{ type: "dry-run", feature: null }]);
	assert.match(controls.view.dryRun.lines.join("\n"), /demo\/07 {2}type=git {2}tier=quick {2}model=fake\/m1/);
});

test("d scopes the dry-run to the feature filter", async () => {
	const root = await repo({
		"demo/07-widget.md": ticketBody,
		"other/01-else.md": `# 01: Else\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n**Type:** docs\n`,
	});
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	const controls = createTuiControls({ root, plan: (root_, effect) => collectDryRunLines(root_, { ...effect, agentDir }) });
	controls.setDashboard({ run: null, tickets: [{ feature: "demo", number: "07" }, { feature: "other", number: "01" }] });

	await controls.handleKey("f"); // filter: demo
	await controls.handleKey("f"); // filter: other
	assert.equal(controls.view.featureFilter, "other");
	await controls.handleKey("d");
	assert.match(controls.view.dryRun.lines.join("\n"), /other\/01 {2}type=docs/);
	assert.doesNotMatch(controls.view.dryRun.lines.join("\n"), /demo\/07/);
});

test("startDetachedRunner passes --ticket through to the spawned runner", async () => {
	const root = await repo({ "demo/07-widget.md": ticketBody });
	const res = await startDetachedRunner(root, { ticket: "demo/07", bin: argvRunner });
	assert.equal(res.started, true);

	const argv = await waitFor(async () => {
		try {
			return JSON.parse(await readFile(join(root, "argv.json"), "utf8"));
		} catch {
			return false;
		}
	});
	assert.deepEqual(argv, ["run", "--ticket", "demo/07"]);
});

test("q fires onQuit; a failing effect becomes a notice, not a crash", async () => {
	const root = await repo({});
	const quit = new Promise((resolve) => {
		const controls = createTuiControls({ root, onQuit: resolve });
		controls.handleKey("q");
	});
	await quit;

	const controls = createTuiControls({
		root,
		plan: () => {
			throw new Error("no config");
		},
	});
	await controls.handleKey("d");
	assert.equal(controls.view.dryRun, null);
	assert.match(controls.view.notice, /dry-run failed: no config/);
});
// --- The tabbed view: tabs, cursor, collapse, details, `n` (phase-5 spec) ---

/** Press one key on one frame: the next view state. */
const press = (state, key, dashboard) => reduceKey(state, key, dashboard).state;

/** One frame with two features: demo (frontier 01, blocked 02, resolved 03) and other (ready 01). */
const frame = () => ({
	run: null,
	tickets: [
		{ feature: "demo", number: "01", title: "first", status: "ready-for-agent", blockedBy: [] },
		{ feature: "demo", number: "02", title: "blocked", status: "ready-for-agent", blockedBy: ["01"] },
		{ feature: "demo", number: "03", title: "done", status: "resolved", blockedBy: [] },
		{ feature: "other", number: "01", title: "elsewhere", status: "ready-for-agent", blockedBy: [] },
	],
	frontier: [
		{ feature: "demo", number: "01", blockedBy: [] },
		{ feature: "other", number: "01", blockedBy: [] },
	],
	claims: [],
	cooldowns: [],
	log: { path: "logs/demo/01/attempt-1.jsonl", lines: ["one", "two", "three"] },
});

test("queueRows: feature folders then their tickets, counts, the frontier and the worker marker", () => {
	const d = frame();
	d.run = { pid: 7, live: true, workers: [{ ticket: { feature: "demo", number: "02" }, model: "fake/m1" }] };
	const rows = queueRows(d, {});
	assert.deepEqual(
		rows.map((r) => r.kind),
		["feature", "ticket", "ticket", "ticket", "feature", "ticket"],
	);
	assert.deepEqual(rows[0], { kind: "feature", feature: "demo", collapsed: false, resolved: 1, ready: 1, total: 3 });
	assert.deepEqual(rows[1], {
		kind: "ticket",
		feature: "demo",
		number: "01",
		title: "first",
		status: "ready-for-agent",
		blockedBy: [],
		frontier: true,
		worker: null,
	});
	assert.equal(rows[2].worker.model, "fake/m1"); // the agent working on the ticket (story 3)
	assert.equal(rows[3].status, "resolved");
	assert.equal(rows[3].frontier, false);

	// A feature filter narrows the queue to that feature's rows.
	assert.deepEqual(
		queueRows(d, { featureFilter: "other" }).map((r) => r.feature),
		["other", "other"],
	);
});

test("reducer: 1–4 switch tabs, tab cycles through all four and back", () => {
	const d = frame();
	assert.equal(press(idle, "1", d).tab, "queue");
	assert.equal(press(idle, "2", d).tab, "agents");
	assert.equal(press(idle, "3", d).tab, "cooldowns");
	assert.equal(press(idle, "4", d).tab, "log");
	let state = idle;
	for (const tab of ["agents", "cooldowns", "log", "queue"]) {
		state = press(state, "tab", d);
		assert.equal(state.tab, tab);
	}
});

test("reducer: up/down (k/j) move the cursor, clamped at both ends, each tab its own", () => {
	const d = frame(); // queue: 6 rows; log: 3 lines
	let state = press(idle, "down", d);
	assert.equal(state.cursor.queue, 1);
	state = press(state, "j", d);
	assert.equal(state.cursor.queue, 2);
	state = press(press(press(state, "down", d), "down", d), "down", d);
	assert.equal(state.cursor.queue, 5); // clamped at the last row
	state = press(press(state, "up", d), "k", d);
	assert.equal(state.cursor.queue, 3);
	state = press(press(press(state, "up", d), "up", d), "up", d);
	assert.equal(state.cursor.queue, 0); // clamped at the first row

	// The Log tab has its own cursor over the log lines, clamped the same way.
	state = press(press(state, "4", d), "down", d);
	assert.equal(state.cursor.log, 1);
	assert.equal(state.cursor.queue, 0); // the queue cursor is kept
	// Empty rows: the cursor stays at 0.
	assert.deepEqual(press(idle, "down", {}).cursor, { queue: 0, agents: 0, cooldowns: 0, log: 0 });
});

test("reducer: left collapses the feature under the cursor, right expands it; queueRows hides the tickets", () => {
	const d = frame();
	let state = press(press(idle, "down", d), "left", d); // cursor on demo/01 → its feature
	assert.deepEqual(state.collapsed, ["demo"]);
	const rows = queueRows(d, state);
	assert.equal(rows.length, 3); // two folder rows + other/01: demo's tickets are hidden
	assert.equal(rows[0].collapsed, true);
	assert.equal(state.cursor.queue, 1); // clamped into the shrunken list (the other folder row)
	state = press(state, "right", d); // the cursor is on the other folder: expanding it is a no-op
	assert.deepEqual(state.collapsed, ["demo"]);
	state = press(press(state, "up", d), "right", d); // back on the demo folder → expand
	assert.deepEqual(state.collapsed, []);
	assert.equal(queueRows(d, state).length, 6);

	// left/right only mean folders on the Queue tab.
	state = press(press(idle, "4", d), "left", d);
	assert.deepEqual(state.collapsed, []);
});

test("reducer: enter opens the selected ticket's details; esc and backspace close them", () => {
	const d = frame();
	let state = press(press(idle, "down", d), "enter", d); // demo/01
	assert.equal(state.details, "demo/01");
	state = press(state, "esc", d);
	assert.equal(state.details, null);
	state = press(press(state, "down", d), "enter", d); // demo/02
	assert.equal(state.details, "demo/02");
	state = press(state, "backspace", d);
	assert.equal(state.details, null);
	assert.equal(press(idle, "enter", d).details, null); // enter on a feature row opens nothing
});

test("reducer: enter on an Agents row selects that worker and switches to the Log tab", () => {
	const d = frame();
	d.run = { pid: 7, live: true, workers: [{ ticket: { feature: "demo", number: "02" }, model: "fake/m1" }] };
	const state = press({ ...idle, tab: "agents" }, "enter", d);
	assert.equal(state.tab, "log");
	assert.equal(state.selectedWorker, "demo/02");
});

test("reducer: n starts the selected frontier ticket; anything else is refused with a notice", () => {
	const d = frame();
	const on01 = reduceKey(press(idle, "down", d), "n", d); // demo/01 is ready and unblocked
	assert.deepEqual(on01.effects, [{ type: "start-runner", feature: null, ticket: "demo/01" }]);
	assert.match(on01.state.notice, /starting demo\/01…/);

	const blocked = reduceKey(press(press(idle, "down", d), "down", d), "n", d); // demo/02
	assert.deepEqual(blocked.effects, []);
	assert.match(blocked.state.notice, /demo\/02 is not on the frontier: blocked by 01/);

	const resolved = reduceKey(press(press(press(idle, "down", d), "down", d), "down", d), "n", d); // demo/03
	assert.match(resolved.state.notice, /demo\/03 is not on the frontier: status resolved/);

	// A claimed ticket is not on the frontier any more.
	const claimedD = {
		...d,
		claims: [{ ticket: { feature: "demo", number: "01" }, pid: 123 }],
		frontier: d.frontier.filter((t) => !(t.feature === "demo" && t.number === "01")),
	};
	const claimed = reduceKey(press(idle, "down", d), "n", claimedD);
	assert.match(claimed.state.notice, /demo\/01 is not on the frontier: claimed by pid 123/);

	const folder = reduceKey(idle, "n", d); // the cursor is on the demo folder row
	assert.deepEqual(folder.effects, []);
	assert.match(folder.state.notice, /no ticket selected: the cursor is on the feature demo/);

	const live = reduceKey(press(idle, "down", d), "n", { ...d, run: { pid: 42, live: true } });
	assert.deepEqual(live.effects, []);
	assert.match(live.state.notice, /a runner is already working \(pid 42\)/);
});

test("n on a ready ticket starts a detached runner with --ticket; a blocked ticket is refused", async () => {
	const root = await repo({
		"demo/07-widget.md": ticketBody,
		"demo/08-blocked.md": `# 08: Blocked\n\n**Blocked by:** 07\n\n**Status:** ready-for-agent\n\n**Type:** git\n`,
	});
	const controls = createTuiControls({
		root,
		start: (root_, effect) => startDetachedRunner(root_, { ticket: effect.ticket, bin: argvRunner }),
	});
	controls.setDashboard({
		run: null,
		tickets: [
			{ feature: "demo", number: "07", status: "ready-for-agent", blockedBy: [] },
			{ feature: "demo", number: "08", status: "ready-for-agent", blockedBy: ["07"] },
		],
		frontier: [{ feature: "demo", number: "07", blockedBy: [] }],
		claims: [],
	});

	await controls.handleKey("down"); // demo/07
	await controls.handleKey("down"); // demo/08
	const blocked = await controls.handleKey("n");
	assert.deepEqual(blocked, []);
	assert.match(controls.view.notice, /demo\/08 is not on the frontier: blocked by 07/);

	await controls.handleKey("up"); // demo/07
	const effects = await controls.handleKey("n");
	assert.deepEqual(effects, [{ type: "start-runner", feature: null, ticket: "demo/07" }]);
	assert.match(controls.view.notice, /runner started \(pid \d+\)/);

	const argv = await waitFor(async () => {
		try {
			return JSON.parse(await readFile(join(root, "argv.json"), "utf8"));
		} catch {
			return false;
		}
	});
	assert.deepEqual(argv, ["run", "--ticket", "demo/07"]);
});

test("reducer: n's start effect is wired through the controls like r's", async () => {
	const root = await repo({ "demo/07-widget.md": ticketBody });
	const started = [];
	const controls = createTuiControls({
		root,
		start: (root_, effect) => (started.push(effect), { started: true, pid: 1, logFile: "logs/x.log" }),
	});
	controls.setDashboard({
		run: null,
		tickets: [{ feature: "demo", number: "07", status: "ready-for-agent", blockedBy: [] }],
		frontier: [{ feature: "demo", number: "07", blockedBy: [] }],
		claims: [],
	});
	await controls.handleKey("down"); // the cursor moves onto demo/07
	await controls.handleKey("n");
	assert.deepEqual(started, [{ type: "start-runner", feature: null, ticket: "demo/07" }]);
	assert.equal(controls.view.tab, "queue"); // the tabbed view state survives the round-trip
	assert.deepEqual(controls.view.cursor, { queue: 1, agents: 0, cooldowns: 0, log: 0 });
});

// --- decodeKeys: raw terminal input → key names ---

test("decodeKeys: each key, and several keys arriving in one chunk", () => {
	assert.deepEqual(decodeKeys("\x1b[A"), ["up"]);
	assert.deepEqual(decodeKeys("\x1b[B"), ["down"]);
	assert.deepEqual(decodeKeys("\x1b[C"), ["right"]);
	assert.deepEqual(decodeKeys("\x1b[D"), ["left"]);
	assert.deepEqual(decodeKeys("\x1bOA"), ["up"]); // application cursor mode
	assert.deepEqual(decodeKeys("\r"), ["enter"]);
	assert.deepEqual(decodeKeys("\x1b"), ["esc"]);
	assert.deepEqual(decodeKeys("\t"), ["tab"]);
	assert.deepEqual(decodeKeys("\x7f"), ["backspace"]);
	assert.deepEqual(decodeKeys("n"), ["n"]);
	assert.deepEqual(decodeKeys("\x03"), ["\x03"]); // Ctrl-C keeps today's key name
	assert.deepEqual(decodeKeys("\x1b[B\x1b[Bn"), ["down", "down", "n"]);
	assert.deepEqual(decodeKeys("\x1b[Ak\r"), ["up", "k", "enter"]);
	assert.deepEqual(decodeKeys(Buffer.from("\tj\x7f")), ["tab", "j", "backspace"]);
	// Unknown escape sequences are consumed, not decoded into garbage keys.
	assert.deepEqual(decodeKeys("\x1b[5~n"), ["n"]);
	assert.deepEqual(decodeKeys("\x1b[1;5Aq"), ["q"]);
});
