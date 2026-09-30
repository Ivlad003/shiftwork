import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openRunState, openTracker, runFrontier } from "../src/index.js";
import { fakeBackend, fileVerify } from "./fake-backend.js";
import { makeRepo, ticket } from "./helpers.js";

const config = { model: "fake/m1", thinking: "low", maxAttempts: 2 };

test("a run publishes the current ticket, shift, model and budget use", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const seen = [];
	const state = openRunState(root);
	const backend = fakeBackend([
		{
			files: { "done.txt": "ok" },
			text: "Implemented.",
			usage: { input: 100, output: 20, totalTokens: 120 },
			costUsd: 0.25,
		},
	]);
	// Sample the state from the outside while the shift runs: at start, and again
	// after the turn events, before the worker entry is removed.
	const backendWithProbe = {
		...backend,
		async startShift(request) {
			seen.push(await state.read());
			return backend.startShift(request);
		},
	};
	const verifyWithProbe = async (commands, cwd) => {
		// The turn events' usage writes are queued: wait for them to land before sampling.
		for (let i = 0; i < 200; i++) {
			const s = await state.read();
			if (s?.workers?.[0]?.usage?.turns === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		seen.push(await state.read());
		return fileVerify()(commands, cwd);
	};

	await runFrontier({ root, tracker: openTracker(root), backend: backendWithProbe, verify: verifyWithProbe, config, options: {} });

	const during = seen[0];
	assert.equal(during.live, true);
	assert.equal(during.pid, process.pid);
	assert.equal(during.workers.length, 1);
	const worker = during.workers[0];
	assert.equal(worker.ticket.number, "01");
	assert.equal(worker.ticket.feature, "f");
	assert.equal(worker.shift, 1);
	assert.equal(worker.attempt, 1);
	assert.equal(worker.model, "fake/m1");
	assert.equal(worker.thinking, "low");

	const worked = seen.at(-1);
	assert.equal(worked.workers[0].usage.turns, 1);
	assert.equal(worked.workers[0].usage.tokens, 120);
	assert.equal(worked.workers[0].usage.costUsd, 0.25);

	const after = await state.read();
	assert.equal(after.running, false);
	assert.equal(after.live, false);
	assert.deepEqual(after.summary, { resolved: 1, needsInfo: 0, reopened: 0 });
	assert.deepEqual(after.workers, []);
	assert.ok(after.updatedAt >= after.startedAt);
});

test("a stopped run records why it stopped", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const { writeFile } = await import("node:fs/promises");
	await writeFile(`${root}/STOP`, "");

	await runFrontier({ root, tracker: openTracker(root), backend: fakeBackend([]), verify: fileVerify(), config, options: {} });

	const state = await openRunState(root).read();
	assert.equal(state.stoppedReason, "STOP file");
	assert.equal(state.running, false);
});

test("reading a run state that was never written gives null", async () => {
	const root = await makeRepo({});
	assert.equal(await openRunState(root).read(), null);
});

test("clear forgets the run", async () => {
	const root = await makeRepo({});
	const state = openRunState(root);
	await state.update({ pid: process.pid, running: true });
	assert.equal((await state.read()).live, true);
	await state.clear();
	assert.equal(await state.read(), null);
});

test("a second runner's entry survives another runner's updates", async () => {
	const root = await makeRepo({});
	const state = openRunState(root);
	// Two live runner processes, like a second `shiftwork run` in the same repo.
	const children = [1, 2].map(() => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]));
	const worker = (n) => ({
		ticket: { feature: "f", number: n, title: `T${n}` },
		attempt: 1,
		shift: 1,
		model: "fake/m1",
		usage: { tokens: 0, costUsd: 0, turns: 0, contextPct: 0 },
	});
	try {
		await state.update({ pid: children[0].pid, running: true, startedAt: new Date().toISOString(), workers: [worker("01")] });
		await state.update({ pid: children[1].pid, running: true, startedAt: new Date().toISOString(), workers: [worker("02")] });

		const both = await state.read();
		assert.equal(both.live, true);
		assert.equal(both.runners.length, 2);
		assert.deepEqual(
			both.workers.map((w) => w.ticket.number).sort(),
			["01", "02"],
			"the merged view lists every live runner's workers",
		);

		// One runner finishing must not clobber the other's entry.
		await state.update({ pid: children[0].pid, running: false, finishedAt: new Date().toISOString(), workers: [], stoppedReason: "STOP file", summary: { resolved: 1, needsInfo: 0, reopened: 0 } });
		const after = await state.read();
		assert.equal(after.live, true);
		assert.deepEqual(after.workers.map((w) => w.ticket.number), ["02"]);
		assert.equal(after.pid, children[1].pid);
	} finally {
		for (const child of children) child.kill();
	}
});

test("a worker entry is patched per ticket and removed when it settles", async () => {
	const root = await makeRepo({});
	const state = openRunState(root);
	await state.update({ pid: process.pid, running: true, workers: [] });
	const t = (n) => ({ feature: "f", number: n });

	await state.updateWorker(t("01"), { ticket: { ...t("01"), title: "One" }, attempt: 1, shift: 2, model: "fake/m1" });
	await state.updateWorker(t("02"), { ticket: { ...t("02"), title: "Two" }, attempt: 1, shift: 1, model: "fake/m2" });
	// The second publish of the same ticket patches its entry, it does not add one.
	await state.updateWorker(t("01"), { usage: { tokens: 10, costUsd: 0, turns: 1, contextPct: 0 } });

	const read = await state.read();
	assert.equal(read.workers.length, 2);
	const one = read.workers.find((w) => w.ticket.number === "01");
	assert.equal(one.shift, 2);
	assert.equal(one.usage.tokens, 10);

	await state.removeWorker(t("01"));
	assert.deepEqual((await state.read()).workers.map((w) => w.ticket.number), ["02"]);
});

test("a legacy single-runner run state still reads as one runner with one worker", async () => {
	const root = await makeRepo({});
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "shiftwork-run.json"),
		JSON.stringify({
			pid: process.pid,
			running: true,
			startedAt: new Date().toISOString(),
			ticket: { feature: "f", number: "01", title: "Old", path: "/old/01.md" },
			attempt: 2,
			shift: 3,
			model: "fake/m1",
			usage: { tokens: 5, costUsd: 0.1, turns: 1, contextPct: 0 },
		}),
	);

	const read = await openRunState(root).read();
	assert.equal(read.live, true);
	assert.equal(read.runners.length, 1);
	assert.equal(read.workers.length, 1);
	assert.equal(read.workers[0].ticket.number, "01");
	assert.equal(read.workers[0].shift, 3);
});
