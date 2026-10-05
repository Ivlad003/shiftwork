import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { featureGraph } from "../src/graph.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = async (args) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	}).then(
		({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
		(error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
	);
};

const t = (number, title, status = "ready-for-agent", blockedBy = []) => ({ feature: "f", number, title, status, blockedBy });
const lines = (text) => text.split("\n");

test("a linear chain: one node per ticket, an edge from blocker to blocked, status in the label", () => {
	const graph = featureGraph([t("01", "Plan", "resolved"), t("02", "Build", "ready-for-agent", ["01"]), t("03", "Ship", "needs-info", ["02"])], "f");
	const rows = lines(graph);
	assert.equal(rows[0], "flowchart TD");
	assert.ok(rows.includes('  t01["01 Plan · resolved"]:::resolved'), graph);
	assert.ok(rows.includes('  t02["02 Build · ready"]:::ready'), graph);
	assert.ok(rows.includes('  t03["03 Ship · needs-info"]:::needsinfo'), graph);
	assert.ok(rows.includes("  t01 --> t02"), graph);
	assert.ok(rows.includes("  t02 --> t03"), graph);
	for (const cls of ["resolved", "ready", "needsinfo", "claimed", "other", "missing"]) {
		assert.ok(rows.some((row) => row.startsWith(`  classDef ${cls} `)), `classDef ${cls}`);
	}
});

test("a diamond draws one edge per blocker", () => {
	const graph = featureGraph([t("01", "A"), t("02", "B", "claimed", ["01"]), t("03", "C", "ready-for-agent", ["01"]), t("04", "D", "needs-triage", ["02", "03"])], "f");
	const edges = lines(graph).filter((row) => row.includes("-->"));
	assert.deepEqual(edges, ["  t01 --> t02", "  t01 --> t03", "  t02 --> t04", "  t03 --> t04"]);
	assert.ok(graph.includes('t02["02 B · claimed"]:::claimed'));
	assert.ok(graph.includes('t04["04 D · needs-triage"]:::other'));
});

test("a missing blocker is drawn as a dashed node", () => {
	const graph = featureGraph([t("01", "A"), t("02", "B", "ready-for-agent", ["07"])], "f");
	assert.ok(lines(graph).includes('  t07["07 missing"]:::missing'), graph);
	assert.ok(lines(graph).includes("  t07 --> t02"), graph);
	assert.match(graph, /classDef missing [^\n]*stroke-dasharray/);
});

test("cycle edges are drawn as -.->|cycle|", () => {
	const graph = featureGraph([t("01", "A"), t("02", "B", "ready-for-agent", ["01"]), t("03", "C", "ready-for-agent", ["04"]), t("04", "D", "ready-for-agent", ["03"]), t("05", "E", "ready-for-agent", ["05"])], "f");
	const rows = lines(graph);
	assert.ok(rows.includes("  t01 --> t02"), graph);
	assert.ok(rows.includes("  t04 -.->|cycle| t03"), graph);
	assert.ok(rows.includes("  t03 -.->|cycle| t04"), graph);
	assert.ok(rows.includes("  t05 -.->|cycle| t05"), graph);
	assert.ok(!rows.includes("  t04 --> t03"), graph);
});

test("titles with quotes and brackets are escaped", () => {
	const graph = featureGraph([t("01", 'Say "hi" [now] <b>')], "f");
	assert.ok(graph.includes('t01["01 Say #quot;hi#quot; #91;now#93; #lt;b#gt; · ready"]'), graph);
});

test("only the named feature's tickets are drawn", () => {
	const graph = featureGraph([t("01", "A"), { ...t("02", "Other"), feature: "g" }], "f");
	assert.ok(!graph.includes("t02"), graph);
});

async function repo(tickets) {
	const root = await mkdtemp(join(tmpdir(), "sw-graph-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "issues", file), body);
	}
	return root;
}
const md = (number, title, blockedBy = "None", status = "ready-for-agent") => `# ${number}: ${title}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n\n- [ ] x\n`;

test("shiftwork graph prints the graph to stdout and cycle problems to stderr", async () => {
	const root = await repo({ "f/01-plan.md": md("01", "Plan", "None", "resolved"), "f/02-a.md": md("02", "A", "03"), "f/03-b.md": md("03", "B", "02") });
	const result = await exec(["graph", "f", "--dir", root]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /^flowchart TD\n/);
	assert.match(result.stdout, /t01\["01 Plan · resolved"\]/);
	assert.match(result.stdout, /t03 -\.->\|cycle\| t02/);
	assert.equal(result.stderr, "f: blocker cycle 02 → 03 → 02\n");
});

test("shiftwork graph on an unknown feature exits 1", async () => {
	const root = await repo({ "f/01-plan.md": md("01", "Plan") });
	const result = await exec(["graph", "nope", "--dir", root]);
	assert.equal(result.code, 1);
	assert.equal(result.stderr, "nope: no tickets found\n");
	assert.equal(result.stdout, "");
});

test("shiftwork help lists graph", async () => {
	const result = await exec(["--help"]);
	assert.match(result.stdout, /shiftwork graph <feature>/);
});
