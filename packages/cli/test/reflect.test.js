import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildReflection,
	collectShiftLogs,
	findRepeatedSteps,
	findVerifyFailures,
	formatReflection,
	normalizeCommand,
	parseShiftLog,
	reflect,
	stepOf,
	suggestScript,
	writeReflection,
} from "../src/reflect.js";

const NOW = new Date("2026-10-04T12:00:00Z");

/** A shift log as createShiftLogger writes it: a start record, then the shift's events. */
function shiftLog(commands, { at = "2026-10-03T10:00:00.000Z", name = "bash" } = {}) {
	const lines = [{ at, type: "start", backend: "claude", model: "claude/haiku", attempt: 1 }];
	for (const command of commands) lines.push({ at, type: "tool", name, input: command });
	lines.push({ at, type: "turn", usage: { totalTokens: 10 } }, { at, type: "end", stopReason: "stop" });
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

const shift = (ticket, commands, n = 1) => ({ id: `${ticket}/attempt-${n}.jsonl`, ticket, steps: commands.map((c) => stepOf({ type: "tool", name: "bash", input: c })) });

test("normalizeCommand strips paths, numbers, hashes and quoted args to a template", () => {
	assert.equal(normalizeCommand("node --test packages/cli/test/reflect.test.js packages/cli/test/git.test.js"), "node --test <path>");
	assert.equal(normalizeCommand("git commit -m 'Fix the thing'"), "git commit -m <str>");
	assert.equal(normalizeCommand(`git commit -m "Other message"`), "git commit -m <str>");
	assert.equal(normalizeCommand("git show 4547f46"), "git show <sha>");
	assert.equal(normalizeCommand("sed -n 120,180p src/runner.js"), "sed -n <n> <path>");
	assert.equal(normalizeCommand("head -50 README.md"), "head -<n> <path>");
	assert.equal(normalizeCommand("  npm   test  "), "npm test");
	assert.equal(normalizeCommand("cd /work/repo && npm test"), "npm test", "a leading cd is where, not what");
	assert.equal(normalizeCommand("bash -lc 'npm run lint'"), "npm run lint", "a shell wrapper is unwrapped");
	assert.equal(normalizeCommand("npx vitest --reporter=dot src/a.test.ts"), "npx vitest --reporter=dot <path>");
});

test("stepOf keeps shell tool calls only", () => {
	assert.deepEqual(stepOf({ type: "tool", name: "Bash", input: "npm test" }), { template: "npm test", example: "npm test" });
	assert.equal(stepOf({ type: "tool", name: "shell", input: "git status" }).template, "git status");
	assert.equal(stepOf({ type: "tool", name: "Read", input: "src/a.js" }), null);
	assert.equal(stepOf({ type: "tool", name: "bash", input: "" }), null);
	assert.equal(stepOf({ type: "text", text: "hi" }), null);
});

test("parseShiftLog reads the start time and the shell steps; bad lines are skipped", () => {
	const text = `${shiftLog(["npm test", "git status"])}not json\n${JSON.stringify({ type: "tool", name: "Write", input: "a.txt" })}\n`;
	const parsed = parseShiftLog(text);
	assert.equal(parsed.at, "2026-10-03T10:00:00.000Z");
	assert.deepEqual(
		parsed.steps.map((s) => s.template),
		["npm test", "git status"],
	);
});

test("findRepeatedSteps finds commands and sequences repeated across at least min shifts, ranked by occurrences × shifts", () => {
	const shifts = [
		shift("feat/01", ["npm install", "node --test a.test.js", "git add -A", "git commit -m 'one'"]),
		shift("feat/02", ["node --test b.test.js", "git add -A", "git commit -m 'two'"]),
		shift("feat/03", ["ls", "git add -A", "git commit -m 'three'", "node --test c.test.js"]),
		shift("feat/03", ["node --test c.test.js", "node --test d.test.js"], 2),
		shift("other/01", ["npm install"]),
	];
	const found = findRepeatedSteps(shifts, { min: 3 });
	const templates = found.map((c) => c.steps.join(" && "));
	assert.ok(templates.includes("git add -A && git commit -m <str>"), "the pair repeated in 3 shifts");
	assert.ok(!templates.includes("git add -A"), "a step always seen inside a longer sequence is reported as the sequence");
	assert.ok(!templates.includes("git commit -m <str>"));
	assert.ok(templates.includes("node --test <path>"));
	assert.ok(!templates.includes("npm install"), "2 shifts < min 3");
	assert.ok(!templates.includes("ls"), "trivial lookups are not scripts");
	assert.ok(!templates.includes("node --test <path> && node --test <path>"), "a step repeated with itself is not a sequence");

	const node = found.find((c) => c.steps.join(" && ") === "node --test <path>");
	assert.equal(node.occurrences, 5);
	assert.equal(node.shifts, 4);
	assert.equal(node.score, 20);
	assert.deepEqual(node.tickets, ["feat/01", "feat/02", "feat/03"]);
	assert.ok(node.examples.length >= 1 && node.examples.length <= 3);
	assert.equal(found[0], node, "ranked by score");

	assert.deepEqual(findRepeatedSteps(shifts, { min: 5 }), []);
});

test("findVerifyFailures spots the same failing command across attempts", () => {
	const tickets = [
		{
			id: "feat/01",
			text: "# 01\n\n## Comments\n\n### Shift 1\n- Verify: failed at `npm test` (exit 1)\n\n### Shift 2\n- Verify: failed at `npm test` (exit 1)\n\n### Shift 3\n- Verify: passed\n",
		},
		{ id: "feat/02", text: "# 02\n\n## Comments\n\n### Shift 1\n- Verify: failed at `npm run lint` (exit 2)\n" },
		{ id: "feat/03", text: "# 03\n\nBody mentions - Verify: failed at `npm test` outside comments\n\n## Comments\n\n### Shift 1\n- Verify: failed at `npm test` (exit 1)\n" },
	];
	assert.deepEqual(findVerifyFailures(tickets), [{ command: "npm test", failures: 3, tickets: ["feat/01", "feat/03"] }]);
});

test("suggestScript names a script after the steps and writes a skeleton with the varying parts as arguments", () => {
	const s = suggestScript({ steps: ["git add -A", "git commit -m <str>"], examples: [["git add -A", "git commit -m 'x'"]], occurrences: 3, shifts: 3, tickets: ["a/01"] });
	assert.equal(s.name, "git-add-commit");
	assert.equal(s.path, "scripts/git-add-commit.sh");
	assert.match(s.skeleton, /^#!\/usr\/bin\/env bash/);
	assert.match(s.skeleton, /set -euo pipefail/);
	assert.match(s.skeleton, /git add -A\ngit commit -m "\$1"/);
	assert.match(s.skeleton, /usage: scripts\/git-add-commit\.sh <str>/);
	assert.equal(suggestScript({ steps: ["<path>"], examples: [], occurrences: 3, shifts: 3, tickets: [] }).name, "step");
});

test("buildReflection + formatReflection: a ranked report with templates, examples, tickets and a script per suggestion", () => {
	const shifts = ["a/01", "a/02", "b/01"].map((t) => shift(t, ["npm run build", "node --test x.test.js"]));
	const report = buildReflection({ shifts, tickets: [], min: 3, now: NOW });
	assert.equal(report.shiftsScanned, 3);
	assert.equal(report.candidates.length, 1);
	assert.equal(report.candidates[0].suggestion.name, "npm-run-build-node-test");
	const md = formatReflection(report);
	assert.match(md, /^# Shiftwork reflection — 2026-10-04/);
	assert.match(md, /npm run build && node --test <path>/);
	assert.match(md, /a\/01, a\/02, b\/01/);
	assert.match(md, /scripts\/npm-run-build-node-test\.sh/);
	assert.match(md, /```bash/);

	const empty = formatReflection(buildReflection({ shifts: [], tickets: [], min: 3, now: NOW }));
	assert.match(empty, /No step repeated/);
});

async function repo() {
	const root = await mkdtemp(join(tmpdir(), "shiftwork-reflect-"));
	const write = async (path, text) => {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), text);
	};
	return { root, write };
}

test("collectShiftLogs reads logs/<feature>/<NN>/attempt-*.jsonl and honours --since", async () => {
	const { root, write } = await repo();
	try {
		await write("logs/feat/01/attempt-1.jsonl", shiftLog(["npm test"]));
		await write("logs/feat/01/attempt-1.2.jsonl", shiftLog(["npm test"]));
		await write("logs/feat/02/attempt-review.jsonl", shiftLog(["npm test"], { at: "2026-09-01T00:00:00.000Z" }));
		await write("logs/runner-2026.log", "not a shift log\n");
		const all = await collectShiftLogs(root, { now: NOW });
		assert.deepEqual(all.map((s) => s.id).sort(), ["feat/01/attempt-1.2.jsonl", "feat/01/attempt-1.jsonl", "feat/02/attempt-review.jsonl"]);
		assert.equal(all.find((s) => s.id === "feat/01/attempt-1.jsonl").ticket, "feat/01");
		const recent = await collectShiftLogs(root, { now: NOW, sinceDays: 7 });
		assert.deepEqual(recent.map((s) => s.ticket), ["feat/01", "feat/01"]);
		assert.deepEqual(await collectShiftLogs(join(root, "nowhere"), { now: NOW }), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writeReflection saves the report and files a ready-for-agent automate feature, one ticket per top suggestion", async () => {
	const { root } = await repo();
	try {
		const shifts = ["a/01", "a/02", "b/01"].map((t) => shift(t, ["npm run build", "make deploy-preview"]));
		shifts.push(...["c/01", "c/02", "c/03"].map((t) => shift(t, ["docker compose up -d", "ls"])));
		const report = buildReflection({ shifts, tickets: [], min: 3, now: NOW });
		const written = await writeReflection(root, report, { now: NOW });

		assert.equal(written.reportPath, join(root, ".scratch", "reflections", "2026-10-04.md"));
		assert.match(await readFile(written.reportPath, "utf8"), /npm run build && make deploy-preview/);

		assert.match(written.feature, /^automate-/);
		const featureDir = join(root, ".scratch", written.feature);
		const spec = await readFile(join(featureDir, "spec.md"), "utf8");
		assert.match(spec, /^# Spec: /);
		assert.match(spec, /\*\*Status:\*\* ready-for-agent/);
		assert.match(spec, /shiftwork:tickets:start/, "the spec's ticket table is synced");

		const files = (await readdir(join(featureDir, "issues"))).sort();
		assert.equal(files.length, 2);
		assert.match(files[0], /^01-write-script-/);
		const ticket = await readFile(join(featureDir, "issues", files[0]), "utf8");
		assert.match(ticket, /^# 01: Write script scripts\/[a-z0-9-]+\.sh/);
		assert.match(ticket, /\*\*Status:\*\* ready-for-agent/);
		assert.match(ticket, /\*\*Verify:\*\* `bash -n scripts\/[a-z0-9-]+\.sh`/);
		assert.match(ticket, /- \[ \] /);
		assert.match(ticket, /replace the repeated step/i);

		const again = await writeReflection(root, report, { now: NOW });
		assert.notEqual(again.feature, written.feature, "an existing feature is never overwritten");

		const none = await writeReflection(root, buildReflection({ shifts: [], tickets: [], min: 3, now: NOW }), { now: NOW });
		assert.equal(none.feature, null, "nothing to automate, no feature");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reflect (the CLI) prints the report, and with --write files the feature", async () => {
	const { root, write } = await repo();
	try {
		for (const t of ["01", "02", "03"]) await write(`logs/feat/${t}/attempt-1.jsonl`, shiftLog(["npm run build", "make check"]));
		const out = [];
		assert.equal(await reflect(["--dir", root, "--min", "3"], { now: NOW, log: (l) => out.push(l) }), 0);
		assert.match(out.join("\n"), /npm run build && make check/);
		assert.equal(existsSync(join(root, ".scratch")), false, "no --write, nothing written");

		out.length = 0;
		await reflect(["--dir", root, "--write"], { now: NOW, log: (l) => out.push(l) });
		assert.match(out.join("\n"), /Feature: \.scratch\/automate-npm-run-build-make-check\//);
		await assert.rejects(reflect(["--dir", root, "--min", "0"]), /--min must be a positive integer/);
		await assert.rejects(reflect(["--dir", root, "--since", "x"]), /--since/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
