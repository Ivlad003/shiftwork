#!/usr/bin/env node
// Stands in for `shiftwork run` in the extension tests: it publishes a runner
// state with one ticket in progress and waits for the STOP file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openRunState } from "shiftwork-core";

const root = process.cwd();
const state = openRunState(root);

await state.update({
	pid: process.pid,
	running: true,
	startedAt: new Date().toISOString(),
	feature: process.argv.includes("--feature") ? process.argv[process.argv.indexOf("--feature") + 1] : null,
	ticket: { feature: "demo", number: "07", title: "Widget ticket", path: join(root, ".scratch/demo/issues/07-widget.md") },
	shift: 2,
	attempt: 1,
	model: "stub/model-x",
	thinking: "low",
	budget: { maxTokens: 100000, maxCostUsd: 2 },
	usage: { tokens: 12000, costUsd: 0.4, turns: 3, contextPct: 31 },
});

const deadline = Date.now() + 60_000;
while (!existsSync(join(root, "STOP")) && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 100));
}

await state.update({
	running: false,
	finishedAt: new Date().toISOString(),
	ticket: null,
	stoppedReason: "STOP file",
	summary: { resolved: 1, needsInfo: 0 },
});
