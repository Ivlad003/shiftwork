import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openRunState } from "shiftwork-core";
import { collectDryRunLines } from "../src/dry-run.js";
import { createTuiControls, reduceKey, startDetachedRunner, writeStopFile } from "../src/tui-controls.js";

const stubRunner = fileURLToPath(new URL("./fixtures/stub-runner.js", import.meta.url));

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
