import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const parallelRunState = fileURLToPath(new URL("./fixtures/parallel-run-state.json", import.meta.url));
const exec = async (args, env = {}) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env } });
};

async function repo(tickets) {
	const root = await mkdtemp(join(tmpdir(), "sw-cli-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "issues", file), body);
	}
	return root;
}

const t = (n, title, extra = "") => `# ${n}: ${title}\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n${extra}\n`;

test("status works with no tickets, no config and no state file", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-status-empty-"));
	const { stdout, stderr } = await exec(["status", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /No tickets found/);
	assert.match(stdout, /Active claims: none/);
	assert.match(stdout, /Cooldowns: none/);
});

test("status shows the frontier, active claims and cooldowns", async () => {
	const root = await repo({
		"f/01-a.md": t("01", "First"),
		"f/02-b.md": t("02", "Second"),
	});
	await mkdir(join(root, ".scratch", ".claims"), { recursive: true });
	await writeFile(
		join(root, ".scratch", ".claims", "f--01.lock"),
		JSON.stringify({ pid: process.pid, token: "test", at: new Date().toISOString() }),
	);
	await mkdir(join(root, ".shiftwork"), { recursive: true });
	await writeFile(
		join(root, ".shiftwork", "shiftwork-state.json"),
		JSON.stringify({ cooldowns: [{ provider: "fake/provider", until: new Date(Date.now() + 5 * 60 * 1000).toISOString(), kind: "rate" }] }),
	);

	const { stdout, stderr } = await exec(["status", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /→ f\/01/);
	assert.match(stdout, /f\/01.*pid\s+\d+.*age/);
	assert.match(stdout, /Active claims:\s*\n  f\/01\s+pid/);
	assert.match(stdout, /Cooldowns:\s*\n  fake\/provider \(rate\)/);
	assert.match(stdout, /remaining/);
});

test("status marks a paused feature and keeps its tickets off the frontier", async () => {
	const root = await repo({
		"a/01-a.md": t("01", "A"),
		"b/01-b.md": t("01", "B"),
	});
	await mkdir(join(root, ".scratch", "a"), { recursive: true });
	await writeFile(join(root, ".scratch", "a", "spec.md"), "# Spec: A\n\n**Status:** paused\n");

	const { stdout, stderr } = await exec(["status", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /\ba {2}⏸ paused/);
	assert.doesNotMatch(stdout, /→ a\/01/);
	assert.match(stdout, /→ b\/01/);
	assert.match(stdout, /1 ready of 2 tickets/);
});

test("status lists every running shift of a parallel: 2 run (fixture from a real run)", async () => {
	const root = await repo({
		"parallel/01-first.md": t("01", "First"),
		"parallel/02-second.md": t("02", "Second"),
	});
	const fixture = JSON.parse(await readFile(parallelRunState, "utf8"));
	// The fixture was captured while two shifts ran; this process stands in for the
	// runner pid so the child `status` process sees the run as live.
	for (const runner of fixture.runners) runner.pid = process.pid;
	await mkdir(join(root, ".shiftwork"), { recursive: true });
	await writeFile(join(root, ".shiftwork", "shiftwork-run.json"), JSON.stringify(fixture));

	const { stdout, stderr } = await exec(["status", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /Running shifts:\s*\n  parallel\/01\s+pid \d+\s+shift 1 · attempt 1 · fake\/m1/);
	assert.match(stdout, /  parallel\/02\s+pid \d+\s+shift 1 · attempt 1 · fake\/m1/);
});

test("status prints a per-feature table with last route", async () => {
	const root = await repo({
		"orch/01-a.md": `${t("01", "First")}\n## Comments\n\n### Shift 1 — fake fake/m1 (low)\n- Ended: ok\n`,
		"orch/02-b.md": t("02", "Second"),
		"other/01-c.md": t("01", "Other"),
	});

	const { stdout, stderr } = await exec(["status", "--dir", root]);

	assert.equal(stderr, "");
	assert.match(stdout, /orch[\s\S]*\|\s*NN\s*\|\s*title\s*\|\s*status\s*\|\s*last route\s*\|/);
	assert.match(stdout, /\|\s*01\s*\|\s*First\s*\|\s*ready-for-agent\s*\|\s*fake\/m1\s*\|/);
	assert.match(stdout, /\|\s*02\s*\|\s*Second\s*\|\s*ready-for-agent\s*\|\s*\|/);
	assert.match(stdout, /other[\s\S]*\|\s*01\s*\|\s*Other\s*\|\s*ready-for-agent\s*\|/);
});
