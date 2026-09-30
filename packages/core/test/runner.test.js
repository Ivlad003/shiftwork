import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { openCooldowns, openTracker, runFrontier, shouldReview, validateConfig } from "../src/index.js";
import { SOFT_LIMIT_STEER, STOP_STEER, WORKER_PROMPT } from "../src/prompt.js";
import { fakeBackend, fileVerify } from "./fake-backend.js";
import { makeRepo, ticket } from "./helpers.js";

const config = { model: "fake/m1", thinking: "low", maxAttempts: 2 };

async function run(root, backend, options = {}) {
	return runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config, options });
}

async function ticketText(root, feature, file) {
	return readFile(`${root}/.scratch/${feature}/issues/${file}`, "utf8");
}

test("a shift that makes the verify gate pass resolves the ticket with a report", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" }, text: "Implemented." }]);

	const summary = await run(root, backend);

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(summary.resolved[0].reason, "verify passed");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /## Comments[\s\S]*### Shift 1 — pi fake\/m1[\s\S]*Verify: passed/);
});

test("a failing verify gate starts a new attempt, then needs-info after maxAttempts", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ text: "Tried." }, { text: "Tried again." }]);

	const summary = await run(root, backend);

	assert.equal(backend.shifts.length, 2);
	assert.equal(summary.exitCode, 2);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* needs-info/);
	assert.match(text, /### Shift 1[\s\S]*done\.txt: missing[\s\S]*### Shift 2/);
	assert.match(text, /verify gate failed after 2 attempts/);
});

test("the second attempt's prompt points at the ticket so the failure can be read", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ text: "Tried." }, { files: { "done.txt": "ok" } }]);

	await run(root, backend);

	const second = backend.shifts[1].request;
	assert.match(second.prompt, /\.scratch\/f\/issues\/01-a\.md/);
	assert.match(second.prompt, /attempt 2/i);
	assert.equal(second.route.model, "fake/m1");
	assert.equal(second.route.thinking, "low");
});

test("the needs-info marker stops the ticket with the agent's reason", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ text: 'Cannot proceed. <shiftwork:needs-info reason="Which database?"/>' }]);

	const summary = await run(root, backend);

	assert.equal(backend.shifts.length, 1);
	assert.equal(summary.needsInfo[0].reason, "Which database?");
	assert.match(await ticketText(root, "f", "01-a.md"), /\*\*Status:\*\* needs-info[\s\S]*Which database\?/);
});

test("a ticket without Verify goes to needs-info after its attempt", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	const summary = await run(root, backend);

	assert.equal(summary.needsInfo[0].reason, "no Verify commands: a human must check this ticket");
});

test("tickets run in frontier order and a blocker unlocks the next ticket", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { blockedBy: "01", extra: "**Verify:** `b.txt`" }),
	});
	const backend = fakeBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);

	const summary = await run(root, backend);

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01", "02"]);
});

test("--once works exactly one ticket; the ticket's own Model overrides the default", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Model:** other/m9\n**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = fakeBackend([{ files: { "a.txt": "" } }]);

	const summary = await run(root, backend, { once: true });

	assert.equal(backend.shifts.length, 1);
	assert.equal(backend.shifts[0].request.route.model, "other/m9");
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
});

test("nothing to do exits 0 and the claim is always released", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { status: "resolved" }) });

	const summary = await run(root, fakeBackend([]));

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved, []);
});

test("a missing skill path is reported in the shift report", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "" }, warnings: ["missing skill path: /tmp/no-such-skill"] }]);

	await run(root, backend);

	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /Warning: missing skill path: \/tmp\/no-such-skill/);
});

test("a shift error is reported and counts as a failed attempt", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ error: "boom" }, { files: { "done.txt": "" } }]);

	const summary = await run(root, backend);

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.match(await ticketText(root, "f", "01-a.md"), /### Shift 1[\s\S]*error: boom/);
});

function fakeWorkspace({ landOk = true, changed = true, diffStat = "" } = {}) {
	const calls = [];
	return {
		calls,
		async hasChanges() {
			return changed;
		},
		async diffStat() {
			return typeof diffStat === "function" ? diffStat() : diffStat;
		},
		async prepare(t) {
			calls.push(["prepare", t.number]);
			const { mkdtemp } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			this.cwd = await mkdtemp(`${tmpdir()}/sw-ws-`);
			return { cwd: this.cwd };
		},
		async land(t) {
			calls.push(["land", t.number]);
			return landOk ? { ok: true, message: "merged" } : { ok: false, message: "merge conflict in README.md" };
		},
		async keep(t) {
			calls.push(["keep", t.number]);
			return { branch: `shiftwork/${t.feature}-${t.number}` };
		},
	};
}

test("with a workspace, shifts and verify run in the ticket's worktree and a resolve lands it", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const workspace = fakeWorkspace();

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config, workspace });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts[0].request.cwd, workspace.cwd);
	assert.deepEqual(workspace.calls, [["prepare", "01"], ["land", "01"]]);
	assert.match(backend.shifts[0].request.prompt, new RegExp(`Ticket: ${root}/\\.scratch/f/issues/01-a\\.md`));
	assert.match(await ticketText(root, "f", "01-a.md"), /- Landed: merged/);
});

test("a ticket that needs info keeps its branch", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const workspace = fakeWorkspace();

	await runFrontier({ root, tracker: openTracker(root), backend: fakeBackend([{}]), verify: fileVerify(), config, workspace });

	assert.deepEqual(workspace.calls, [["prepare", "01"], ["keep", "01"]]);
	assert.match(await ticketText(root, "f", "01-a.md"), /Branch kept: shiftwork\/f-01/);
});

test("a failed landing turns a passing ticket into needs-info with the reason", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const workspace = fakeWorkspace({ landOk: false });

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend: fakeBackend([{ files: { "done.txt": "" } }]),
		verify: fileVerify(),
		config,
		workspace,
	});

	assert.equal(summary.needsInfo[0].reason, "verify gate passed but landing failed: merge conflict in README.md");
	assert.match(await ticketText(root, "f", "01-a.md"), /\*\*Status:\*\* needs-info/);
});

const stopTurn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };

test("a STOP file created mid-shift keeps the agent's Handoff note and adds no runner note", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const ticketPath = `${root}/.scratch/f/issues/01-a.md`;
	const { appendFile } = await import("node:fs/promises");
	const steered = [];
	const backend = fakeBackend([
		{
			files: { STOP: "" },
			events: [stopTurn, stopTurn, stopTurn, { type: "end", stopReason: "stop" }],
			steer: async (text) => {
				steered.push(text);
				await appendFile(ticketPath, "\n### Handoff\n- Agent: paused on STOP, files touched: src/runner.js\n");
			},
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await run(root, backend);

	assert.equal(summary.exitCode, 3);
	assert.equal(summary.stoppedReason, "STOP file");
	assert.deepEqual(steered, [STOP_STEER]);
	assert.equal(backend.shifts.length, 1, "STOP must not start another shift");
	assert.equal(backend.shifts[0].aborted, true);
	const tracker = openTracker(root);
	assert.equal((await tracker.activeClaims()).length, 0);
	assert.equal((await tracker.list())[0].status, "ready-for-agent");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff\n- Agent: paused on STOP/);
	assert.doesNotMatch(text, /### Handoff — shift 1/);
});

test("a non-compliant STOP agent gets a runner Handoff note after the grace turns", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			files: { STOP: "" },
			events: [stopTurn, stopTurn, stopTurn, stopTurn, { type: "end", stopReason: "stop" }],
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await run(root, backend);

	assert.equal(summary.exitCode, 3);
	assert.equal(summary.stoppedReason, "STOP file");
	assert.equal(backend.shifts.length, 1, "STOP must not start another shift");
	assert.equal(backend.shifts[0].aborted, true);
	assert.equal((await openTracker(root).activeClaims()).length, 0);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* ready-for-agent/);
	assert.match(text, /### Handoff — shift 1, fake\/m1 → \(no target\), reason: STOP file/);
	assert.doesNotMatch(text, /### Handoff\n- Agent:/);
});

test("a STOP file present before the run starts works no ticket and exits 3", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const { writeFile } = await import("node:fs/promises");
	await writeFile(`${root}/STOP`, "");
	const backend = fakeBackend([{ files: { "done.txt": "" } }]);

	const summary = await run(root, backend);

	assert.equal(backend.shifts.length, 0);
	assert.equal(summary.exitCode, 3);
	assert.match(await ticketText(root, "f", "01-a.md"), /\*\*Status:\*\* ready-for-agent/);
});

test("a turns budget of 2 causes a fresh handoff, a Handoff note and a new shift on the next model", async () => {
	const budgetConfig = {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { maxTurns: 2 } } },
		onExceed: { maxTurns: { to: "next", mode: "new-process" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			events: [
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: budgetConfig });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff — shift 1, fake\/m1 → fake\/m2, reason: budget\.maxTurns/);
	assert.match(text, /### Shift 2 — pi fake\/m2/);
});

test("the ticket budget ceiling ends in needs-info with the reason", async () => {
	const budgetConfig = {
		model: "fake/m1",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
		onExceed: {},
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Budget:** 1 turns\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			events: [
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
		},
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: budgetConfig });

	assert.equal(summary.exitCode, 2);
	assert.equal(summary.needsInfo[0].reason, "ticket budget exhausted: maxTurns (1 / 1)");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff blocked/);
	assert.match(text, /\*\*Status:\*\* needs-info/);
});

test("maxHandoffs is respected", async () => {
	const budgetConfig = {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 1,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2", "fake/m3"], thinking: "low", budget: { maxTurns: 2 } } },
		onExceed: { maxTurns: { to: "next", mode: "new-process" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			events: [
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
		},
		{
			events: [
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: budgetConfig });

	assert.equal(summary.exitCode, 2);
	assert.equal(summary.needsInfo[0].reason, "maxHandoffs (1) exceeded");
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
});

test("a compliant soft limit keeps the agent's handoff note and adds no runner note", async () => {
	const budgetConfig = {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { maxTurns: 5 } } },
		onExceed: { maxTurns: { to: "next", mode: "new-process" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
		softLimitPct: 60,
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const ticketPath = `${root}/.scratch/f/issues/01-a.md`;
	const { appendFile } = await import("node:fs/promises");
	const backend = fakeBackend([
		{
			events: [
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
			steer: async (text) => {
				await appendFile(ticketPath, "\n### Handoff\n- Agent: finished step, files touched: src/runner.js\n");
			},
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: budgetConfig });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff\n- Agent: finished step/);
	assert.doesNotMatch(text, /### Handoff — shift 1/);
	assert.equal(backend.shifts[0].aborted, true, "the handed-off shift must be stopped before the next one starts");
});

test("a handoff whose work already passes the verify gate resolves without another shift", async () => {
	const config = {
		defaultType: "code",
		maxAttempts: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], budget: { maxTurns: 2 } } },
		onExceed: { maxTurns: { to: "next", mode: "new-process" } },
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const turn = { type: "turn", usage: { input: 1, output: 1, totalTokens: 2 }, costUsd: 0 };
	const backend = fakeBackend([{ files: { "done.txt": "" }, events: [turn, turn, turn, { type: "end", stopReason: "stop" }] }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config });

	assert.equal(backend.shifts.length, 1);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
});

test("headings an agent writes itself never shift the runner's shift numbers", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) + "\n## Comments\n\n### Shift 7 — manual, some-model\n- my notes\n" });

	await run(root, fakeBackend([{ files: { "done.txt": "" } }]));

	assert.match(await ticketText(root, "f", "01-a.md"), /^### Shift 1 — pi fake\/m1 \(low\)$/m);
});

test("a non-compliant soft limit gets a runner handoff note at the hard limit", async () => {
	const budgetConfig = {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { maxTurns: 5 } } },
		onExceed: { maxTurns: { to: "next", mode: "new-process" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
		softLimitPct: 60,
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			events: [
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: budgetConfig });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff — shift 1, fake\/m1 → fake\/m2, reason: budget\.maxTurns/);
});

test("the worker prompt documents the fixed soft-limit and STOP steer text", () => {
	assert.match(WORKER_PROMPT, /Soft limit:/);
	assert.match(WORKER_PROMPT, /### Handoff/);
	assert.ok(WORKER_PROMPT.includes(SOFT_LIMIT_STEER));
	assert.ok(WORKER_PROMPT.includes(STOP_STEER));
});

test("shift numbers continue from the reports already in the ticket after a re-run", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	await run(root, fakeBackend([{ text: "no" }, { text: "no" }]));
	const { readFile: rf, writeFile: wf } = await import("node:fs/promises");
	const path = `${root}/.scratch/f/issues/01-a.md`;
	await wf(path, (await rf(path, "utf8")).replace("**Status:** needs-info", "**Status:** ready-for-agent"));

	await run(root, fakeBackend([{ files: { "done.txt": "" } }]));

	const text = await ticketText(root, "f", "01-a.md");
	assert.deepEqual([...text.matchAll(/^### Shift (\d+) — /gm)].map((m) => m[1]), ["1", "2", "3"]);
	assert.match(await ticketText(root, "f", "01-a.md"), /This is attempt 1|resolved/);
});

const turn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };

function chainConfig(mode, extra = {}) {
	return {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { maxTurns: 2 } } },
		onExceed: { maxTurns: { to: "next", mode } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
		...extra,
	};
}

test("an in-place swap continues the same shift and records the handoff note", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			inPlaceHandoff: true,
			events: [turn, turn, { type: "end", stopReason: "stop" }],
			afterSwap: {
				files: { "done.txt": "ok" },
				events: [turn, { type: "end", stopReason: "stop" }],
			},
		},
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: chainConfig("same-process", { allowInPlace: true }) });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 1, "in-place handoff must not start a new process");
	assert.deepEqual(backend.shifts[0].swaps, [{ model: "fake/m2", thinking: "low" }]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff — shift 1, fake\/m1 → fake\/m2, reason: budget\.maxTurns/);
});

test("a turns limit is a fresh handoff even when the backend supports in-place", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			inPlaceHandoff: true,
			events: [turn, turn, { type: "end", stopReason: "stop" }],
			afterSwap: {
				files: { "done.txt": "ok" },
				events: [turn, { type: "end", stopReason: "stop" }],
			},
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: chainConfig("same-process") });

	assert.equal(summary.exitCode, 0);
	assert.equal(backend.shifts.length, 2, "default is a new shift, not an in-place swap");
	assert.deepEqual(backend.shifts[0].swaps, []);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff — shift 1, fake\/m1 → fake\/m2, reason: budget\.maxTurns/);
});

test("same-process without inPlaceHandoff falls back to a fresh handoff", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ events: [turn, turn, { type: "end", stopReason: "stop" }] },
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: chainConfig("same-process") });

	assert.equal(summary.exitCode, 0);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
});

test("same-process compacts first when the target window is smaller", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			inPlaceHandoff: true,
			contextWindows: { "fake/m2": 50 },
			events: [
				{ type: "turn", usage: { input: 40, output: 20, totalTokens: 60 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 40, output: 20, totalTokens: 60 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
			afterSwap: {
				files: { "done.txt": "ok" },
				events: [turn, { type: "end", stopReason: "stop" }],
			},
		},
	]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: chainConfig("same-process", { allowInPlace: true }) });

	assert.equal(backend.shifts.length, 1);
	assert.equal(backend.shifts[0].compactions.length, 1);
	assert.equal(backend.shifts[0].swaps.length, 1);
});

function chainTwoProviders(extra = {}) {
	return {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 1,
		maxHandoffs: 3,
		crossTier: "none",
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "other/m2"], thinking: "low" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
		onExceed: {},
		...extra,
	};
}

function fakeClock(start) {
	let now = start;
	const sleeps = [];
	return {
		sleeps,
		now: () => new Date(now),
		async sleep(ms) {
			sleeps.push(ms);
			now += ms;
		},
	};
}

test("a 429 cools the provider, relaunches on the next chain model, and does not count an attempt", async () => {
	const cfg = chainTwoProviders();
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ error: "HTTP 429 Too Many Requests" }, { files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.equal(summary.exitCode, 0);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "other/m2");
	assert.match(backend.shifts[0].request.prompt, /attempt 1/);
	assert.match(backend.shifts[1].request.prompt, /attempt 1/);
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.equal(state.cooldowns[0].provider, "fake");
	assert.equal(state.cooldowns[0].kind, "rate");
	assert.match(await ticketText(root, "f", "01-a.md"), /Provider limit: rate on fake/);
	assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /verify gate failed/);
});

test("all-cooling with crossTier none waits on an injected clock, then resumes", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const cfg = chainTwoProviders();
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	await openCooldowns(root).add("fake", new Date(t0 + 30_000), "rate");
	await openCooldowns(root).add("other", new Date(t0 + 10_000), "rate");
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const waits = [];

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: cfg,
		clock,
		log: (entry) => {
			if (entry.event?.type === "wait") waits.push(entry.event);
		},
	});

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(clock.sleeps, [10_000]);
	assert.equal(waits.length, 1);
	assert.equal(backend.shifts.length, 1);
	assert.equal(backend.shifts[0].request.route.model, "other/m2");
});

test("cooldowns survive a runner restart and skip the cooled provider", async () => {
	const cfg = chainTwoProviders();
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	await openCooldowns(root).add("fake", new Date(Date.now() + 60_000), "rate");
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.equal(summary.exitCode, 0);
	assert.equal(backend.shifts.length, 1);
	assert.equal(backend.shifts[0].request.route.model, "other/m2");
});

test("auto mode with a smaller target window does a fresh handoff instead of compacting", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			inPlaceHandoff: true,
			contextWindows: { "fake/m2": 50 },
			events: [
				{ type: "turn", usage: { input: 40, output: 20, totalTokens: 60 }, costUsd: 0.01 },
				{ type: "turn", usage: { input: 40, output: 20, totalTokens: 60 }, costUsd: 0.01 },
				{ type: "end", stopReason: "stop" },
			],
		},
		{ files: { "done.txt": "ok" } },
	]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: chainConfig("auto") });

	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].swaps.length, 0);
	assert.equal(backend.shifts[0].compactions.length, 0);
});

test("a provider limit after the work is done still lets the verify gate resolve the ticket", async () => {
	const cfg = chainTwoProviders();
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" }, error: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.equal(backend.shifts.length, 1, "no relaunch when the gate already passes");
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.equal(state.cooldowns[0].kind, "usage", "the provider still cools down for later tickets");
});

test("a long cooldown is waited out in steps of at most a minute, so a STOP file is noticed", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const cfg = chainTwoProviders();
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	await openCooldowns(root).add("fake", new Date(t0 + 5 * 3600_000), "usage");
	await openCooldowns(root).add("other", new Date(t0 + 5 * 3600_000), "usage");
	const { writeFile } = await import("node:fs/promises");
	const stopAfter = clock.sleep.bind(clock);
	clock.sleep = async (ms) => {
		await stopAfter(ms);
		if (clock.sleeps.length === 3) await writeFile(`${root}/STOP`, "");
	};

	const summary = await runFrontier({ root, tracker: openTracker(root), backend: fakeBackend([]), verify: fileVerify(), config: cfg, clock });

	assert.equal(summary.exitCode, 3);
	assert.ok(clock.sleeps.every((ms) => ms <= 60_000));
	assert.equal(clock.sleeps.length, 3);
});

test("a passing verify gate with no change in the worktree doesn't resolve the ticket", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const workspace = fakeWorkspace({ changed: false });
	const backend = fakeBackend([{ error: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}' }]);
	const verify = async () => ({ ok: true, results: [{ cmd: "npm test", code: 0, outputTail: "" }] });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.deepEqual(summary.resolved, []);
	assert.match(summary.needsInfo[0].reason, /no shift changed anything/);
	assert.ok(!workspace.calls.some(([op]) => op === "land"));
});

function stallConfig(extra = {}) {
	return {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: {
			standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { stallTurns: 2, maxTurns: 100 } },
			premium: { chain: ["fake/m3"], thinking: "high", budget: { maxTurns: 50 } },
		},
		onExceed: {
			stallTurns: { to: "escalate", mode: "new-process" },
			verifyFailed: { to: "escalate", mode: "new-process" },
			maxTurns: { to: "downgrade", mode: "new-process" },
		},
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
		...extra,
	};
}

const stallTurn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };

test("a stall leads to a fresh handoff to an escalated tier", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ events: [stallTurn, stallTurn, stallTurn, { type: "end", stopReason: "stop" }] },
		{ files: { "done.txt": "ok" } },
	]);
	const workspace = fakeWorkspace({ diffStat: " M src/loop.js" });

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: stallConfig(),
		workspace,
	});

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m3");
	assert.equal(backend.shifts[0].aborted, true);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff — shift 1, fake\/m1 → fake\/m3, reason: budget\.stallTurns/);
});

test("a model left because of a stall is not chosen again for that ticket", async () => {
	const cfg = stallConfig();
	cfg.tiers.premium.budget = { maxTurns: 2 };
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ events: [stallTurn, stallTurn, stallTurn, { type: "end", stopReason: "stop" }] },
		{ events: [stallTurn, stallTurn, { type: "end", stopReason: "stop" }] },
		{ files: { "done.txt": "ok" } },
	]);
	const workspace = fakeWorkspace({ diffStat: " M src/loop.js" });

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: cfg,
		workspace,
	});

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(
		backend.shifts.map((s) => s.request.route.model),
		["fake/m1", "fake/m3", "fake/m2"],
	);
});

test("repeated verify failures escalate to the next tier", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ text: "Tried." }, { files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: stallConfig(),
	});

	assert.equal(summary.exitCode, 0);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m3");
	assert.match(await ticketText(root, "f", "01-a.md"), /fake\/m1 → fake\/m3/);
});

function jevConfig() {
	return {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: {
			git: { tier: "quick", thinking: "low" },
			code: { tier: "standard" },
		},
		tiers: {
			quick: { chain: ["fake/quick"], thinking: "low" },
			standard: { chain: ["fake/m1"], thinking: "low" },
			premium: { chain: ["fake/premium"], thinking: "high" },
		},
	};
}

test("an untyped ticket uses the classified type", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const classifyTicket = async () => ({ type: "git", complexity: "standard" });

	await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: jevConfig(),
		classifyTicket,
	});

	assert.equal(backend.shifts[0].request.route.type, "git");
	assert.equal(backend.shifts[0].request.route.model, "fake/quick");
	assert.match(await ticketText(root, "f", "01-a.md"), /Type: git \(jev\)/);
});

test("complexity=complex raises the classified ticket's tier by one", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: jevConfig(),
		classifyTicket: async () => ({ type: "git", complexity: "complex" }),
	});

	assert.equal(backend.shifts[0].request.route.type, "git");
	assert.equal(backend.shifts[0].request.route.tier, "standard");
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
});

test("a failing classifier falls back to the default type and notes it", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: jevConfig(),
		classifyTicket: async () => {
			throw new Error("Jev down");
		},
	});

	assert.equal(backend.shifts[0].request.route.type, "code");
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.match(await ticketText(root, "f", "01-a.md"), /Type: code \(default\); Jev unavailable, used default type/);
});

test("a profile contextWindow rescales fake-backend context fill from tokens", async () => {
	const profileConfig = {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { maxContextPct: 50 } } },
		models: { "fake/m1": { contextWindow: 1000 } },
		onExceed: { maxContextPct: { to: "next", mode: "new-process" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{
			events: [
				{ type: "context", percent: 10, tokens: 800, contextWindow: 8000 },
				{ type: "end", stopReason: "stop" },
			],
		},
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: profileConfig,
	});

	assert.equal(summary.exitCode, 0);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /budget\.maxContextPct/);
});

test("a guessed cooldown is probed after probeEveryMin and cleared when the provider answers again", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const cfg = { ...chainTwoProviders(), probeEveryMin: 15 };
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const store = openCooldowns(root);
	await store.add("fake", new Date(t0 + 5 * 3600_000), "usage", { at: new Date(t0 - 20 * 60_000) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const probed = [];
	backend.probe = async (model) => {
		probed.push(model);
		return true;
	};

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg, clock });

	assert.deepEqual(probed, ["fake/m1"]);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1", "the first chain model is back");
	assert.deepEqual(await store.active(new Date(t0)), []);
});

test("a cooldown with the provider's own reset time is never probed; a failed probe keeps the cooldown", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const cfg = { ...chainTwoProviders(), probeEveryMin: 15 };
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const store = openCooldowns(root);
	await store.add("fake", new Date(t0 + 3600_000), "usage", { at: new Date(t0 - 3600_000), exact: true });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const probed = [];
	backend.probe = async (model) => {
		probed.push(model);
		return false;
	};

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg, clock });

	assert.deepEqual(probed, []);
	assert.equal(backend.shifts[0].request.route.model, "other/m2");
	assert.equal((await store.active(new Date(t0))).length, 1);
});

test("before every ticket all guessed cooldowns are probed, even a fresh one", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const cfg = { ...chainTwoProviders(), probeEveryMin: 15 };
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const store = openCooldowns(root);
	await store.add("fake", new Date(t0 + 5 * 3600_000), "usage", { at: new Date(t0 - 60_000) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const probed = [];
	backend.probe = async (model) => {
		probed.push(model);
		return true;
	};

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg, clock });

	assert.deepEqual(probed, ["fake/m1"], "a cooldown only a minute old is still checked at ticket start");
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
});

test("a missing cli backend is skipped like a cooling provider and does not count as an attempt", async () => {
	const cfg = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 1,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["claude:sonnet", "fake/m1"], thinking: "low" } },
	});
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ error: "claude: command not found" }, { files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "sonnet");
	assert.equal(backend.shifts[1].request.route.model, "fake/m1");
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.equal(state.cooldowns[0].provider, "claude");
	assert.equal(state.cooldowns[0].kind, "usage");
	assert.match(await ticketText(root, "f", "01-a.md"), /Provider limit: usage on claude/);
});

test("an ECONNREFUSED ollama shift marks the backend unavailable instead of cooling a server error", async () => {
	const cfg = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 1,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["ollama/llama3.2:latest", "fake/m1"], thinking: "low" } },
	});
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ error: "fetch failed: connect ECONNREFUSED 127.0.0.1:11434" },
		{ files: { "done.txt": "ok" } },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "ollama/llama3.2:latest");
	assert.equal(backend.shifts[1].request.route.model, "fake/m1");
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.equal(state.cooldowns[0].provider, "ollama");
	assert.equal(state.cooldowns[0].kind, "usage");
	assert.match(await ticketText(root, "f", "01-a.md"), /Provider limit: usage on ollama/);
});

// Recorded from pi 0.99.1 with an ollama provider whose server is stopped: the only error text is
// `"stopReason":"error","errorMessage":"Connection error."` (no ECONNREFUSED).
test("pi's real 'Connection error.' on an ollama model marks the backend unavailable", async () => {
	const cfg = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 1,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["ollama/qwen2.5-coder:7b", "fake/m1"], thinking: "low" } },
	});
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ error: "Connection error." }, { files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts[1].request.route.model, "fake/m1");
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.equal(state.cooldowns[0].provider, "ollama");
});

test("a 'Connection error.' on a cloud model is an ordinary failed attempt, not an unavailable backend", async () => {
	const cfg = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "low" } },
	});
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ error: "Connection error." }, { files: { "done.txt": "ok" } }]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8").catch(() => "{}"));
	assert.deepEqual(state.cooldowns ?? [], []);
});

test("an unavailable cursor-agent (missing or not logged in) is skipped like a cooling provider", async () => {
	for (const error of ["cursor-agent: command not found", "cursor-agent backend not available: not logged in (run `cursor-agent login`)"]) {
		const cfg = validateConfig({
			defaultType: "code",
			thinking: "low",
			maxAttempts: 1,
			routing: { code: { tier: "standard" } },
			tiers: { standard: { chain: ["cursor:auto", "fake/m1"], thinking: "low" } },
		});
		const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
		const backend = fakeBackend([{ error }, { files: { "done.txt": "ok" } }]);

		const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

		assert.equal(summary.exitCode, 0);
		assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
		assert.equal(backend.shifts.length, 2, `no retry on ${error}`);
		assert.equal(backend.shifts[0].request.route.model, "auto");
		assert.equal(backend.shifts[1].request.route.model, "fake/m1");
		const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
		assert.equal(state.cooldowns[0].provider, "cursor");
		assert.equal(state.cooldowns[0].kind, "usage");
	}
});

test("a 429 on a free model cools that model only, and the next free model of the same provider runs", async () => {
	const cfg = {
		defaultType: "code",
		maxAttempts: 2,
		routing: { code: { tier: "quick" } },
		tiers: { quick: { chain: ["or/a:free", "or/b:free"] } },
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ error: "429 Too Many Requests: rate limit exceeded" }, { files: { "done.txt": "" } }]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	assert.deepEqual(backend.shifts.map((s) => s.request.route.model), ["or/a:free", "or/b:free"]);
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.deepEqual(state.cooldowns.map((c) => c.provider), ["or/a:free"]);
});

// Review shifts: one review shift in a fresh context after a ticket lands (review: { enabled, tier, when, features?, types? }).

function reviewConfig(review = {}) {
	return validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: {
			standard: { chain: ["fake/m1"], thinking: "low" },
			premium: { chain: ["fake/r1"], thinking: "high" },
		},
		review: { enabled: true, tier: "premium", ...review },
	});
}

const reviewMarker = (verdict, reason) => `<shiftwork:review verdict="${verdict}" reason="${reason}"/>`;

test("shouldReview is off by default and respects the when/features/types filters", () => {
	assert.equal(shouldReview(validateConfig({ model: "fake/m1" }), { feature: "f", type: "code" }), false);
	const base = { review: { enabled: true, tier: "premium", when: "resolve" } };
	assert.equal(shouldReview(base, { feature: "f", type: "code" }), true);
	assert.equal(shouldReview({ review: { ...base.review, features: ["g"] } }, { feature: "f", type: "code" }), false);
	assert.equal(shouldReview({ review: { ...base.review, features: ["f"] } }, { feature: "f", type: "code" }), true);
	assert.equal(shouldReview({ review: { ...base.review, types: ["git"] } }, { feature: "f", type: "code" }), false);
	assert.equal(shouldReview({ review: { ...base.review, types: ["git"] } }, { feature: "f", type: "git" }), true);
	assert.equal(shouldReview({ review: { ...base.review, when: "land" } }, { feature: "f", type: "code" }), false);
});

test("an accepted review runs on the review tier and records ### Review", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: `Looks good overall.\n\n${reviewMarker("accept", "matches the spec")}` },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(summary.resolved[0].review.verdict, "accept");
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[1].request.route.tier, "premium");
	assert.equal(backend.shifts[1].request.route.model, "fake/r1");
	assert.equal(backend.shifts[1].request.cwd, root, "the review reads the landed change in the main repo");
	assert.match(backend.shifts[1].request.prompt, /Review the landed Shiftwork ticket f\/01: A/);
	assert.match(backend.shifts[1].request.prompt, /- Ticket: \.scratch\/f\/issues\/01-a\.md/);
	assert.match(backend.shifts[1].request.prompt, /- Spec: \.scratch\/f\/spec\.md/);
	assert.match(backend.shifts[1].request.prompt, /- Diff: /);
	assert.match(backend.shifts[1].request.prompt, /- Verify gate: `done\.txt`/);
	assert.match(backend.shifts[1].request.systemPrompt, /shiftwork:review verdict="accept\|reopen\|follow-up"/);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /### Review — pi fake\/r1 \(high\)[\s\S]*- Verdict: accept — matches the spec/);
	assert.match(text, /- Verify: passed/);
	assert.match(text, /> Looks good overall\./);
});

test("a reopen verdict sends the ticket back to ready-for-agent with the reason", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: `The diff regressed X.\n\n${reviewMarker("reopen", "the landed change breaks the spec")}` },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.equal(summary.exitCode, 2);
	assert.deepEqual(summary.reopened.map((t) => t.number), ["01"]);
	assert.deepEqual(summary.resolved, []);
	assert.equal(backend.shifts.length, 2, "a reopened ticket is not re-worked within the same run");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* ready-for-agent/);
	assert.match(text, /- Verdict: reopen — the landed change breaks the spec/);
	assert.match(text, /- Verify: passed/);
});

test("a follow-up verdict files a new ready ticket in the feature", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("follow-up", "add integration tests") },
	]);

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: reviewConfig(),
		options: { once: true },
	});

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /- Verdict: follow-up — add integration tests/);
	assert.match(text, /- Follow-up: f\/02 — Follow-up to f\/01: add integration tests/);
	const { readdir } = await import("node:fs/promises");
	const files = (await readdir(`${root}/.scratch/f/issues`)).filter((f) => f.startsWith("02-"));
	assert.equal(files.length, 1);
	const created = await readFile(`${root}/.scratch/f/issues/${files[0]}`, "utf8");
	assert.match(created, /^# 02: Follow-up to f\/01: add integration tests$/m);
	assert.match(created, /\*\*Status:\*\* ready-for-agent/);
	assert.match(created, /\*\*Blocked by:\*\* None/);
	assert.match(created, /add integration tests\. Filed by the review of f\/01/);
	// Without a gate nothing could resolve the follow-up: it inherits the reviewed ticket's.
	assert.match(created, /\*\*Verify:\*\* `done\.txt`/);
});

test("a review without the marker is treated as accept with a warning", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }, { text: "Looks good, but I forgot the marker." }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Verdict: accept — no verdict given/);
	assert.match(text, /- Warning: review ended without a verdict marker; treated as accept/);
});

test("an unknown review verdict is treated as accept with a warning", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }, { text: reviewMarker("reject", "not a verdict") }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Verdict: accept — not a verdict/);
	assert.match(text, /- Warning: unknown review verdict "reject"; treated as accept/);
});

test("reviews are off by default", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const config = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "low" }, premium: { chain: ["fake/r1"], thinking: "high" } },
	});
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 1);
	assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /### Review/);
});

test("the review features filter is respected per ticket", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `a.txt`" }),
		"g/01-b.md": ticket("01", "B", { extra: "**Type:** code\n**Verify:** `b.txt`" }),
	});
	const backend = fakeBackend([
		{ files: { "a.txt": "" } },
		{ files: { "b.txt": "" } },
		{ text: reviewMarker("accept", "ok") },
	]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig({ features: ["g"] }) });

	assert.equal(backend.shifts.length, 3);
	assert.match(backend.shifts[2].request.prompt, /Review the landed Shiftwork ticket g\/01/);
	assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /### Review/);
	assert.match(await ticketText(root, "g", "01-b.md"), /### Review/);
});

test("the review types filter matches the ticket's effective type", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig({ types: ["git"] }) });

	assert.equal(backend.shifts.length, 1);
	assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /### Review/);
});

test("with a workspace, the review runs in the main repo with the landed message in its prompt", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("accept", "good") },
	]);
	const workspace = fakeWorkspace();
	const verify = async (commands) => ({ ok: true, results: commands.map((cmd) => ({ cmd, code: 0, outputTail: "" })) });

	await runFrontier({ root, tracker: openTracker(root), backend, verify, config: reviewConfig(), workspace });

	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.cwd, workspace.cwd);
	assert.equal(backend.shifts[1].request.cwd, root);
	assert.match(backend.shifts[1].request.prompt, /- Landed: merged/);
	assert.match(backend.shifts[1].request.prompt, /- Ticket: \.scratch\/f\/issues\/01-a\.md/);
	assert.match(await ticketText(root, "f", "01-a.md"), /### Review[\s\S]*- Verdict: accept — good[\s\S]*- Verify: passed/);
});

test("a review whose tier is all cooling is recorded as not run", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	await openCooldowns(root).add("other", new Date(t0 + 3600_000), "rate");
	const config = reviewConfig();
	config.tiers = { ...config.tiers, premium: { chain: ["other/r1"], thinking: "high" } };
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config, clock });

	assert.equal(backend.shifts.length, 1);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.match(await ticketText(root, "f", "01-a.md"), /### Review\n- Not run: every premium model is cooling until 2026-01-01T01:00:00\.000Z/);
});
