import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
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
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(
		join(root, ".pi", "shiftwork-state.json"),
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
