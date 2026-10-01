import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openTracker, orderFrontier } from "../src/index.js";
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

const START = "<!-- shiftwork:tickets:start -->";
const END = "<!-- shiftwork:tickets:end -->";

// The feature-by-feature frontier order (spec: work the frontier feature by feature).

const plainTicket = (feature, number, status = "ready-for-agent") => ({ feature, number, status, blockedBy: [] });

const ids = (tickets) => tickets.map((t) => `${t.feature}/${t.number}`);

test("orderFrontier: started features before not started, then feature name, then number", () => {
	const tickets = [
		plainTicket("a", "01"),
		plainTicket("a", "02"),
		plainTicket("b", "01", "resolved"),
		plainTicket("b", "02"),
		plainTicket("c", "01"),
		plainTicket("c", "02", "claimed"),
	];
	const page = [plainTicket("c", "01"), plainTicket("a", "01"), plainTicket("b", "02"), plainTicket("a", "02")];

	assert.deepEqual(ids(orderFrontier(page, tickets)), ["b/02", "c/01", "a/01", "a/02"]);
});

test("orderFrontier: the current feature goes before every other", () => {
	const tickets = [
		plainTicket("a", "01", "resolved"),
		plainTicket("a", "02"),
		plainTicket("b", "01", "resolved"),
		plainTicket("b", "02"),
	];
	const page = [plainTicket("b", "02"), plainTicket("a", "02")];

	assert.deepEqual(ids(orderFrontier(page, tickets, { current: "b" })), ["b/02", "a/02"]);
	assert.deepEqual(ids(orderFrontier(page, tickets, { current: "a" })), ["a/02", "b/02"]);
});

test("orderFrontier: among not started features, feature name then ticket number", () => {
	const tickets = [plainTicket("b", "02"), plainTicket("b", "01"), plainTicket("a", "02"), plainTicket("a", "01")];
	const page = [plainTicket("b", "02"), plainTicket("a", "02"), plainTicket("b", "01"), plainTicket("a", "01")];

	assert.deepEqual(ids(orderFrontier(page, tickets)), ["a/01", "a/02", "b/01", "b/02"]);
});

test("frontier() returns the feature-by-feature order, an orphaned claim included", async () => {
	const root = await makeRepo({
		"a/01-a.md": ticket("01", "A"),
		"b/01-b.md": ticket("01", "B", { status: "resolved" }),
		"b/02-b.md": ticket("02", "B2"),
		"c/01-c.md": ticket("01", "C", { status: "claimed" }),
	});
	const tracker = openTracker(root);
	const orphan = (await tracker.list()).find((t) => t.feature === "c");
	await tracker.claim(orphan, { pid: await deadPid() });

	const frontier = await tracker.frontier();

	assert.deepEqual(ids(frontier), ["b/02", "c/01", "a/01"]);
});

test("setStatus updates the spec table and leaves bytes outside the markers unchanged", async () => {
	const prefix = "# Spec\n\nKeep this `code` and <!-- comment -->.\n\n";
	const suffix = "\n\nFooter must stay.\n";
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	await writeFile(join(root, ".scratch", "f", "spec.md"), `${prefix}${START}\nOLD TABLE\n${END}${suffix}`);
	const tracker = openTracker(root);
	const [t] = await tracker.list();

	await tracker.setStatus(t, "resolved");

	const spec = await readFile(join(root, ".scratch", "f", "spec.md"), "utf8");
	assert.equal(spec.slice(0, prefix.length), prefix);
	assert.equal(spec.slice(spec.indexOf(END) + END.length), suffix);
	assert.equal(spec.includes("OLD TABLE"), false);
	const table = spec.slice(spec.indexOf(START) + START.length, spec.indexOf(END));
	assert.match(table, /\|\s*NN\s*\|\s*title\s*\|\s*status\s*\|\s*last route\s*\|/);
	assert.match(table, /\|\s*01\s*\|\s*A\s*\|\s*resolved\s*\|\s*\|/);
});

test("missing spec markers are appended once, and a missing spec.md is left alone", async () => {
	const body = "# Spec\n\nStories.\n";
	const withSpec = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	await writeFile(join(withSpec, ".scratch", "f", "spec.md"), body);
	const tracker = openTracker(withSpec);
	const [t] = await tracker.list();

	await tracker.setStatus(t, "claimed");
	await tracker.setStatus(t, "resolved");

	const spec = await readFile(join(withSpec, ".scratch", "f", "spec.md"), "utf8");
	assert.equal(spec.startsWith(body), true);
	assert.equal(spec.split(START).length - 1, 1);
	assert.equal(spec.split(END).length - 1, 1);
	assert.match(spec, /\|\s*01\s*\|\s*A\s*\|\s*resolved\s*\|/);

	const noSpec = await makeRepo({ "g/01-b.md": ticket("01", "B") });
	const other = openTracker(noSpec);
	const [u] = await other.list();
	await other.setStatus(u, "resolved");
	await assert.rejects(readFile(join(noSpec, ".scratch", "g", "spec.md")), { code: "ENOENT" });
});

test("the last route column shows the model of the latest shift report", async () => {
	const extra = [
		"",
		"## Comments",
		"",
		"### Shift 1 — fake fake/m1 (low)",
		"- Ended: ok",
		"",
		"### Shift 2 — fake anthropic/sonnet (medium)",
		"- Ended: ok",
		"",
	].join("\n");
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A", { extra }) });
	await writeFile(
		join(root, ".scratch", "f", "spec.md"),
		`# Spec\n\n${START}\n${END}\n`,
	);
	const tracker = openTracker(root);
	const [t] = await tracker.list();

	await tracker.setStatus(t, "claimed");

	const spec = await readFile(join(root, ".scratch", "f", "spec.md"), "utf8");
	assert.match(spec, /\|\s*01\s*\|\s*A\s*\|\s*claimed\s*\|\s*anthropic\/sonnet\s*\|/);
	assert.equal(spec.includes("fake/m1"), false);
});

function deadPid() {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", ""]);
		child.on("exit", () => resolve(child.pid));
	});
}

test("the spec table ignores markers mentioned in prose and fills the block on its own lines", async () => {
	const { writeFile, readFile: rf } = await import("node:fs/promises");
	const root = await makeRepo({ "f/01-a.md": ticket("01", "A") });
	const spec = [
		"# Spec",
		"",
		"The table lives between `<!-- shiftwork:tickets:start -->` and `<!-- shiftwork:tickets:end -->`.",
		"",
		"<!-- shiftwork:tickets:start -->",
		"<!-- shiftwork:tickets:end -->",
		"",
	].join("\n");
	await writeFile(`${root}/.scratch/f/spec.md`, spec);
	const tracker = openTracker(root);

	await tracker.setStatus((await tracker.list())[0], "claimed");

	const text = await rf(`${root}/.scratch/f/spec.md`, "utf8");
	assert.ok(text.includes("The table lives between `<!-- shiftwork:tickets:start -->` and `<!-- shiftwork:tickets:end -->`."));
	assert.match(text, /<!-- shiftwork:tickets:start -->\n\| NN \|[\s\S]*\| 01 \| A \| claimed \|[\s\S]*\n<!-- shiftwork:tickets:end -->\n$/);
});
