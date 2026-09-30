import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { detectTracker, openOpenSpecTracker, openRepoTracker, runFrontier } from "../src/index.js";
import { fakeBackend, fileVerify } from "./fake-backend.js";
import { makeOpenSpecRepo, makeRepo } from "./helpers.js";

const TASKS = [
	"# Tasks",
	"",
	"## 1. Foundations",
	"",
	"- [ ] 1.1 Create the schema",
	"- [ ] 1.2 Seed the data",
	"",
	"## 2. API",
	"",
	"- [ ] 2.1 Add the endpoint",
	"",
].join("\n");

const statePath = (root, change) => join(root, "openspec", "changes", change, ".shiftwork.md");
const tasksPath = (root, change) => join(root, "openspec", "changes", change, "tasks.md");

test("each unchecked task is a ticket blocked by the previous task, across sections", async () => {
	const root = await makeOpenSpecRepo({ "add-auth": { tasks: TASKS } });
	const tracker = openOpenSpecTracker(root);
	const tickets = await tracker.list();

	assert.deepEqual(tickets.map((t) => t.number), ["1.1", "1.2", "2.1"]);
	assert.deepEqual(tickets.map((t) => t.blockedBy), [[], ["1.1"], ["1.2"]]);
	assert.deepEqual(tickets.map((t) => t.status), ["ready-for-agent", "ready-for-agent", "ready-for-agent"]);
	assert.equal(tickets[0].feature, "add-auth");
	assert.equal(tickets[0].title, "Create the schema");
	assert.deepEqual(tickets[0].checkboxes, [{ done: false, text: "Create the schema" }]);

	assert.deepEqual((await tracker.frontier()).map((t) => t.number), ["1.1"]);
});

test("a checked box is a resolved ticket and unblocks the next task", async () => {
	const root = await makeOpenSpecRepo({ "add-auth": { tasks: TASKS.replace("- [ ] 1.1", "- [x] 1.1") } });
	const tracker = openOpenSpecTracker(root);

	assert.deepEqual((await tracker.list()).map((t) => t.status), ["resolved", "ready-for-agent", "ready-for-agent"]);
	assert.deepEqual((await tracker.frontier()).map((t) => t.number), ["1.2"]);
});

test("the verify gate is openspec.verify plus the task's own Verify line, <change> substituted", async () => {
	const root = await makeOpenSpecRepo({
		"add-auth": { tasks: "- [ ] 1.1 Create the schema\n  - Verify: `npm test -- schema` · `npm run lint`\n- [ ] 1.2 Seed\n" },
	});

	const withDefault = await openOpenSpecTracker(root).list();
	assert.deepEqual(withDefault[0].verify, ["openspec validate add-auth", "npm test -- schema", "npm run lint"]);
	assert.deepEqual(withDefault[1].verify, ["openspec validate add-auth"]);

	const custom = await openOpenSpecTracker(root, { verify: ["pnpm check <change>"] }).list();
	assert.deepEqual(custom[0].verify, ["pnpm check add-auth", "npm test -- schema", "npm run lint"]);
});

test("claim, status and comments live in .shiftwork.md, one section per task; tasks.md is untouched", async () => {
	const root = await makeOpenSpecRepo({ "add-auth": { tasks: TASKS } });
	const tracker = openOpenSpecTracker(root);
	const [first] = await tracker.frontier();

	const claim = await tracker.claim(first);
	assert.ok(claim);
	assert.equal(await tracker.claim(first), null);

	let state = await readFile(statePath(root, "add-auth"), "utf8");
	assert.match(state, /^# Shiftwork: add-auth\n/);
	assert.match(state, /## 1\.1\n\n\*\*Status:\*\* claimed\n$/);

	await tracker.appendComment(claim, "### Shift 1 — pi fake/m1 (low)\n- Ended: ok");
	await tracker.setStatus(claim, "needs-info");

	state = await readFile(statePath(root, "add-auth"), "utf8");
	assert.match(state, /## 1\.1\n\n\*\*Status:\*\* needs-info\n\n### Shift 1 — pi fake\/m1 \(low\)\n- Ended: ok\n/);

	const [after] = await tracker.list();
	assert.equal(after.status, "needs-info");
	assert.equal(after.lastRoute, "fake/m1");

	// tasks.md keeps its bytes; the second task got no section.
	assert.equal(await readFile(tasksPath(root, "add-auth"), "utf8"), TASKS);
	assert.equal(state.includes("## 1.2"), false);

	await tracker.release(claim);
	assert.deepEqual(await tracker.activeClaims(), []);
});

test("a claim left by a dead process is taken over", async () => {
	const root = await makeOpenSpecRepo({ "add-auth": { tasks: TASKS } });
	const tracker = openOpenSpecTracker(root);
	const [first] = await tracker.frontier();
	await tracker.claim(first, { pid: await deadPid() });

	const [orphan] = await tracker.frontier();
	const claim = await tracker.claim(orphan);

	assert.equal(orphan.number, "1.1");
	assert.ok(claim);
	assert.equal(claim.pid, process.pid);
});

test("resolving a task ticks its checkbox and unblocks the next task", async () => {
	const root = await makeOpenSpecRepo({ "add-auth": { tasks: `${TASKS}- [ ] 1.10 Late task\n` } });
	const tracker = openOpenSpecTracker(root);
	const [first] = await tracker.frontier();
	const claim = await tracker.claim(first);

	await tracker.setStatus(claim, "resolved");

	const tasks = await readFile(tasksPath(root, "add-auth"), "utf8");
	assert.match(tasks, /- \[x\] 1\.1 Create the schema/);
	assert.match(tasks, /- \[ \] 1\.10 Late task/);
	const state = await readFile(statePath(root, "add-auth"), "utf8");
	assert.match(state, /## 1\.1\n\n\*\*Status:\*\* resolved/);

	assert.deepEqual((await tracker.frontier()).map((t) => t.number), ["1.2"]);
});

test("the archive folder and hidden folders are ignored", async () => {
	const root = await makeOpenSpecRepo({
		"archive/old-change": { tasks: "- [ ] 1.1 Old task\n" },
		"live-change": { tasks: "- [ ] 1.1 New task\n" },
	});
	const tracker = openOpenSpecTracker(root);

	assert.deepEqual((await tracker.list()).map((t) => t.feature), ["live-change"]);
	assert.deepEqual((await tracker.frontier()).map((t) => t.title), ["New task"]);
});

test("auto-detection prefers .scratch when both exist, unless tracker is set", async () => {
	const both = await makeOpenSpecRepo({ c: { tasks: "- [ ] 1.1 X\n" } });
	await mkdir(join(both, ".scratch"));

	assert.equal(await detectTracker(both), "scratch");
	assert.equal(await detectTracker(both, { tracker: "openspec" }), "openspec");
	assert.equal(await detectTracker(both, { tracker: "scratch" }), "scratch");

	const onlyOpenSpec = await makeOpenSpecRepo({ c: { tasks: "- [ ] 1.1 X\n" } });
	assert.equal(await detectTracker(onlyOpenSpec), "openspec");

	const empty = await makeRepo({});
	assert.equal(await detectTracker(empty), "scratch");

	// openRepoTracker follows the same decision.
	const tracker = await openRepoTracker(both, { tracker: "openspec", openspec: { verify: ["done.txt"] } });
	const [t] = await tracker.list();
	assert.equal(t.feature, "c");
	assert.deepEqual(t.verify, ["done.txt"]);
});

test("a runner with the fake backend works an OpenSpec change end to end", async () => {
	const root = await makeOpenSpecRepo({
		"add-auth": {
			tasks: [
				"# Tasks",
				"",
				"## 1. Foundations",
				"",
				"- [ ] 1.1 Create the schema",
				"  - Verify: `schema.txt`",
				"- [ ] 1.2 Seed the data",
				"",
				"## 2. API",
				"",
				"- [ ] 2.1 Add the endpoint",
				"  - Verify: `api.txt`",
				"",
			].join("\n"),
		},
	});
	const backend = fakeBackend([
		{ files: { "done.txt": "ok", "schema.txt": "ok" }, text: "Schema." },
		{ text: "Seed." },
		{ files: { "api.txt": "ok" }, text: "API." },
	]);
	const tracker = await openRepoTracker(root, { tracker: "openspec", openspec: { verify: ["done.txt"] } });

	const summary = await runFrontier({
		root,
		tracker,
		backend,
		verify: fileVerify(),
		config: { model: "fake/m1", thinking: "low", maxAttempts: 2 },
		options: {},
	});

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["1.1", "1.2", "2.1"]);
	assert.equal(backend.shifts.length, 3);
	assert.match(backend.shifts[0].request.prompt, /add-auth\/1\.1: Create the schema/);

	const tasks = await readFile(tasksPath(root, "add-auth"), "utf8");
	assert.match(tasks, /- \[x\] 1\.1/);
	assert.match(tasks, /- \[x\] 1\.2/);
	assert.match(tasks, /- \[x\] 2\.1/);

	const state = await readFile(statePath(root, "add-auth"), "utf8");
	assert.match(state, /## 1\.1\n\n\*\*Status:\*\* resolved\n\n### Shift 1 — pi fake\/m1 \(low\)[\s\S]*?Verify: passed/);
	assert.match(state, /## 1\.2\n\n\*\*Status:\*\* resolved\n\n### Shift 2 — pi fake\/m1 \(low\)/);
	assert.match(state, /## 2\.1\n\n\*\*Status:\*\* resolved\n\n### Shift 3 — pi fake\/m1 \(low\)/);
});

function deadPid() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", ""]);
		child.on("exit", () => resolve(child.pid));
	});
}
