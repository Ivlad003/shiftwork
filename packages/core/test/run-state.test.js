import assert from "node:assert/strict";
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
	// Sample the state from the outside while the shift runs.
	const backendWithProbe = {
		...backend,
		async startShift(request) {
			seen.push(await state.read());
			return backend.startShift(request);
		},
	};

	await runFrontier({ root, tracker: openTracker(root), backend: backendWithProbe, verify: fileVerify(), config, options: {} });

	const during = seen[0];
	assert.equal(during.live, true);
	assert.equal(during.pid, process.pid);
	assert.equal(during.ticket.number, "01");
	assert.equal(during.ticket.feature, "f");
	assert.equal(during.shift, 1);
	assert.equal(during.attempt, 1);
	assert.equal(during.model, "fake/m1");
	assert.equal(during.thinking, "low");

	const after = await state.read();
	assert.equal(after.running, false);
	assert.equal(after.live, false);
	assert.deepEqual(after.summary, { resolved: 1, needsInfo: 0 });
	assert.equal(after.ticket, null);
	assert.equal(after.usage.turns, 1);
	assert.equal(after.usage.tokens, 120);
	assert.equal(after.usage.costUsd, 0.25);
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
