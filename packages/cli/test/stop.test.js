import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openRunState } from "shiftwork-core";
import { stop } from "../src/stop.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));

async function repo() {
	return mkdtemp(join(tmpdir(), "sw-stop-"));
}

function capture() {
	const out = [];
	const err = [];
	return { out, err, log: (l) => out.push(l), error: (l) => err.push(l) };
}

async function liveRunner(root, patch) {
	await openRunState(root).update({ pid: process.pid, running: true, ...patch });
}

/** A child process that stays alive until killed: a runner pid other than this one. */
function sleeper(t) {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	t.after(() => child.kill("SIGKILL"));
	return child;
}

test("no live runner: nothing to stop, STOP not written, exit 0", async () => {
	const root = await repo();
	const io = capture();
	assert.equal(await stop(["--dir", root], io), 0);
	assert.match(io.out.join("\n"), /No runner is running: nothing to stop/);
	assert.equal(existsSync(join(root, "STOP")), false);
});

test("a runner whose pid is gone is not live", async () => {
	const root = await repo();
	await openRunState(root).update({ pid: 999999, running: true });
	const io = capture();
	assert.equal(await stop(["--dir", root], io), 0);
	assert.equal(existsSync(join(root, "STOP")), false);
});

test("a live run: STOP written with the runner pid and mode", async () => {
	const root = await repo();
	await liveRunner(root, {});
	const io = capture();
	assert.equal(await stop(["--dir", root], io), 0);
	assert.match(await readFile(join(root, "STOP"), "utf8"), /^Stopped from shiftwork stop at \d{4}-/);
	assert.match(io.out[0], new RegExp(`^STOP file written · runner pid ${process.pid} \\(run\\) hands off and stops$`));
});

test("--dark-factory stops a live dark-factory runner", async () => {
	const root = await repo();
	await liveRunner(root, { mode: "dark-factory" });
	const io = capture();
	assert.equal(await stop(["--dark-factory", "--dir", root], io), 0);
	assert.ok(existsSync(join(root, "STOP")));
	assert.match(io.out[0], /runner pid \d+ \(dark-factory\) hands off and stops/);
});

test("--dark-factory refuses while a plain run is live, writes nothing, exit 1", async () => {
	const root = await repo();
	await liveRunner(root, {});
	const io = capture();
	assert.equal(await stop(["--dark-factory", "--dir", root], io), 1);
	assert.equal(existsSync(join(root, "STOP")), false);
	assert.match(io.err.join("\n"), /no dark-factory runner is live, runner pid \d+ \(run\) is/);
});

test("--dark-factory refuses when a plain run is live next to the dark-factory one", async (t) => {
	const root = await repo();
	const child = sleeper(t);
	await liveRunner(root, { mode: "dark-factory" });
	await openRunState(root).update({ pid: child.pid, running: true });
	const io = capture();
	assert.equal(await stop(["--dark-factory", "--dir", root], io), 1);
	assert.equal(existsSync(join(root, "STOP")), false);
	assert.match(io.err.join("\n"), /STOP would stop it too/);
});

test("--dark-factory with nothing live: exit 0, STOP not written", async () => {
	const root = await repo();
	const io = capture();
	assert.equal(await stop(["--dark-factory", "--dir", root], io), 0);
	assert.match(io.out.join("\n"), /No dark-factory runner is running/);
	assert.equal(existsSync(join(root, "STOP")), false);
});

test("an existing STOP file is kept as it is", async () => {
	const root = await repo();
	await liveRunner(root, {});
	await writeFile(join(root, "STOP"), "operator\n");
	const io = capture();
	assert.equal(await stop(["--dir", root], io), 0);
	assert.equal(await readFile(join(root, "STOP"), "utf8"), "operator\n");
	assert.match(io.out[0], /STOP file already there/);
});

test("--force also sends SIGTERM to the runner pid", async () => {
	const root = await repo();
	await liveRunner(root, {});
	const io = capture();
	const sent = [];
	assert.equal(await stop(["--force", "--dir", root], { ...io, kill: (pid, sig) => sent.push([pid, sig]) }), 0);
	assert.deepEqual(sent, [[process.pid, "SIGTERM"]]);
	assert.ok(existsSync(join(root, "STOP")));
});

test("--wait polls until the runner is gone, then removes the STOP it wrote", async (t) => {
	const root = await repo();
	const child = sleeper(t);
	await openRunState(root).update({ pid: child.pid, running: true, mode: "dark-factory" });
	const io = capture();
	setTimeout(() => child.kill("SIGKILL"), 150);
	assert.equal(await stop(["--wait", "5", "--dir", root], { ...io, pollMs: 20 }), 0);
	assert.match(io.out.at(-1), /Runner stopped · STOP file removed/);
	assert.equal(existsSync(join(root, "STOP")), false);
});

test("--wait times out with exit 1 and leaves STOP", async () => {
	const root = await repo();
	await liveRunner(root, {});
	const io = capture();
	assert.equal(await stop(["--dir", root, "--wait", "0.2"], { ...io, pollMs: 20 }), 1);
	assert.match(io.err.join("\n"), /still live after 0.2 s/);
	assert.ok(existsSync(join(root, "STOP")));
});

test("--wait with no seconds waits up to the default", async () => {
	const root = await repo();
	const io = capture();
	// Nothing live: it returns at once whatever the timeout.
	assert.equal(await stop(["--wait", "--dir", root], io), 0);
});

test("bin: shiftwork stop is dispatched and listed in the help", async () => {
	const root = await repo();
	const exec = promisify(execFile);
	const { stdout } = await exec(process.execPath, [bin, "stop", "--dir", root]);
	assert.match(stdout, /No runner is running/);
	const help = await exec(process.execPath, [bin, "--help"]);
	assert.match(help.stdout, /shiftwork stop \[--dark-factory\]/);
	await liveRunner(root, {});
	await assert.rejects(exec(process.execPath, [bin, "stop", "--dark-factory", "--dir", root]), (e) => e.code === 1);
});

test("stop -h / --help prints the stop command's help and writes nothing", async () => {
	for (const flag of ["-h", "--help"]) {
		const root = await repo();
		await liveRunner(root, {});
		const io = capture();
		assert.equal(await stop([flag, "--dir", root], io), 0);
		assert.match(io.out.join("\n"), /^Usage: shiftwork stop \[--dark-factory\] \[--wait \[sec\]\] \[--force\] \[--dir <path>\]/);
		assert.match(io.out.join("\n"), /--force/);
		assert.deepEqual(io.err, []);
		assert.equal(existsSync(join(root, "STOP")), false);
	}
});

test("an unknown stop option is an error with the usage, not a crash", async () => {
	const io = capture();
	assert.equal(await stop(["--nope"], io), 1);
	assert.match(io.err.join("\n"), /shiftwork stop: .*--nope[\s\S]*Usage: shiftwork stop/);
});
