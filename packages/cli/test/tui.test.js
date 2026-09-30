import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectDashboardState, formatLogLine, renderDashboard, tailShiftLog } from "../src/dashboard.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = async (args, env = {}) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env } });
};

const now = new Date("2026-10-01T12:00:00Z");

const ticket = (feature, number, title, status = "ready-for-agent") => ({
	feature,
	number,
	title,
	status,
	blockedBy: [],
	path: `/x/.scratch/${feature}/issues/${number}-slug.md`,
});

const base = { now, tickets: [], frontier: [], claims: [], run: null, cooldowns: [], log: null };

test("dashboard: idle runner, one ready ticket", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("f", "01", "First")],
		frontier: [ticket("f", "01", "First")],
	}).join("\n");

	assert.match(frame, /Runner: idle \(no run state\)/);
	assert.match(frame, /Frontier: f\/01 \(1 ready of 1\)/);
	assert.match(frame, /f \(0\/1 resolved\)/);
	assert.match(frame, /\| 01 \| First \| ready-for-agent \| {2}\|/);
	assert.match(frame, /Cooldowns: none/);
	assert.match(frame, /Log: no current shift log/);
});

test("dashboard: running shift shows ticket, shift, model, budget use and context fill", () => {
	const frame = renderDashboard({
		...base,
		tickets: [ticket("orch", "11", "TUI dashboard", "claimed")],
		run: {
			pid: 1,
			running: true,
			live: true,
			startedAt: "2026-10-01T11:56:00Z",
			ticket: { feature: "orch", number: "11", title: "TUI dashboard", path: "/x/11.md" },
			attempt: 2,
			shift: 3,
			model: "xai/grok-4.6",
			thinking: "high",
			budget: { maxCostUsd: 2, maxTokens: 200000 },
			usage: { tokens: 12345, costUsd: 0.25, turns: 5, contextPct: 38 },
			summary: { resolved: 0, needsInfo: 0 },
		},
		log: { path: join("logs", "orch", "11", "attempt-2.jsonl"), lines: ["11:59:58 turn · 12345 tokens"] },
	}).join("\n");

	assert.match(frame, /Runner: working orch\/11 · TUI dashboard/);
	assert.match(frame, /shift 3 · attempt 2 · xai\/grok-4\.6 · thinking high/);
	assert.match(frame, /usage: 12345 tokens · \$0\.25 · 5 turns · ctx 38%/);
	assert.match(frame, /budget: \$2 · 200000 tok/);
	assert.match(frame, /started 4m ago/);
	assert.match(frame, /Log: logs\/orch\/11\/attempt-2\.jsonl\n {2}11:59:58 turn · 12345 tokens/);
});

test("dashboard: waiting on cooldowns shows the time left", () => {
	const frame = renderDashboard({
		...base,
		run: { pid: 1, running: true, live: true, startedAt: "2026-10-01T11:00:00Z", ticket: null, summary: { resolved: 1, needsInfo: 0 } },
		cooldowns: [{ provider: "xai", kind: "rate", until: "2026-10-01T12:05:00Z" }],
	}).join("\n");

	assert.match(frame, /Runner: waiting on cooldowns \(xai 5m left\)/);
	assert.match(frame, /Cooldowns:\n {2}xai \(rate\) {2}5m left/);
});

test("dashboard: a finished run shows why it ended", () => {
	const frame = renderDashboard({
		...base,
		run: {
			running: false,
			live: false,
			stoppedReason: "STOP file",
			summary: { resolved: 3, needsInfo: 1 },
			finishedAt: "2026-10-01T10:00:00Z",
		},
	}).join("\n");

	assert.match(frame, /Runner: not running · stopped: STOP file · resolved 3 · needs-info 1 · finished 2h ago/);
});

test("dashboard: an empty state renders without crashing", () => {
	const frame = renderDashboard({ now }).join("\n");
	assert.match(frame, /Runner: idle/);
	assert.match(frame, /Tickets: none/);
	assert.match(frame, /Cooldowns: none/);
	assert.match(frame, /Log: no current shift log/);
});

test("collectDashboardState: an empty repo has no run, no log and no tickets", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-empty-"));
	const state = await collectDashboardState(root, { now });

	assert.equal(state.run, null);
	assert.equal(state.log, null);
	assert.deepEqual(state.tickets, []);
	assert.deepEqual(state.cooldowns, []);
	renderDashboard(state); // must not throw
});

test("tailShiftLog: a missing log file gives an empty tail, not a crash", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-nolog-"));
	const log = await tailShiftLog(root, { ticket: { feature: "f", number: "01" }, attempt: 1 });

	assert.equal(log.path, join("logs", "f", "01", "attempt-1.jsonl"));
	assert.deepEqual(log.lines, []);
	assert.equal(await tailShiftLog(root, null), null);
});

test("formatLogLine: known events are compact, junk passes through", () => {
	assert.equal(formatLogLine(JSON.stringify({ at: "2026-10-01T11:59:58.123Z", type: "turn", usage: { totalTokens: 120 } })), "11:59:58 turn · 120 tokens");
	assert.equal(formatLogLine(JSON.stringify({ at: "2026-10-01T11:59:59Z", type: "wait", until: "2026-10-01T12:05:00Z" })), "11:59:59 wait · until 12:05:00");
	assert.equal(formatLogLine("not json  "), "not json");
});

test("shiftwork tui --once prints one frame and exits", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-once-"));
	await mkdir(join(root, ".scratch", "f", "issues"), { recursive: true });
	await writeFile(
		join(root, ".scratch", "f", "issues", "01-first.md"),
		"# 01: First\n\n**Blocked by:** None\n\n**Status:** claimed\n",
	);
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "shiftwork-run.json"),
		JSON.stringify({
			pid: process.pid, // alive, so the child sees the run as live
			running: true,
			startedAt: new Date().toISOString(),
			ticket: { feature: "f", number: "01", title: "First", path: join(root, ".scratch", "f", "issues", "01-first.md") },
			attempt: 1,
			shift: 1,
			model: "fake/m1",
			thinking: "low",
			usage: { tokens: 120, costUsd: 0.25, turns: 1, contextPct: 12 },
		}),
	);
	await mkdir(join(root, "logs", "f", "01"), { recursive: true });
	await writeFile(
		join(root, "logs", "f", "01", "attempt-1.jsonl"),
		`${JSON.stringify({ at: new Date().toISOString(), type: "turn", usage: { totalTokens: 120 } })}\n`,
	);

	const { stdout, stderr } = await exec(["tui", "--once", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /Runner: working f\/01 · First/);
	assert.match(stdout, /shift 1 · attempt 1 · fake\/m1 · thinking low/);
	assert.match(stdout, /usage: 120 tokens · \$0\.25 · 1 turns · ctx 12%/);
	assert.match(stdout, /Log: logs\/f\/01\/attempt-1\.jsonl/);
	assert.match(stdout, /turn · 120 tokens/);
});

test("shiftwork tui --once works on an empty repo", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-tui-blank-"));
	const { stdout, stderr } = await exec(["tui", "--once", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /Runner: idle \(no run state\)/);
	assert.match(stdout, /Tickets: none/);
	assert.match(stdout, /Cooldowns: none/);
});
