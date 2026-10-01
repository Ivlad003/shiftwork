import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installSignalStop, trackShifts } from "../src/signal-stop.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(root, extra = {}) {
	const proc = new EventEmitter();
	const calls = [];
	const stop = installSignalStop({
		root,
		proc,
		log: () => {},
		abortShifts: async () => calls.push("abort"),
		killVerify: () => calls.push("kill-verify"),
		exit: (code) => calls.push(["exit", code]),
		...extra,
	});
	return { proc, calls, stop };
}

test("the first signal writes STOP; a second aborts shifts, kills verify and exits", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-sig-"));
	const { proc, calls } = harness(root);

	proc.emit("SIGTERM");
	assert.equal(existsSync(join(root, "STOP")), true);
	assert.deepEqual(calls, []);

	proc.emit("SIGINT");
	await tick();
	assert.deepEqual(calls, ["kill-verify", "abort", ["exit", 130]]);
	assert.equal(existsSync(join(root, "STOP")), false, "the STOP file it wrote is removed");
});

test("without a second signal the runner is forced after the grace period", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-sig-"));
	const { proc, calls } = harness(root, { graceMs: 30 });
	proc.emit("SIGHUP");
	await tick(80);
	assert.deepEqual(calls, ["kill-verify", "abort", ["exit", 129]]);
});

test("dispose removes the handlers and only a STOP file it created", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-sig-"));
	const { proc, stop } = harness(root);
	proc.emit("SIGTERM");
	stop.dispose();
	assert.equal(existsSync(join(root, "STOP")), false);
	assert.equal(proc.listenerCount("SIGTERM"), 0);

	const own = await mkdtemp(join(tmpdir(), "sw-sig-"));
	await writeFile(join(own, "STOP"), "the operator's\n");
	const second = harness(own);
	second.proc.emit("SIGTERM");
	second.stop.dispose();
	assert.equal(await readFile(join(own, "STOP"), "utf8"), "the operator's\n");
});

test("trackShifts aborts only shifts that are still live", async () => {
	const aborted = [];
	const backend = trackShifts({
		name: "fake",
		async startShift({ id }) {
			return { id, async abort() { aborted.push(id); }, async close() {} };
		},
	});
	const a = await backend.startShift({ id: "a" });
	await backend.startShift({ id: "b" });
	await a.close();
	assert.equal(backend.liveShifts, 1);
	await backend.abortAll();
	assert.deepEqual(aborted, ["b"]);
	assert.equal(backend.liveShifts, 0);
});

test("shiftwork run: SIGTERM twice kills the agent process instead of leaving it running", { timeout: 60_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-sig-e2e-"));
	const binDir = join(root, "fake-bin");
	await mkdir(binDir);
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await mkdir(join(root, ".pi"));
	const pidFile = join(root, "agent.pid");
	// A fake Claude Code that records its pid and then works "forever".
	await writeFile(join(binDir, "claude"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`);
	await chmod(join(binDir, "claude"), 0o755);
	await writeFile(
		join(root, ".scratch", "demo", "issues", "01-hello.md"),
		"# 01: Hello\n\n**Status:** ready-for-agent\n**Verify:** `test -f hello.txt`\n",
	);
	await writeFile(join(root, ".pi", "shiftwork.json"), JSON.stringify({ model: "claude:sonnet", jev: { enabled: false } }));

	const child = execFile(process.execPath, [bin, "run", "--dir", root, "--no-worktree"], {
		env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), "sw-sig-home-")) },
	});
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	for (let i = 0; i < 200 && !existsSync(pidFile); i++) await tick(100);
	const agentPid = Number((await readFile(pidFile, "utf8")).trim());
	assert.ok(alive(agentPid), "the fake agent is running");

	child.kill("SIGTERM");
	await tick(300);
	child.kill("SIGTERM");
	assert.equal(await exited, 143);
	for (let i = 0; i < 50 && alive(agentPid); i++) await tick(100);
	assert.equal(alive(agentPid), false, "the agent process must not outlive the runner");
	assert.equal(existsSync(join(root, "STOP")), false);
});

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
