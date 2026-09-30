import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { openTracker, runFrontier } from "../src/index.js";
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
	assert.match(text, /## Comments[\s\S]*### Shift 1 — fake fake\/m1[\s\S]*Verify: passed/);
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

function fakeWorkspace({ landOk = true } = {}) {
	const calls = [];
	return {
		calls,
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

test("a STOP file created mid-shift stops after the current shift with exit code 3 and no leftover claim", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra: "**Verify:** `done.txt`" }) });
	const backend = fakeBackend([{ text: "Tried.", files: { STOP: "" } }]);

	const summary = await run(root, backend);

	assert.equal(summary.exitCode, 3);
	assert.equal(summary.stoppedReason, "STOP file");
	assert.equal(backend.shifts.length, 1);
	const tracker = openTracker(root);
	assert.equal((await tracker.activeClaims()).length, 0);
	assert.equal((await tracker.frontier()).length, 1);
	assert.equal((await tracker.list())[0].status, "ready-for-agent");
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
