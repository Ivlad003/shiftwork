import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { openTracker } from "../src/index.js";
import { makeRepo, ticket } from "./helpers.js";

test("claim returns a claim for a free frontier ticket and marks it claimed", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const tracker = openTracker(root);
	const [first] = await tracker.frontier();

	const claim = await tracker.claim(first);

	assert.ok(claim);
	const [after] = await tracker.list();
	assert.equal(after.status, "claimed");
});

test("a ticket claimed by a live process can't be claimed again", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const tracker = openTracker(root);
	const [first] = await tracker.frontier();

	assert.ok(await tracker.claim(first));

	assert.equal(await tracker.claim(first), null);
	assert.deepEqual(await tracker.frontier(), []);
});

test("a claim left by a dead process is taken over", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const tracker = openTracker(root);
	const [first] = await tracker.frontier();
	await tracker.claim(first, { pid: await deadPid() });

	const [orphan] = await tracker.frontier();
	const claim = await tracker.claim(orphan);

	assert.equal(orphan.number, "01");
	assert.ok(claim);
	assert.equal(claim.pid, process.pid);
});

test("setStatus changes only the Status line", async () => {
	const original = [
		"# 01: A",
		"",
		"**What to build:** keep `this` <!-- and this --> exactly.",
		"",
		"**Blocked by:** None (can start immediately)",
		"",
		"**Status:** ready-for-agent",
		"**Type:** code                  <!-- runner: routing key -->",
		"**Verify:** `npm test` · `npm run lint`",
		"",
		"- [x] Done thing",
		"- [ ] Open thing\t",
		"",
		"## Comments",
		"",
		"Earlier note.",
		"",
	].join("\n");
	const root = await makeRepo({ "f/01-a.md": original });
	const tracker = openTracker(root);
	const [t] = await tracker.list();

	await tracker.setStatus(t, "resolved");

	const text = await readFile(t.path, "utf8");
	assert.equal(text, original.replace("**Status:** ready-for-agent", "**Status:** resolved"));
});

test("appendComment creates the Comments section when it's missing", async () => {
	const root = await makeRepo({ "f/01-a.md": "# 01: A\n\n**Status:** ready-for-agent\n\n- [ ] x" });
	const tracker = openTracker(root);
	const [t] = await tracker.list();

	await tracker.appendComment(t, "### Shift 1\nAll good.");

	assert.equal(
		await readFile(t.path, "utf8"),
		"# 01: A\n\n**Status:** ready-for-agent\n\n- [ ] x\n\n## Comments\n\n### Shift 1\nAll good.\n",
	);
});

test("appendComment appends after existing comments", async () => {
	const root = await makeRepo({ "f/01-a.md": "# 01: A\n\n## Comments\n\nFirst.\n" });
	const tracker = openTracker(root);
	const [t] = await tracker.list();

	await tracker.appendComment(t, "Second.");

	assert.equal(await readFile(t.path, "utf8"), "# 01: A\n\n## Comments\n\nFirst.\n\nSecond.\n");
});

test("release lets the ticket be claimed again", async () => {
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const tracker = openTracker(root);
	const [first] = await tracker.frontier();
	const claim = await tracker.claim(first);
	await tracker.setStatus(claim, "ready-for-agent");

	await tracker.release(claim);

	assert.ok(await tracker.claim((await tracker.frontier())[0]));
});

test("a failed write leaves the ticket intact and no temp files behind", { skip: process.getuid?.() === 0 }, async () => {
	const body = ticket("01", "A");
	const root = await makeRepo({ "f/01-a.md": body });
	const tracker = openTracker(root);
	const [t] = await tracker.list();
	const dir = dirname(t.path);
	await chmod(dir, 0o500);

	try {
		await assert.rejects(tracker.setStatus(t, "resolved"));
	} finally {
		await chmod(dir, 0o700);
	}

	assert.equal(await readFile(t.path, "utf8"), body);
	assert.deepEqual(await readdir(dir), ["01-a.md"]);
});

function deadPid() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", ""]);
		child.on("exit", () => resolve(child.pid));
	});
}
