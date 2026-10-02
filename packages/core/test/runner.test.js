import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openCooldowns, openRunState, openTracker, runFrontier, shouldReview, validateConfig } from "../src/index.js";
import { REVIEWER_PROMPT, REVIEW_WRAP_UP_PROMPT, SOFT_LIMIT_STEER, STOP_STEER, WORKER_PROMPT } from "../src/prompt.js";
import { formatDuration, reviewUnfinished } from "../src/runner.js";
import { fakeBackend, fileVerify } from "./fake-backend.js";
import { makeRepo, ticket } from "./helpers.js";

const config = { model: "fake/m1", thinking: "low", maxAttempts: 2 };

async function run(root, backend, options = {}) {
	return runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config, options });
}

async function ticketText(root, feature, file) {
	return readFile(`${root}/.scratch/${feature}/issues/${file}`, "utf8");
}

/** The `<feature>/<number>` of every shift the backend started, in start order. */
function workedIds(backend) {
	return backend.shifts.map((s) => {
		const match = s.request.prompt.match(/\.scratch\/([^/]+)\/issues\/(\d+)-/);
		assert.ok(match, `no ticket in prompt: ${s.request.prompt.slice(0, 200)}`);
		return `${match[1]}/${match[2]}`;
	});
}

/** A refused --ticket wrote nothing: the ticket file is unchanged, no claim, no run state. */
async function assertNothingWritten(root, feature, file) {
	const text = await ticketText(root, feature, file);
	assert.doesNotMatch(text, /## Comments/);
	assert.doesNotMatch(text, /### Shift/);
	assert.equal(existsSync(join(root, ".scratch", ".claims")), false);
	assert.equal(existsSync(join(root, ".pi", "shiftwork-run.json")), false);
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

test("the runner stays on a feature until it has nothing ready (a/01, a/02, then b/01)", async () => {
	const root = await makeRepo({
		"a/01-a.md": ticket("01", "A", { extra: "**Verify:** `a1.txt`" }),
		"a/02-a.md": ticket("02", "A2", { blockedBy: "01", extra: "**Verify:** `a2.txt`" }),
		"b/01-b.md": ticket("01", "B", { extra: "**Verify:** `b1.txt`" }),
	});
	const backend = fakeBackend([{ files: { "a1.txt": "" } }, { files: { "a2.txt": "" } }, { files: { "b1.txt": "" } }]);

	const summary = await run(root, backend);

	// It does not jump to b/01 after a/01: the current feature's next ready ticket wins.
	assert.deepEqual(workedIds(backend), ["a/01", "a/02", "b/01"]);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01", "02", "01"]);
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

test("--ticket works exactly the chosen ticket, not the frontier order", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = fakeBackend([{ files: { "b.txt": "" } }]);

	const summary = await run(root, backend, { ticket: "f/02" });

	assert.equal(backend.shifts.length, 1);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["02"]);
	assert.match(await ticketText(root, "f", "02-b.md"), /\*\*Status:\*\* resolved/);
	assert.match(await ticketText(root, "f", "01-a.md"), /\*\*Status:\*\* ready-for-agent/);
});

test("--ticket refuses a blocked ticket with its reason, and nothing is claimed or written", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { blockedBy: "01", extra: "**Verify:** `b.txt`" }),
	});
	const backend = fakeBackend([]);

	await assert.rejects(run(root, backend, { ticket: "f/02" }), /--ticket f\/02 is not on the frontier: blocked by 01/);
	assert.equal(backend.shifts.length, 0);
	assertNothingWritten(root, "f", "02-b.md");
});

test("--ticket refuses a resolved ticket with its reason, and nothing is claimed or written", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { status: "resolved" }),
	});
	const backend = fakeBackend([]);

	await assert.rejects(run(root, backend, { ticket: "f/01" }), /--ticket f\/01 is not on the frontier: status resolved/);
	assert.equal(backend.shifts.length, 0);
	assertNothingWritten(root, "f", "01-a.md");
});

test("a paused feature leaves the frontier: run works only other features", async () => {
	const root = await makeRepo({
		"a/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"a/spec.md": "# Spec: A\n\n**Status:** paused\n",
		"b/01-b.md": ticket("01", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = fakeBackend([{ files: { "b.txt": "" } }]);

	const summary = await run(root, backend);

	assert.deepEqual(workedIds(backend), ["b/01"]);
	assert.deepEqual(summary.resolved.map((t) => `${t.feature}/${t.number}`), ["b/01"]);
	assert.match(await ticketText(root, "a", "01-a.md"), /\*\*Status:\*\* ready-for-agent/);
});

test("--ticket and --feature on a paused feature are refused, and nothing is claimed or written", async () => {
	const root = await makeRepo({
		"a/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"a/spec.md": "# Spec: A\n\n**Status:** paused\n",
	});
	const backend = fakeBackend([]);

	await assert.rejects(run(root, backend, { ticket: "a/01" }), /feature a is paused \(shiftwork feature resume a\)/);
	await assert.rejects(run(root, backend, { feature: "a" }), /feature a is paused \(shiftwork feature resume a\)/);
	assert.equal(backend.shifts.length, 0);
	assertNothingWritten(root, "a", "01-a.md");
});

test("--ticket refuses a ticket claimed by a live runner with its reason", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
	});
	const backend = fakeBackend([]);
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		const tracker = openTracker(root);
		const t01 = (await tracker.list()).find((t) => t.number === "01");
		await tracker.claim(t01, { pid: holder.pid });

		await assert.rejects(
			run(root, backend, { ticket: "f/01" }),
			new RegExp(`--ticket f/01 is not on the frontier: claimed by pid ${holder.pid}`),
		);
	} finally {
		holder.kill();
	}
	assert.equal(backend.shifts.length, 0);
	// The refused run appended no shift report and wrote no run state; the claim stays as it was.
	assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /### Shift/);
	assert.equal(existsSync(join(root, ".pi", "shiftwork-run.json")), false);
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

function fakeWorkspace({ landOk = true, land, changed = true, diffStat = "", discarded = [] } = {}) {
	const calls = [];
	// One worktree per ticket, kept across rounds (a reopen) and dropped only by a redo,
	// as the real git workspace keeps and drops them.
	const worktrees = new Map();
	return {
		calls,
		async target() {
			return "main";
		},
		async hasChanges() {
			return changed;
		},
		async redo(t) {
			calls.push(["redo", t.number]);
			worktrees.delete(`${t.feature}/${t.number}`);
		},
		async diffStat() {
			return typeof diffStat === "function" ? diffStat() : diffStat;
		},
		async prepare(t) {
			calls.push(["prepare", t.number]);
			const key = `${t.feature}/${t.number}`;
			if (!worktrees.has(key)) {
				const { mkdtemp } = await import("node:fs/promises");
				const { tmpdir } = await import("node:os");
				worktrees.set(key, await mkdtemp(`${tmpdir()}/sw-ws-`));
			}
			this.cwd = worktrees.get(key);
			return { cwd: this.cwd };
		},
		async commit(t) {
			calls.push(["commit", t.number]);
			return true;
		},
		async land(t) {
			calls.push(["land", t.number]);
			if (land) return land(t);
			return landOk ? { ok: true, message: "merged" } : { ok: false, message: "merge conflict in README.md" };
		},
		async discardAfterReview(t) {
			calls.push(["discardAfterReview", t.number]);
			return typeof discarded === "function" ? discarded() : discarded;
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

test("a landing whose target moved is rebased, re-verified and lands again", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const lands = [
		{ ok: false, rebase: "abc1234", message: "the target moved to abc1234: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: true, message: "merged shiftwork/f-01 into main" },
	];
	const gates = [];
	const verify = async (cmds, cwd) => {
		gates.push(cwd);
		return fileVerify()(cmds, cwd);
	};
	const workspace = fakeWorkspace({ land: () => lands.shift() });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(gates.length, 2, "the gate runs again on the rebased worktree");
	assert.ok(!workspace.calls.some(([op]) => op === "discardAfterReview"), "no review ran, so nothing is discarded in the rebase round");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Target moved to abc1234: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Landed: merged shiftwork\/f-01 into main/);
});

test("a landing whose target moved fails needs-info when the gate fails on the rebased branch", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "v1" } }]);
	// The gate passes on the branch, then fails on the integrated state after the rebase.
	let gates = 0;
	const verify = async (cmds) =>
		++gates === 1 ? { ok: true, results: [{ cmd: cmds[0], code: 0 }] } : { ok: false, results: [{ cmd: cmds[0], code: 1, outputTail: "" }] };
	const workspace = fakeWorkspace({
		land: () => ({ ok: false, rebase: "abc1234", message: "the target moved to abc1234: branch rebased onto it; re-verify and land again" }),
	});

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.equal(gates, 2);
	assert.equal(summary.needsInfo[0].reason, "verify gate failed on the branch rebased onto abc1234 (`done.txt`)");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Target moved to abc1234: branch rebased onto it, verify gate re-run: failed at `done.txt` \(1\)/);
	assert.match(text, /\*\*Status:\*\* needs-info/);
});

test("a target that keeps moving is re-verified and landed again until it stands still", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	const lands = [
		{ ok: false, rebase: "1111111", message: "the target moved to 1111111: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: false, rebase: "2222222", message: "the target moved to 2222222: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: true, message: "merged shiftwork/f-01 into main" },
	];
	let gates = 0;
	const verify = async (cmds, cwd) => {
		gates++;
		return fileVerify()(cmds, cwd);
	};
	const workspace = fakeWorkspace({ land: () => lands.shift() });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(gates, 3, "the gate re-runs on every rebased worktree");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Target moved to 1111111: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Target moved to 2222222: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Landed: merged shiftwork\/f-01 into main/);
});

test("a gate that fails on a later rebase still gives the rebased-branch reason", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "v1" } }]);
	// The gate passes on the branch and on the first rebased state, then fails on the second.
	const lands = [
		{ ok: false, rebase: "1111111", message: "the target moved to 1111111: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: false, rebase: "2222222", message: "the target moved to 2222222: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
	];
	let gates = 0;
	const verify = async (cmds) =>
		++gates === 3 ? { ok: false, results: [{ cmd: cmds[0], code: 1, outputTail: "" }] } : { ok: true, results: [{ cmd: cmds[0], code: 0 }] };
	const workspace = fakeWorkspace({ land: () => lands.shift() });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.equal(gates, 3);
	assert.equal(summary.needsInfo[0].reason, "verify gate failed on the branch rebased onto 2222222 (`done.txt`)");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Target moved to 1111111: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Target moved to 2222222: branch rebased onto it, verify gate re-run: failed at `done\.txt` \(1\)/);
});

test("a target that never stops moving gives up after landRetries rounds and keeps the branch", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	let lands = 0;
	const moved = () => ({ ok: false, rebase: "abc1234", message: "the target moved to abc1234: branch shiftwork/f-01 rebased onto it; re-verify and land again" });
	const workspace = fakeWorkspace({ land: () => (lands++, moved()) });
	let gates = 0;
	const verify = async (cmds, cwd) => {
		gates++;
		return fileVerify()(cmds, cwd);
	};

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.equal(lands, 6, "the first landing plus one more per round");
	assert.equal(gates, 6, "the initial gate plus one re-run per round");
	assert.equal(
		summary.needsInfo[0].reason,
		"the target kept moving (5 rebases); branch shiftwork/f-01 kept — land it with shiftwork run --ticket f/01 or merge it by hand",
	);
	const text = await ticketText(root, "f", "01-a.md");
	assert.equal((text.match(/- Target moved to abc1234/g) ?? []).length, 5, "one note per round");
	assert.match(text, /\*\*Status:\*\* needs-info/);
});

test("landRetries: 0 stops at the first move of the target without re-verifying", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }]);
	let lands = 0;
	let gates = 0;
	const verify = async (cmds, cwd) => {
		gates++;
		return fileVerify()(cmds, cwd);
	};
	const workspace = fakeWorkspace({
		land: () => (lands++, { ok: false, rebase: "abc1234", message: "the target moved to abc1234: branch shiftwork/f-01 rebased onto it; re-verify and land again" }),
	});

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config: { ...config, landRetries: 0 }, workspace });

	assert.equal(lands, 1, "a single try: the first landing is the only one");
	assert.equal(gates, 1, "the gate never re-runs");
	assert.equal(
		summary.needsInfo[0].reason,
		"the target kept moving (0 rebases); branch shiftwork/f-01 kept — land it with shiftwork run --ticket f/01 or merge it by hand",
	);
	const text = await ticketText(root, "f", "01-a.md");
	assert.doesNotMatch(text, /- Target moved/);
	assert.match(text, /- Branch kept: shiftwork\/f-01/);
});

test("a conflicting landing gets one fix-forward shift from the new target", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "v1" } }, { files: { "done.txt": "v2" } }]);
	const lands = [
		{ ok: false, conflict: { files: ["done.txt"], commit: "abc1234" }, message: "merge conflict in done.txt with the landed abc1234; branch shiftwork/f-01 kept" },
		{ ok: true, message: "merged shiftwork/f-01 into main" },
	];
	const workspace = fakeWorkspace({ land: () => lands.shift() });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config, workspace });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2, "one more shift after the conflict");
	assert.deepEqual(workspace.calls, [["prepare", "01"], ["land", "01"], ["redo", "01"], ["prepare", "01"], ["land", "01"]]);
	assert.notEqual(backend.shifts[1].request.cwd, backend.shifts[0].request.cwd, "the fix-forward shift runs in a fresh worktree");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Landing conflict with done\.txt; redone on top of abc1234/);
	// The conflicted shift's report must not claim the ticket resolved.
	assert.match(text.split("### Shift 2")[0], /- Outcome: redo on the new target \(landing conflict\)/);
	assert.match(text, /### Shift 2[\s\S]*- Landed: merged shiftwork\/f-01 into main/);
});

test("a second landing conflict goes to needs-info with the conflict files in the reason", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ files: { "done.txt": "v1" } }, { files: { "done.txt": "v2" } }]);
	const conflict = () => ({
		ok: false,
		conflict: { files: ["done.txt"], commit: "abc1234" },
		message: "merge conflict in done.txt with the landed abc1234; branch shiftwork/f-01 kept",
	});
	const workspace = fakeWorkspace({ land: conflict });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config, workspace });

	assert.equal(summary.needsInfo.length, 1);
	assert.equal(
			summary.needsInfo[0].reason,
			"verify gate passed but landing failed: merge conflict in done.txt with the landed abc1234; branch shiftwork/f-01 kept",
	);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* needs-info/);
	assert.match(text, /- Landing conflict with done\.txt; redone on top of abc1234/);
	assert.match(text, /### Shift 2[\s\S]*needs-info: verify gate passed but landing failed: merge conflict in done\.txt/);
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

test("a ticket past its turns budget is not ended when the next route lifts it", async () => {
	const liftConfig = {
		defaultType: "code",
		thinking: "low",
		maxAttempts: 3,
		maxHandoffs: 3,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1", "fake/m2"], thinking: "low", budget: { maxTurns: 2 } } },
		models: { "fake/m2": { unlimited: ["turns"] } },
		onExceed: { maxTurns: { to: "next", mode: "new-process" } },
		budgets: { default: {}, tiers: {}, models: {}, ticket: {} },
	};
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Budget:** 2 turns\n**Verify:** `done.txt`" }) });
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

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: liftConfig });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.route.model, "fake/m1");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
	const text = await ticketText(root, "f", "01-a.md");
	assert.doesNotMatch(text, /### Handoff blocked/);
	assert.match(text, /### Shift 2 — pi fake\/m2/);
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
	const backend = fakeBackend([{}]);
	const verify = async () => ({ ok: true, results: [{ cmd: "npm test", code: 0, outputTail: "" }] });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config, workspace });

	assert.deepEqual(summary.resolved, []);
	assert.match(summary.needsInfo[0].reason, /no shift changed anything/);
	assert.ok(!workspace.calls.some(([op]) => op === "land"));
});

test("a provider limit before any change hands the ticket to the next model, even when the gate already passes", async () => {
	const cfg = chainTwoProviders();
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	let changed = false;
	const workspace = { ...fakeWorkspace(), async hasChanges() { return changed; } };
	const backend = fakeBackend([
		{ error: 'error: 402: {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}' },
		{ files: { "done.txt": "ok" } },
	]);
	const verify = async () => {
		const ok = true;
		if (backend.shifts.length === 2) changed = true;
		return { ok, results: [{ cmd: "npm test", code: 0, outputTail: "" }] };
	};

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config: cfg, workspace });

	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[1].request.route.model, "other/m2");
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const state = JSON.parse(await readFile(`${root}/.pi/shiftwork-state.json`, "utf8"));
	assert.equal(state.cooldowns[0].kind, "quota");
	assert.match(await ticketText(root, "f", "01-a.md"), /Provider limit: quota on fake/);
});

test("a shift cut short by a budget with nothing changed is handed on, even when the gate already passes", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `npm test`" }) });
	let changed = false;
	const workspace = { ...fakeWorkspace(), async hasChanges() { return changed; } };
	const backend = fakeBackend([{ events: [turn, turn, { type: "end", stopReason: "stop" }] }, { events: [{ type: "end", stopReason: "stop" }] }]);
	// The gate passes before any work (it doesn't test the ticket); the second shift makes a change.
	const verify = async () => {
		if (backend.shifts.length === 2) changed = true;
		return { ok: true, results: [{ cmd: "npm test", code: 0, outputTail: "" }] };
	};

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config: chainConfig("new-process"), workspace });

	assert.equal(backend.shifts.length, 2, "the budget handoff goes ahead");
	assert.equal(backend.shifts[1].request.route.model, "fake/m2");
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Handoff — shift 1, fake\/m1 → fake\/m2, reason: budget\.maxTurns/);
	assert.doesNotMatch(text, /no shift changed anything/);
});

test("a shift that ends on its own with nothing changed and a passing gate still needs info", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `npm test`" }) });
	const workspace = fakeWorkspace({ changed: false });
	const backend = fakeBackend([{ events: [turn, { type: "end", stopReason: "stop" }] }]);
	const verify = async () => ({ ok: true, results: [{ cmd: "npm test", code: 0, outputTail: "" }] });

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify, config: chainConfig("new-process"), workspace });

	assert.equal(backend.shifts.length, 1);
	assert.match(summary.needsInfo[0].reason, /no shift changed anything/);
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
		review: false,
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
		review: false,
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
		review: false,
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
		review: false,
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
			review: false,
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

/** A review config whose review tier has a chain to retry on: ["fake/r1", "fake/r2"]. */
function retryReviewConfig(review = {}) {
	const config = reviewConfig(review);
	return { ...config, tiers: { ...config.tiers, premium: { chain: ["fake/r1", "fake/r2"], thinking: "high" } } };
}

const reviewMarker = (verdict, reason) => `<shiftwork:review verdict="${verdict}" reason="${reason}"/>`;

/** A scripted backend keyed by `<feature>/<NN>`: each ticket's shifts consume that ticket's
 * own script, in order, whatever order parallel workers finish in. */
function ticketScriptBackend(scripts) {
	const queues = new Map(Object.entries(scripts).map(([key, script]) => [key, [...script]]));
	const shifts = [];
	return {
		name: "fake",
		shifts,
		async startShift(request) {
			const match = request.prompt.match(/\.scratch\/([^/]+)\/issues\/(\d+)-/);
			assert.ok(match, `no ticket in prompt: ${request.prompt.slice(0, 200)}`);
			const key = `${match[1]}/${match[2]}`;
			const inner = fakeBackend([queues.get(key)?.shift() ?? { text: "Nothing to do." }]);
			const shift = await inner.startShift(request);
			shifts.push(...inner.shifts);
			return shift;
		},
	};
}

test("shouldReview is on by default on the strongest configured tier and respects the features/types filters", () => {
	const on = validateConfig({ model: "fake/m1", tiers: { quick: { chain: ["fake/q"] }, premium: { chain: ["fake/r"] } } });
	assert.equal(on.review.enabled, true);
	assert.equal(on.review.tier, "premium");
	assert.equal(shouldReview(on, { feature: "f", type: "code" }), true);
	// No tiers at all: nothing to review on, so reviews stay off.
	assert.equal(shouldReview(validateConfig({ model: "fake/m1" }), { feature: "f", type: "code" }), false);
	// Both orders review: `when` decides only where the review runs, never whether.
	const base = { review: { enabled: true, tier: "premium", when: "before-land" } };
	assert.equal(shouldReview(base, { feature: "f", type: "code" }), true);
	assert.equal(shouldReview({ review: { ...base.review, when: "after-land" } }, { feature: "f", type: "code" }), true);
	assert.equal(shouldReview({ review: { ...base.review, features: ["g"] } }, { feature: "f", type: "code" }), false);
	assert.equal(shouldReview({ review: { ...base.review, features: ["f"] } }, { feature: "f", type: "code" }), true);
	assert.equal(shouldReview({ review: { ...base.review, types: ["git"] } }, { feature: "f", type: "code" }), false);
	assert.equal(shouldReview({ review: { ...base.review, types: ["git"] } }, { feature: "f", type: "git" }), true);
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
	// Repo-relative, so the ticket reads the same in every checkout.
	assert.match(created, /"### Review" block in \.scratch\/f\/issues\/01-a\.md\./);
});

test("a review without the marker is retried once on the next chain model; a second miss is no silent accept", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: "Still investigating, no verdict yet." },
		{ text: "Ran out of time, still no verdict." },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig() });

	assert.equal(summary.exitCode, 2);
	assert.deepEqual(summary.resolved, []);
	assert.deepEqual(summary.needsInfo.map((t) => t.number), ["01"]);
	assert.equal(summary.needsInfo[0].reason, "review gave no verdict twice; review it by hand");
	assert.equal(backend.shifts.length, 3, "one worker shift, two review shifts");
	assert.equal(backend.shifts[1].request.route.model, "fake/r1");
	assert.equal(backend.shifts[2].request.route.model, "fake/r2", "the retry runs on the next model of the review tier's chain");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* needs-info/);
	assert.match(text, /### Review — pi fake\/r1 \(high\), retried on pi fake\/r2 \(high\)/);
	assert.match(text, /- Verdict: none — review gave no verdict twice; review it by hand/);
	assert.match(text, /- Warning: fake\/r1: review ended without a verdict marker/);
	assert.match(text, /- Warning: fake\/r2: review ended without a verdict marker/);
	assert.match(text, /<shiftwork:needs-info reason="review gave no verdict twice; review it by hand"\/>/);
});

test("a valid marker on the retry is recorded normally, with the first miss as a warning", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: "Still investigating, no verdict yet." },
		{ text: `Checked it all.\n\n${reviewMarker("accept", "matches the spec")}` },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig() });

	assert.equal(summary.exitCode, 0);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts[2].request.route.model, "fake/r2");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /### Review — pi fake\/r1 \(high\), retried on pi fake\/r2 \(high\)/);
	assert.match(text, /- Verdict: accept — matches the spec/);
	assert.match(text, /- Warning: fake\/r1: review ended without a verdict marker/);
	assert.doesNotMatch(text, /- Verdict: none/);
});

test("a single-model review chain retries on its only model, in a fresh context", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: "No verdict, sorry." },
		{ text: "Still no verdict." },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.deepEqual(summary.needsInfo.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 3);
	assert.equal(backend.shifts[1].request.route.model, "fake/r1");
	assert.equal(backend.shifts[2].request.route.model, "fake/r1", "the retry is a fresh context on the only model");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Review — pi fake\/r1 \(high\)\n/);
	assert.match(text, /- Verdict: none — review gave no verdict twice; review it by hand/);
});

test("an unknown verdict word counts as no verdict and is retried like a missing marker", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("reject", "not a verdict") },
		{ text: reviewMarker("maybe", "also not a verdict") },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig() });

	assert.deepEqual(summary.resolved, []);
	assert.deepEqual(summary.needsInfo.map((t) => t.number), ["01"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* needs-info/);
	assert.match(text, /- Verdict: none — review gave no verdict twice; review it by hand/);
	assert.match(text, /- Warning: fake\/r1: unknown review verdict "reject"/);
	assert.match(text, /- Warning: fake\/r2: unknown review verdict "maybe"/);
	assert.doesNotMatch(text, /- Verdict: accept/);
});

test("at its soft limit a review shift gets the wrap-up prompt, never the worker handoff prompt", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const steered = [];
	const turn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{
			events: [turn, { ...turn }, { ...turn }, { ...turn }, { ...turn }, { type: "end", stopReason: "stop" }],
			steer: async (text) => {
				steered.push(text);
			},
		},
		// The budget-aborted review is retried once: it also gives no verdict.
		{ text: "No verdict from the retry either." },
	]);
	const config = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "low" }, premium: { chain: ["fake/r1", "fake/r2"], thinking: "high" } },
		softLimitPct: 60,
		unlimited: true,
		review: { enabled: true, tier: "premium", budget: { maxTurns: 5 } },
	});

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config });

	assert.deepEqual(steered, [REVIEW_WRAP_UP_PROMPT], "the review is told to wrap up, not to hand off");
	assert.ok(!steered.includes(SOFT_LIMIT_STEER));
});

test("a review stopped by the runner stopping is not a missing verdict: no retry, no needs-info", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const turn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		// The review shift itself stops the run: a STOP file lands mid-review, before any verdict.
		{
			files: { STOP: "stopped mid-review" },
			events: [turn, { type: "text", text: "Still checking the diff." }, turn, turn],
		},
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig() });

	// The stop is not a missing verdict: the retry on the next model is not spent, and the ticket is not needs-info.
	assert.equal(backend.shifts.length, 2, "one worker shift, one review shift, no retry");
	assert.equal(summary.stoppedReason, "STOP file");
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(summary.resolved[0].review.verdict, "stopped");
	assert.deepEqual(summary.needsInfo, []);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/, "the ticket stays as it was, so the next run reviews it again");
	assert.match(text, /### Review — pi fake\/r1 \(high\)\n- Review: not finished \(stopped\)/);
	assert.doesNotMatch(text, /- Verdict: none/);
	assert.doesNotMatch(text, /<shiftwork:needs-info/);
});

test("a review stopped mid-retry is recorded as not finished on the retried model", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const turn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		// The first review gives no verdict; the STOP file lands before the retry can finish.
		{ text: "Still investigating, no verdict yet." },
		{
			files: { STOP: "stopped mid-retry" },
			events: [turn, { type: "text", text: "Halfway through the retry." }, turn, turn],
		},
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig() });

	assert.equal(backend.shifts.length, 3, "the retry was already running when the stop landed");
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(summary.resolved[0].review.verdict, "stopped");
	assert.deepEqual(summary.needsInfo, []);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Review — pi fake\/r1 \(high\), retried on pi fake\/r2 \(high\)\n- Review: not finished \(stopped\)/);
	assert.doesNotMatch(text, /- Verdict: none/);
	assert.doesNotMatch(text, /<shiftwork:needs-info/);
});

/** A resolved ticket whose last review never finished (stopped, or no reviewer free): the
 * verdict the next run owes, re-reviewed before any new work. */
function owedReviewTicket({ verdict = null, feature = "f", number = "01" } = {}) {
	const review = [
		"### Review — pi fake/r1 (high)",
		...(verdict ? [`- Verdict: ${verdict}`] : ["- Review: not finished (stopped)"]),
		"- Time: 2m 0s",
	].join("\n");
	return ticket(number, "A", {
		status: "resolved",
		extra: `**Type:** code\n**Verify:** \`done.txt\`\n\n## Comments\n\n- Landed: merged shiftwork/${feature}-${number} into main\n\n${review}`,
	});
}

test("reviewUnfinished: only the last review section's own status line, with no verdict", () => {
	assert.equal(reviewUnfinished("### Review — pi fake/r1 (high)\n- Review: not finished (stopped)\n- Time: 2m 0s"), true);
	assert.equal(reviewUnfinished("### Review\n- Not run: every premium model is cooling until later\n- Review: not finished (no reviewer free this run)"), true);
	assert.equal(
		reviewUnfinished("### Review — pi fake/r1 (high)\n- Review: not finished (stopped)\n\n### Review — pi fake/r1 (high)\n- Verdict: accept — fine\n- Time: 1m 0s"),
		false,
		"a later verdict ends the obligation",
	);
	assert.equal(
		reviewUnfinished("### Review — pi fake/r1 (high)\n- Verdict: accept — fine\n- Findings:\n\n> The earlier `- Review: not finished (stopped)` line is not a verdict."),
		false,
		"a quoted not-finished line in findings is not the section's status line",
	);
	assert.equal(reviewUnfinished("### Review — pi fake/r1 (high)\n- Findings:\n\n> - Review: not finished (stopped)"), false);
	assert.equal(reviewUnfinished(""), false, "no review section: nothing owed");
});

test("a resolved ticket whose last review never finished is re-reviewed before any new work; accept clears it", async () => {
	const root = await makeRepo({
		"f/01-a.md": owedReviewTicket(),
		"f/02-b.md": ticket("02", "B", { extra: "**Type:** code\n**Verify:** `done.txt`" }),
	});
	const backend = ticketScriptBackend({
		"f/01": [{ text: reviewMarker("accept", "the landed change is fine") }],
		"f/02": [{ files: { "done.txt": "ok" } }, { text: reviewMarker("accept", "fine") }],
	});

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	// The owed review runs first, before the frontier's new work.
	assert.deepEqual(workedIds(backend), ["f/01", "f/02", "f/02"]);
	assert.equal(backend.shifts[0].request.route.tier, "premium");
	assert.match(backend.shifts[0].request.prompt, /This is a resumed review: the ticket's earlier review never finished/);
	assert.match(
		backend.shifts[0].request.prompt,
		/- The change under review is the ticket's last `- Landed:` line in its Comments: merged shiftwork\/f-01 into main/,
	);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01", "02"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/, "accept only completes the review: the ticket stays resolved");
	assert.match(text, /- Review: not finished \(stopped\)[\s\S]*### Review[\s\S]*- Verdict: accept — the landed change is fine/);

	// The verdict is given: no later run reviews it again.
	const again = ticketScriptBackend({});
	await runFrontier({ root, tracker: openTracker(root), backend: again, verify: fileVerify(), config: reviewConfig() });
	assert.equal(again.shifts.length, 0);
});

test("a re-review that reopens puts the ticket back on the frontier; the same run fixes it forward", async () => {
	const root = await makeRepo({ "f/01-a.md": owedReviewTicket() });
	const backend = ticketScriptBackend({
		// The owed review reopens; the same run's worker shift fixes forward, and its own review accepts.
		"f/01": [
			{ text: reviewMarker("reopen", "the landed change misses the rule") },
			{ files: { "done.txt": "ok" } },
			{ text: reviewMarker("accept", "fixed now") },
		],
	});

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.deepEqual(workedIds(backend), ["f/01", "f/01", "f/01"]);
	assert.deepEqual(summary.reopened.map((t) => t.number), ["01"]);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /### Review[\s\S]*- Verdict: reopen — the landed change misses the rule[\s\S]*### Shift 1 — pi fake\/m1/);
	assert.match(text, /- Verdict: accept — fixed now/);
});

test("a re-review stopped again leaves the verdict owed to the next run", async () => {
	const root = await makeRepo({ "f/01-a.md": owedReviewTicket() });
	const turn = { type: "turn", usage: { input: 10, output: 0, totalTokens: 10 }, costUsd: 0.01 };
	const backend = fakeBackend([
		// The owed review is cut by a STOP file before any verdict.
		{ files: { STOP: "stopped mid-review" }, events: [turn, { type: "text", text: "Still checking the diff." }, turn, turn] },
	]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig() });

	assert.equal(summary.stoppedReason, "STOP file");
	assert.equal(backend.shifts.length, 1, "the stop is not a missing verdict: no retry");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/, "the ticket stays as it was");
	// The second not-finished section is the last one: the next run owes the verdict again.
	assert.match(text, /- Review: not finished \(stopped\)[\s\S]*### Review — pi fake\/r1 \(high\)\n- Review: not finished \(stopped\)/);
	assert.doesNotMatch(text, /- Verdict:/);
});

test("`--ticket` re-reviews nothing: it works exactly the chosen frontier ticket", async () => {
	const root = await makeRepo({
		"f/01-a.md": owedReviewTicket(),
		"f/02-b.md": ticket("02", "B", { extra: "**Type:** code\n**Verify:** `done.txt`" }),
	});
	const backend = ticketScriptBackend({
		"f/02": [{ files: { "done.txt": "ok" } }, { text: reviewMarker("accept", "fine") }],
	});

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: reviewConfig(),
		options: { ticket: "f/02" },
	});

	assert.deepEqual(workedIds(backend), ["f/02", "f/02"]);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["02"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Review: not finished \(stopped\)/, "the owed review is untouched");
	assert.doesNotMatch(text, /- Verdict:/);
});

test("a re-review with no reviewer free keeps the verdict owed to the next run", async () => {
	const t0 = Date.parse("2026-01-01T00:00:00Z");
	const clock = fakeClock(t0);
	const root = await makeRepo({ "f/01-a.md": owedReviewTicket() });
	const store = openCooldowns(root);
	await store.add("fake", new Date(t0 + 3600_000), "rate", { at: new Date(t0) });
	const backend = fakeBackend([]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), clock, cooldowns: store });

	assert.equal(backend.shifts.length, 0, "no reviewer free: no review shift runs");
	assert.deepEqual(summary.resolved, [], "nothing is resolved by a re-review that does not run");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /### Review\n- Not run: every premium model is cooling until 2026-01-01T01:00:00\.000Z/);
	assert.match(text, /- Review: not finished \(no reviewer free this run\)/);
	assert.match(text, /\*\*Status:\*\* resolved/, "the ticket stays resolved");

	// The Not run note alone would end the obligation: the next run reviews it again.
	await store.remove("fake");
	const next = fakeBackend([{ text: reviewMarker("accept", "fine") }]);
	await runFrontier({ root, tracker: openTracker(root), backend: next, verify: fileVerify(), config: reviewConfig() });
	assert.equal(next.shifts.length, 1);
	assert.match(await ticketText(root, "f", "01-a.md"), /- Verdict: accept — fine/);
});

test("a review that quotes the not-finished line in its findings is finished: no re-review", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", {
			status: "resolved",
			extra:
			"**Type:** code\n**Verify:** `done.txt`\n\n## Comments\n\n### Review — pi fake/r1 (high)\n- Verdict: accept — fine\n- Time: 2m 0s\n- Findings:\n\n> The earlier `- Review: not finished (stopped)` line is not a verdict; the work is done.",
		}),
	});
	const backend = ticketScriptBackend({});

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig() });

	assert.equal(backend.shifts.length, 0, "a quoted not-finished line is not the section's own status line");
});

test("the review route's budget is review.budget, independent of ticket, tier and model budgets", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Budget:** $5 · 500 turns\n**Verify:** `done.txt`" }),
	});
	const config = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: {
			standard: { chain: ["fake/m1"], thinking: "low", budget: { maxTurns: 100, maxWallMin: 100 } },
			premium: { chain: ["fake/r1"], thinking: "high", budget: { maxTurns: 200, maxWallMin: 200 } },
		},
		budgets: { default: { maxTurns: 50 }, ticket: { maxTurns: 10 }, models: { "fake/r1": { maxTurns: 300 } } },
		models: { "fake/r1": { budget: { maxTurns: 400 } } },
		unlimited: true,
		review: { enabled: true, tier: "premium" },
	});
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }, { text: reviewMarker("accept", "ok") }]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config });

	// The review's own budget, default 20 min / 60 turns: no ticket, tier or model budget caps it, and no `unlimited` list lifts it.
	assert.deepEqual(backend.shifts[1].request.route.budget, { maxWallMin: 20, maxTurns: 60 });
	// The worker shift's budget is still the usual merge — here lifted entirely by `unlimited: true`.
	assert.deepEqual(backend.shifts[0].request.route.budget, {});
});

test("the reviewer prompt is local-only, wraps up at its soft limit and never asks for a handoff", () => {
	assert.match(
		REVIEWER_PROMPT,
		/Work locally: read the code, run the verify gate and the repo's tests\. Do not call network services or live APIs \(no `gh api`, `curl` or package installs\); judge external calls by the code and the tests' stubs\./,
	);
	assert.ok(REVIEWER_PROMPT.includes(REVIEW_WRAP_UP_PROMPT));
	// It reads the ticket's handoff notes, but never asks for one itself.
	assert.doesNotMatch(REVIEWER_PROMPT, /### Handoff/);
});

test("a config with no review block reviews every resolved ticket, on the strongest configured tier", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const config = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "low" }, premium: { chain: ["fake/r1"], thinking: "high" } },
	});
	const backend = fakeBackend([{ files: { "done.txt": "ok" } }, { text: reviewMarker("accept", "matches the spec") }]);

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[1].request.route.tier, "premium", "the default review tier is the strongest configured one");
	assert.equal(backend.shifts[1].request.route.model, "fake/r1");
	assert.match(await ticketText(root, "f", "01-a.md"), /### Review[\s\S]*- Verdict: accept — matches the spec/);
});

test("a config with `review: false` resolves without a review shift", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const config = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "low" }, premium: { chain: ["fake/r1"], thinking: "high" } },
		review: false,
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

test("when: \"after-land\" (and \"resolve\") keeps the old order: land first, then the review in the main repo", async () => {
	for (const when of ["after-land", "resolve"]) {
		const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
		const backend = fakeBackend([
			{ files: { "done.txt": "ok" } },
			{ text: reviewMarker("accept", "good") },
		]);
		const workspace = fakeWorkspace();
		const verify = async (commands) => ({ ok: true, results: commands.map((cmd) => ({ cmd, code: 0, outputTail: "" })) });

		await runFrontier({ root, tracker: openTracker(root), backend, verify, config: reviewConfig({ when }), workspace });

		assert.deepEqual(workspace.calls, [["prepare", "01"], ["land", "01"]], "the branch lands before the review runs");
		assert.equal(backend.shifts.length, 2);
		assert.equal(backend.shifts[0].request.cwd, workspace.cwd);
		assert.equal(backend.shifts[1].request.cwd, root);
		assert.match(backend.shifts[1].request.prompt, /- Landed: merged/);
		assert.match(backend.shifts[1].request.prompt, /Review the landed Shiftwork ticket f\/01/);
		assert.match(backend.shifts[1].request.prompt, /- Ticket: \.scratch\/f\/issues\/01-a\.md/);
		assert.match(await ticketText(root, "f", "01-a.md"), /### Review[\s\S]*- Verdict: accept — good[\s\S]*- Verify: passed/);
	}
});

test("with no review.when (before-land), the review runs on the branch in the worktree before the landing; accept lands once", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: `Looks good on the branch.\n\n${reviewMarker("accept", "matches the spec")}` },
	]);
	const workspace = fakeWorkspace();
	// The branch is committed before the review shift starts: the reviewer's `git diff <target>...HEAD` sees the work.
	let shiftsAtCommit;
	const commit = workspace.commit.bind(workspace);
	workspace.commit = async (t) => {
		shiftsAtCommit = backend.shifts.length;
		return commit(t);
	};

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), workspace });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.deepEqual(workspace.calls, [["prepare", "01"], ["commit", "01"], ["discardAfterReview", "01"], ["land", "01"]], "committed before the review, discarded what it left, landed once after it accepted");
	assert.equal(shiftsAtCommit, 1, "the commit comes after the worker shift and before the review shift");
	assert.equal(backend.shifts.length, 2);
	assert.equal(backend.shifts[0].request.cwd, workspace.cwd, "the worker shift runs in the worktree");
	assert.equal(backend.shifts[1].request.cwd, workspace.cwd, "the review reads the unlanded branch in the worktree");
	assert.match(backend.shifts[1].request.prompt, /Review the Shiftwork ticket f\/01 before it lands: A/);
	assert.match(backend.shifts[1].request.prompt, /- Branch: .*`git diff main\.\.\.HEAD`/);
	assert.match(backend.shifts[1].request.prompt, /`git log main\.\.HEAD`/);
	assert.doesNotMatch(backend.shifts[1].request.prompt, /- Landed:/);
	// The worktree's .scratch copy is stale: the prompt points at the ticket's real path, absolute.
	assert.match(backend.shifts[1].request.prompt, new RegExp(`- Ticket: ${root}/\.scratch/f/issues/01-a\.md`));
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /### Review[\s\S]*- Verdict: accept — matches the spec[\s\S]*- Verify: passed/);
	assert.match(text, /> Looks good on the branch\./);
	assert.match(text, /- Landed: merged/);
	assert.match(text, /\*\*Status:\*\* resolved[\s\S]*### Review[\s\S]*- Verdict: accept[\s\S]*- Landed: merged/, "the review is recorded before the landing note");
	assert.match(text, /- Outcome: verify passed; review before landing/, "the shift report doesn't claim resolved before the review");
	assert.doesNotMatch(text, /- Outcome: resolved/);
});

test("an accepted before-land review discards what it left in the worktree; the after-land path discards nothing", async () => {
	// Before-land: the review round left files in the worktree — they are discarded before the
	// landing, and the discarded paths land in the ticket as a landing note.
	{
		const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
		const backend = fakeBackend([
			{ files: { "done.txt": "ok" } },
			{ text: reviewMarker("accept", "matches the spec") },
		]);
		const workspace = fakeWorkspace({ discarded: ["src/stray.txt", "logs/run.log"] });

		await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), workspace });

		const ops = workspace.calls.map((c) => c[0]);
		assert.ok(ops.indexOf("discardAfterReview") < ops.indexOf("land"), "the discard runs before the landing");
		const text = await ticketText(root, "f", "01-a.md");
		assert.match(text, /- Discarded after review: src\/stray\.txt, logs\/run\.log/);
		assert.match(text, /- Discarded after review[\s\S]*- Landed: merged/, "the note is a landing note, next to - Landed");
	}
	// After-land: the review runs in the main repo after the landing, so nothing is discarded.
	{
		const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
		const backend = fakeBackend([
			{ files: { "done.txt": "ok" } },
			{ text: reviewMarker("accept", "good") },
		]);
		const workspace = fakeWorkspace({ discarded: ["src/stray.txt"] });

		await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig({ when: "after-land" }), workspace });

		assert.ok(!workspace.calls.some(([op]) => op === "discardAfterReview"), "nothing is discarded after the landing");
		assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /Discarded after review/);
	}
});

test("a before-land landing whose target moved discards what the re-verify left, before it lands again", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("accept", "matches the spec") },
	]);
	// The first land finds the target moved; the gate re-runs on the rebased worktree and
	// leaves a stray there, which is discarded again before the second land.
	const lands = [
		{ ok: false, rebase: "abc1234", message: "the target moved to abc1234: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: true, message: "merged shiftwork/f-01 into main" },
	];
	let discards = 0;
	const workspace = fakeWorkspace({
		land: () => lands.shift(),
		discarded: () => (discards++ === 0 ? [] : ["stray.log"]),
	});

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), workspace });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.deepEqual(
		workspace.calls,
		[["prepare", "01"], ["commit", "01"], ["discardAfterReview", "01"], ["land", "01"], ["discardAfterReview", "01"], ["land", "01"]],
		"the discard runs again after the re-verify, before the second land",
	);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Target moved to abc1234: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Discarded after re-verify: stray\.log/);
	assert.match(
		text,
		/- Target moved to abc1234[\s\S]*- Discarded after re-verify: stray\.log[\s\S]*- Landed: merged shiftwork\/f-01 into main/,
		"the re-verify's discard is noted between the rebase and the landing",
	);
});

test("an after-land landing whose target moved re-verifies and lands without discarding anything", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("accept", "good") },
	]);
	const lands = [
		{ ok: false, rebase: "abc1234", message: "the target moved to abc1234: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: true, message: "merged shiftwork/f-01 into main" },
	];
	const workspace = fakeWorkspace({ land: () => lands.shift(), discarded: ["stray.log"] });

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig({ when: "after-land" }), workspace });

	assert.ok(!workspace.calls.some(([op]) => op === "discardAfterReview"), "after-land landings discard nothing, even across a rebase round");
	const text = await ticketText(root, "f", "01-a.md");
	assert.doesNotMatch(text, /Discarded after/);
	assert.match(text, /- Landed: merged shiftwork\/f-01 into main/);
});

test("a before-land follow-up whose landing fails files no follow-up", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("follow-up", "add integration tests") },
	]);
	const workspace = fakeWorkspace({ landOk: false });

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), workspace, options: { once: true } });

	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Verdict: follow-up — add integration tests/);
	assert.match(text, /- Follow-up: not filed — the branch did not land/);
	assert.doesNotMatch(text, /- Follow-up: f\//);
	const { readdir } = await import("node:fs/promises");
	assert.deepEqual((await readdir(`${root}/.scratch/f/issues`)).filter((f) => f.startsWith("02-")), [], "no follow-up for work that never landed");
});

test("a before-land reopen lands nothing: the next shift continues on the same branch, pointed at the findings", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const workspace = fakeWorkspace();

	// Run 1: the gate passes, the review reopens the ticket before anything lands.
	const first = await runFrontier({
		root,
		tracker: openTracker(root),
		backend: fakeBackend([
			{ files: { "done.txt": "ok" } },
			{ text: `The naming is off.\n\n${reviewMarker("reopen", "the helper hides the branch check")}` },
		]),
		verify: fileVerify(),
		config: reviewConfig(),
		workspace,
	});

	assert.deepEqual(first.reopened.map((t) => t.number), ["01"]);
	assert.deepEqual(workspace.calls, [["prepare", "01"], ["commit", "01"]], "committed for the review, but land is never called on a reopen");
	const text1 = await ticketText(root, "f", "01-a.md");
	assert.match(text1, /\*\*Status:\*\* ready-for-agent/);
	assert.match(text1, /### Review[\s\S]*- Verdict: reopen — the helper hides the branch check/);
	assert.match(text1, /> The naming is off\./);

	// Run 2: the next shift works in the same worktree, pointed at the review's findings; the accept lands.
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("accept", "fixed the branch check") },
	]);
	const second = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), workspace });

	assert.deepEqual(workspace.calls, [["prepare", "01"], ["commit", "01"], ["prepare", "01"], ["commit", "01"], ["discardAfterReview", "01"], ["land", "01"]], "the second run reuses the ticket's worktree, commits for its review, discards what it left, then lands it");
	assert.equal(backend.shifts[0].request.cwd, workspace.cwd, "the next shift runs in the kept worktree");
	assert.equal(backend.shifts[1].request.cwd, workspace.cwd, "the second review runs in the kept worktree too");
	assert.match(backend.shifts[0].request.prompt, /- The last review of this work ended in reopen/);
	assert.match(backend.shifts[0].request.prompt, /"### Review"/);
	assert.deepEqual(second.resolved.map((t) => t.number), ["01"]);
	assert.deepEqual(workspace.calls.filter((c) => c[0] === "land"), [["land", "01"]], "the accepted work lands");
	const text2 = await ticketText(root, "f", "01-a.md");
	assert.match(text2, /\*\*Status:\*\* resolved/);
	assert.match(text2, /- Landed: merged/);
});

test("a before-land follow-up verdict lands the branch and files the follow-up", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: reviewMarker("follow-up", "add integration tests") },
	]);
	const workspace = fakeWorkspace();

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: reviewConfig(), workspace, options: { once: true } });

	assert.deepEqual(summary.resolved.map((t) => t.number), ["01"]);
	assert.deepEqual(workspace.calls.filter((c) => c[0] === "land"), [["land", "01"]], "the reviewed work lands");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* resolved/);
	assert.match(text, /- Verdict: follow-up — add integration tests/);
	assert.match(text, /- Follow-up: f\/02 — Follow-up to f\/01: add integration tests/);
	const { readdir } = await import("node:fs/promises");
	const files = (await readdir(`${root}/.scratch/f/issues`)).filter((f) => f.startsWith("02-"));
	assert.equal(files.length, 1);
	const created = await readFile(`${root}/.scratch/f/issues/${files[0]}`, "utf8");
	assert.match(created, /\*\*Status:\*\* ready-for-agent/);
	assert.match(created, /\*\*Verify:\*\* `done\.txt`/);
});

test("a before-land review with no verdict lands nothing: needs-info, branch kept", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([
		{ files: { "done.txt": "ok" } },
		{ text: "Still investigating, no verdict yet." },
		{ text: "Ran out of time, still no verdict." },
	]);
	const workspace = fakeWorkspace();

	const summary = await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: retryReviewConfig(), workspace });

	assert.deepEqual(summary.resolved, []);
	assert.deepEqual(summary.needsInfo.map((t) => t.number), ["01"]);
	assert.equal(summary.needsInfo[0].reason, "review gave no verdict twice; review it by hand");
	assert.deepEqual(workspace.calls.filter((c) => c[0] === "land"), [], "nothing lands without a verdict");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* needs-info/);
	assert.match(text, /- Verdict: none — review gave no verdict twice; review it by hand/);
	assert.match(text, /- Branch kept: shiftwork\/f-01/);
});

test("the second before-land reopen (maxRounds) goes to needs-info: nothing lands, the branch is kept", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const workspace = fakeWorkspace();

	// Run 1: one reopen — the ticket goes back to ready-for-agent.
	const first = await runFrontier({
		root,
		tracker: openTracker(root),
		backend: fakeBackend([
			{ files: { "done.txt": "ok" } },
			{ text: reviewMarker("reopen", "the gate file is not asserted") },
		]),
		verify: fileVerify(),
		config: reviewConfig(),
		workspace,
	});
	assert.deepEqual(first.reopened.map((t) => t.number), ["01"]);

	// Run 2: the second reopen is review.maxRounds (default 2): a human takes over.
	const second = await runFrontier({
		root,
		tracker: openTracker(root),
		backend: fakeBackend([
			{ files: { "done.txt": "ok" } },
			{ text: reviewMarker("reopen", "the gate file is still not asserted") },
		]),
		verify: fileVerify(),
		config: reviewConfig(),
		workspace,
	});

	assert.deepEqual(second.needsInfo.map((t) => t.number), ["01"]);
	assert.equal(second.needsInfo[0].reason, "review rejected it 2 times; branch shiftwork/f-01 kept");
	assert.deepEqual(workspace.calls.filter((c) => c[0] === "land"), [], "nothing ever lands");
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /\*\*Status:\*\* needs-info/);
	assert.match(text, /- Review rejected it 2 times; branch shiftwork\/f-01 kept/);
});

test("parallel: a before-land reopen lands nothing while another slot's ticket lands", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Type:** code\n**Verify:** `b.txt`" }),
	});
	const backend = ticketScriptBackend({
		"f/01": [{ files: { "a.txt": "" } }, { text: reviewMarker("reopen", "not good yet") }],
		"f/02": [{ files: { "b.txt": "" } }, { text: reviewMarker("accept", "good") }],
	});
	const workspace = fakeWorkspace();

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: reviewConfig(),
		workspace,
		options: { parallel: 2 },
	});

	assert.deepEqual(summary.reopened.map((t) => t.number), ["01"]);
	assert.deepEqual(summary.resolved.map((t) => t.number), ["02"]);
	assert.deepEqual(workspace.calls.filter((c) => c[0] === "land"), [["land", "02"]], "only the accepted ticket lands");
	assert.match(await ticketText(root, "f", "01-a.md"), /\*\*Status:\*\* ready-for-agent/);
	assert.doesNotMatch(await ticketText(root, "f", "01-a.md"), /- Landed:/);
	assert.match(await ticketText(root, "f", "02-b.md"), /\*\*Status:\*\* resolved/);
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

test("shift reports say how long the shift took, and the ticket total from the second shift on", async () => {
	const cfg = validateConfig({
		defaultType: "code",
		thinking: "low",
		maxAttempts: 2,
		routing: { code: { tier: "standard" } },
		tiers: { standard: { chain: ["fake/m1"], thinking: "low" } },
		review: false,
	});
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ text: "not yet" }, { files: { "done.txt": "ok" } }]);

	await runFrontier({ root, tracker: openTracker(root), backend, verify: fileVerify(), config: cfg });

	const text = await ticketText(root, "f", "01-a.md");
	const times = [...text.matchAll(/^- Time: .*$/gm)].map((m) => m[0]);
	assert.equal(times.length, 2);
	assert.match(times[0], /^- Time: (?:\d+m )?\d+s$/);
	assert.match(times[1], /^- Time: (?:\d+m )?\d+s \(ticket total (?:\d+h )?(?:\d+m )?\d+s\)$/);
});

test("formatDuration renders seconds, minutes and hours", () => {
	assert.equal(formatDuration(0.5), "30s");
	assert.equal(formatDuration(12 + 34 / 60), "12m 34s");
	assert.equal(formatDuration(125), "2h 5m");
});

// Parallel shifts (spec stories 1–2): up to N frontier tickets at once, per-provider caps.

/** A scripted backend whose shifts stay open until the test releases them, recording start and end. */
// Start and end use performance.now(): Date.now()'s millisecond can make an overlap look serial.
function gateBackend(script) {
	const shifts = [];
	return {
		name: "fake",
		shifts,
		async startShift(request) {
			const step = script[shifts.length] ?? {};
			const record = { request, startedAt: null, endedAt: null, aborted: false };
			shifts.push(record);
			// The gate is set up synchronously, before any await, so a test that sees
			// the shift in `shifts` can always release it.
			let open;
			const gate = new Promise((resolve) => {
				open = resolve;
			});
			record.open = () => {
				record.endedAt = performance.now();
				open();
			};
			for (const [rel, content] of Object.entries(step.files ?? {})) {
				await writeFile(join(request.cwd, rel), content);
			}
			const events = (async function* () {
				record.startedAt = performance.now();
				await gate;
				yield { type: "turn", usage: { input: 100, output: 20, totalTokens: 120 }, costUsd: 0.01 };
				yield { type: "end", stopReason: "stop" };
			})();
			return {
				capabilities: {},
			events,
				warnings: [],
				steer: async () => {},
				abort: async () => {
					record.aborted = true;
				},
				close: async () => {},
			};
		},
	};
}

async function waitFor(condition) {
	// A generous budget: the whole suite runs at once and the event loop can stall for seconds.
	for (let i = 0; i < 2000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(condition(), "timed out waiting for the runner");
}

function runParallel(root, backend, configOverrides = {}) {
	return runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config: { ...config, ...configOverrides },
		options: { parallel: 2 },
	});
}

test("parallel: 2 fills both slots with the current feature's ready tickets first", async () => {
	const root = await makeRepo({
		"a/01-a.md": ticket("01", "A", { extra: "**Verify:** `a1.txt`" }),
		"a/02-a.md": ticket("02", "A2", { extra: "**Verify:** `a2.txt`" }),
		"b/01-b.md": ticket("01", "B", { extra: "**Verify:** `b1.txt`" }),
	});
	const backend = gateBackend([{ files: { "a1.txt": "" } }, { files: { "a2.txt": "" } }, { files: { "b1.txt": "" } }]);
	const running = runParallel(root, backend);
	await waitFor(() => backend.shifts.length === 2 && backend.shifts.every((s) => s.startedAt));

	// Once the first slot takes feature a's ticket, the second takes a's next one,
// not feature b's number-01 ticket.
	assert.deepEqual(workedIds(backend), ["a/01", "a/02"]);

	backend.shifts.forEach((s) => s.open());
	// Feature b's ticket starts only after a's are done; release its gate too.
	await waitFor(() => backend.shifts.length === 3 && backend.shifts[2].startedAt);
	backend.shifts[2].open();
	const summary = await running;
	assert.deepEqual(workedIds(backend), ["a/01", "a/02", "b/01"]);
	assert.deepEqual(summary.resolved.map((t) => t.number).sort(), ["01", "01", "02"]);
});

test("parallel: 2 works two independent tickets at once", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	const running = runParallel(root, backend);
	// Wait until both shifts have really started, then release both gates at once.
	await waitFor(() => backend.shifts.length === 2 && backend.shifts.every((s) => s.startedAt));
	backend.shifts[0].open();
	backend.shifts[1].open();
	const summary = await running;
	// Parallel tickets finish in their own time: the pool records them as they settle.
	assert.deepEqual(summary.resolved.map((t) => t.number).sort(), ["01", "02"]);
	assert.ok(backend.shifts[1].startedAt < backend.shifts[0].endedAt, "the second shift started before the first one ended");
	assert.ok(backend.shifts[0].startedAt < backend.shifts[1].endedAt, "the shifts overlapped in time");
});

test("a ticket blocked by a running parallel ticket starts only after it resolves", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { blockedBy: "01", extra: "**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	const running = runParallel(root, backend);
	await waitFor(() => backend.shifts.length === 1 && backend.shifts[0].startedAt);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(backend.shifts.length, 1, "the blocked ticket must not start while its blocker runs");
	backend.shifts[0].open();
	await waitFor(() => backend.shifts.length === 2 && backend.shifts[1].startedAt);
	assert.ok(backend.shifts[1].startedAt >= backend.shifts[0].endedAt, "the blocked ticket starts only after its blocker resolves");
	backend.shifts[1].open();
	const summary = await running;
	assert.deepEqual(summary.resolved.map((t) => t.number), ["01", "02"]);
});

test("a provider at its concurrency cap is skipped for the next model, and no cooldown is written", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Type:** code\n**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	const running = runParallel(root, backend, chainTwoProviders({ concurrency: { fake: 1 } }));
	await waitFor(() => backend.shifts.length === 2);
	assert.deepEqual(
		[backend.shifts[0].request.route.model, backend.shifts[1].request.route.model].sort(),
		["fake/m1", "other/m2"],
		"the ticket that finds the provider full skips to the next chain model",
	);
	backend.shifts[0].open();
	backend.shifts[1].open();
	const summary = await running;
	// Parallel tickets finish in their own time: the pool records them as they settle.
	assert.deepEqual(summary.resolved.map((t) => t.number).sort(), ["01", "02"]);
	let stateText = "{}";
	try {
		stateText = await readFile(`${root}/.pi/shiftwork-state.json`, "utf8");
	} catch {}
	assert.deepEqual(JSON.parse(stateText).cooldowns ?? [], [], "no cooldown is written for a full provider");
});

test("parallel landings go through one queue: one landing at a time", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	let inLanding = 0;
	let maxInLanding = 0;
	const workspace = {
		...fakeWorkspace(),
		async land(t) {
			inLanding++;
			maxInLanding = Math.max(maxInLanding, inLanding);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inLanding--;
			return { ok: true, message: "merged" };
		},
	};
	const running = runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config,
		workspace,
		options: { parallel: 2 },
	});
	await waitFor(() => backend.shifts.length === 2);
	backend.shifts[0].open();
	backend.shifts[1].open();
	const summary = await running;
	// Parallel tickets finish in their own time: the pool records them as they settle.
	assert.deepEqual(summary.resolved.map((t) => t.number).sort(), ["01", "02"]);
	assert.equal(maxInLanding, 1, "only one landing runs at a time");
});

test("a parallel run keeps re-verifying and landing while the target keeps moving", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	// Either ticket's shift may start first: both entries satisfy both tickets' gates.
	const backend = fakeBackend([{ files: { "a.txt": "", "b.txt": "" } }, { files: { "a.txt": "", "b.txt": "" } }]);
	// Ticket 01's landing keeps finding the target moved (02 lands through the same queue);
	// the runner rebases, re-verifies and lands again until the target stands still.
	const lands = [
		{ ok: false, rebase: "1111111", message: "the target moved to 1111111: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: false, rebase: "2222222", message: "the target moved to 2222222: branch shiftwork/f-01 rebased onto it; re-verify and land again" },
		{ ok: true, message: "merged shiftwork/f-01 into main" },
	];
	const workspace = fakeWorkspace({ land: (t) => (t.number === "01" ? lands.shift() : { ok: true, message: "merged" }) });

	const summary = await runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify: fileVerify(),
		config,
		workspace,
		options: { parallel: 2 },
	});

	assert.deepEqual(summary.resolved.map((t) => t.number).sort(), ["01", "02"]);
	const text = await ticketText(root, "f", "01-a.md");
	assert.match(text, /- Target moved to 1111111: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Target moved to 2222222: branch rebased onto it, verify gate re-run: passed/);
	assert.match(text, /- Landed: merged shiftwork\/f-01 into main/);
});

test("parallel: 2 lists both workers in the run state while they run", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	const state = openRunState(root);
	const running = runParallel(root, backend);

	// Wait until the run state lists both workers, then let both shifts finish.
	let read = null;
	for (let i = 0; i < 2000 && (read = await state.read())?.workers?.length !== 2; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(read.live, true);
	assert.deepEqual(
		read.workers.map((w) => `${w.ticket.feature}/${w.ticket.number}`).sort(),
		["f/01", "f/02"],
		"both workers are listed while they run",
	);

	// The run state lists a worker just before its shift starts: wait for both shifts too.
	await waitFor(() => backend.shifts.length === 2);
	backend.shifts[0].open();
	backend.shifts[1].open();
	const summary = await running;
	assert.deepEqual(summary.resolved.map((t) => t.number).sort(), ["01", "02"]);
	const after = await state.read();
	assert.equal(after.running, false);
	assert.deepEqual(after.workers, [], "settled workers are no longer listed");
});

test("a STOP file hands off both parallel workers", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	const state = openRunState(root);
	const running = runParallel(root, backend);
	await waitFor(() => backend.shifts.length === 2 && backend.shifts.every((s) => s.startedAt));

	// Both workers see the STOP file on their next event and hand off.
	await writeFile(join(root, "STOP"), "");
	backend.shifts[0].open();
	backend.shifts[1].open();
	const summary = await running;

	assert.equal(summary.stoppedReason, "STOP file");
	assert.equal(summary.exitCode, 3);
	for (const file of ["01-a.md", "02-b.md"]) {
		const text = await ticketText(root, "f", file);
		assert.match(text, /\*\*Status:\*\* ready-for-agent/);
		assert.match(text, /### Handoff[\s\S]*reason: STOP file/);
	}
	const claims = await readdir(join(root, ".scratch", ".claims"));
	assert.deepEqual(claims, [], "both claims are released");
	const after = await state.read();
	assert.equal(after.running, false);
	assert.deepEqual(after.workers, []);
});

test("a failed worker lets the others settle before the error propagates", async () => {
	const root = await makeRepo({
		"f/01-a.md": ticket("01", "A", { extra: "**Verify:** `a.txt`" }),
		"f/02-b.md": ticket("02", "B", { extra: "**Verify:** `b.txt`" }),
	});
	const backend = gateBackend([{ files: { "a.txt": "" } }, { files: { "b.txt": "" } }]);
	const state = openRunState(root);
	// Ticket 01's verify gate throws; ticket 02's settles slowly, after it.
	const verify = async (commands, cwd) => {
		const result = await fileVerify()(commands, cwd);
		if (result.results.some((r) => r.cmd.includes("a.txt"))) throw new Error("verify exploded");
		await new Promise((resolve) => setTimeout(resolve, 150));
		return result;
	};
	const running = runFrontier({
		root,
		tracker: openTracker(root),
		backend,
		verify,
		config,
		options: { parallel: 2 },
	});
	await waitFor(() => backend.shifts.length === 2 && backend.shifts.every((s) => s.startedAt));
	backend.shifts[0].open();
	backend.shifts[1].open();

	await assert.rejects(running, /verify exploded/);

	// The error propagated only after the other worker settled and the run state finished.
	assert.match(await ticketText(root, "f", "02-b.md"), /\*\*Status:\*\* resolved/);
	const claims = await readdir(join(root, ".scratch", ".claims"));
	assert.deepEqual(claims, [], "both claims are released");
	const after = await state.read();
	assert.equal(after.running, false);
	assert.deepEqual(after.workers, []);
});

test("a review whose verify re-run fails records the failing output, like a shift report", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Type:** code\n**Verify:** `npm test`" }) });
	const backend = fakeBackend([{ text: "done" }, { text: reviewMarker("accept", "fine") }]);
	let calls = 0;
	// The shift's gate passes; the review's re-run of it fails (a flaky test, say).
	const verify = async (commands) => {
		calls++;
		const code = calls === 1 ? 0 : 1;
		return { ok: code === 0, results: [{ cmd: commands[0], code, outputTail: code ? "✖ failing tests:\nflaky.test.js timed out" : "" }] };
	};

	await runFrontier({ root, tracker: openTracker(root), backend, verify, config: reviewConfig(), options: { once: true } });

	const review = (await ticketText(root, "f", "01-a.md")).split("### Review")[1];
	assert.match(review, /- Verify: failed at `npm test` \(exit 1\)/);
	assert.match(review, /flaky\.test\.js timed out/);
});
