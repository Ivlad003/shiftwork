import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lockPath, withLock } from "../src/index.js";

/** A pid that once existed but is gone now: spawn a process and wait for it to exit. */
async function deadPid() {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	await new Promise((resolve) => child.on("exit", resolve));
	return child.pid;
}

test("the lock file lives at .shiftwork/shiftwork.lock and is removed after the section", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	assert.equal(lockPath(root), join(root, ".shiftwork", "shiftwork.lock"));

	await withLock(root, async () => {
		const owner = JSON.parse(await readFile(lockPath(root), "utf8"));
		assert.equal(owner.pid, process.pid);
		assert.ok(owner.token);
	});

	await assert.rejects(readFile(lockPath(root)), { code: "ENOENT" });
});

test("a lock left by a dead pid is taken over", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	await mkdir(join(root, ".shiftwork"), { recursive: true });
	await writeFile(lockPath(root), JSON.stringify({ pid: await deadPid(), token: "left behind" }));

	const startedAt = Date.now();
	await withLock(root, async () => "ran");
	assert.ok(Date.now() - startedAt < 5_000, "a stale lock must not be waited for");
});

test("a lock held by a live pid is waited for", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	const order = [];
	const held = withLock(root, async () => {
		order.push("first section");
		await new Promise((resolve) => setTimeout(resolve, 150));
	});

	await new Promise((resolve) => setTimeout(resolve, 50)); // let the first one take the lock
	await withLock(root, async () => {
		order.push("second section");
	});
	await held;

	assert.deepEqual(order, ["first section", "second section"]);
});

test("sections never interleave: two writers through the same lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	const entries = [];
	await Promise.all(
		[1, 2].flatMap((writer) =>
			[...Array(20).keys()].map((i) =>
				withLock(root, async () => {
					entries.push(`${writer}-${i}`);
				}),
			),
		),
	);
	assert.equal(entries.length, 40);
	// Every section is one atomic unit: all 20 of one writer's entries are there.
	assert.equal(entries.filter((e) => e.startsWith("1-")).length, 20);
	assert.equal(entries.filter((e) => e.startsWith("2-")).length, 20);
});

test("a lock file whose owner is still being written is held, not stale", async () => {
	// createExclusive opens the file before it writes the owner: a waiter that reads it in
	// between sees an empty file and must wait, not take the lock over.
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	await mkdir(join(root, ".shiftwork"), { recursive: true });
	await writeFile(lockPath(root), "");
	let entered = false;
	const waiting = withLock(root, async () => {
		entered = true;
	}, { timeoutMs: 5_000, stepMs: 10 });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(entered, false, "must wait while the owner is being written");
	await rm(lockPath(root));
	await waiting;
	assert.equal(entered, true);
});

test("a named lock is its own file, and a live holder is never taken over without a timeout", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	assert.equal(lockPath(root, "land"), join(root, ".shiftwork", "shiftwork-land.lock"));
	await mkdir(join(root, ".shiftwork"), { recursive: true });
	// A live holder (this process) of the land lock; the shared-state lock stays free.
	await writeFile(lockPath(root, "land"), JSON.stringify({ pid: process.pid, token: "landing" }));
	assert.equal(await withLock(root, async () => "shared is free", { timeoutMs: 100 }), "shared is free");

	let entered = false;
	const waiting = withLock(root, async () => {
		entered = true;
	}, { name: "land", timeoutMs: Infinity, stepMs: 10 });
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(entered, false, "a live landing is waited for, however long");
	await rm(lockPath(root, "land"));
	await waiting;
	assert.equal(entered, true);
});
