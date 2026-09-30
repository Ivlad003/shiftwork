import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("the lock file lives at .pi/shiftwork.lock and is removed after the section", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	assert.equal(lockPath(root), join(root, ".pi", "shiftwork.lock"));

	await withLock(root, async () => {
		const owner = JSON.parse(await readFile(lockPath(root), "utf8"));
		assert.equal(owner.pid, process.pid);
		assert.ok(owner.token);
	});

	await assert.rejects(readFile(lockPath(root)), { code: "ENOENT" });
});

test("a lock left by a dead pid is taken over", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-lock-"));
	await mkdir(join(root, ".pi"), { recursive: true });
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
