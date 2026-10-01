import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkFeatureTickets, parseExcept } from "../src/tickets-check.js";

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

/** A temp repo with `.scratch/<feature>/issues/` tickets, `{ "<feature>/<file>": body }`. */
async function repo(tickets) {
	const root = await mkdtemp(join(tmpdir(), "sw-check-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "issues", file), body);
	}
	return root;
}

const plan = (status = "resolved") => `# 01: Plan\n\n**Blocked by:** None\n\n**Status:** ${status}\n\n**Type:** plan\n`;

const ticket = ({ number = "02", title = "Build", status = "ready-for-agent", verify = "`npm test`", checkboxes = 1, blockedBy = "None" } = {}) => {
	const boxes = Array.from({ length: checkboxes }, (_, i) => `- [${i === 0 && checkboxes > 1 ? " " : "x"}] Does thing ${i + 1}`).join("\n");
	return `# ${number}: ${title}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n\n**Verify:** ${verify}\n\n${boxes}\n`;
};

test("passes with one good ticket besides the plan", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket() });

	const result = await exec(["tickets", "check", "f", "--dir", root]);
	const direct = await checkFeatureTickets({ root, feature: "f" });

	assert.deepEqual(result, { code: 0, stdout: `f: 1 ready ticket besides 01 (need 1)\n`, stderr: "" });
	assert.equal(direct.ok, true);
	assert.equal(direct.ready, 1);
});

test("fails with only the plan ticket", async () => {
	const root = await repo({ "f/01-plan.md": plan() });

	const result = await exec(["tickets", "check", "f", "--dir", root]);
	const direct = await checkFeatureTickets({ root, feature: "f" });

	assert.equal(result.code, 1);
	assert.match(result.stdout, /f: only 0 of 1 required ticket ready besides 01/);
	assert.equal(direct.ok, false);
});

test("fails on a feature with no tickets", async () => {
	const root = await repo({ "f/01-plan.md": plan() });

	const result = await exec(["tickets", "check", "other", "--dir", root]);

	assert.equal(result.code, 1);
	assert.match(result.stdout, /other: no tickets found in \.scratch\/other\/issues/);
});

test("fails on a ready ticket without a Verify line", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket({ verify: "" }) });

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 1);
	assert.match(result.stdout, /f\/02: no Verify line/);
});

test("fails on a ready ticket without acceptance checkboxes", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket({ checkboxes: 0 }) });

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 1);
	assert.match(result.stdout, /f\/02: no acceptance checkboxes/);
});

test("fails on a ticket blocked by a number missing from the feature", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket(), "f/03-late.md": ticket({ number: "03", blockedBy: "99" }) });

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 1);
	assert.match(result.stdout, /f\/03: blocked by missing 99/);
});

test("a ticket blocked by the resolved plan is fine: blocked-by numbers may be excepted tickets", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket({ blockedBy: "01" }) });

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 0);
});

test("tickets before ready (needs-info, needs-triage) neither count nor fail", async () => {
	const root = await repo({
		"f/01-plan.md": plan(),
		"f/02-build.md": ticket(),
		"f/03-later.md": ticket({ number: "03", status: "needs-info", verify: "", checkboxes: 0 }),
	});

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 0);
});

test("claimed and resolved tickets count as ready or later", async () => {
	const root = await repo({
		"f/01-plan.md": plan(),
		"f/02-claimed.md": ticket({ status: "claimed" }),
		"f/03-resolved.md": ticket({ number: "03", status: "resolved" }),
	});

	const result = await exec(["tickets", "check", "f", "--min", "2", "--dir", root]);

	assert.equal(result.code, 0);
	assert.match(result.stdout, /f: 2 ready tickets besides 01 \(need 2\)/);
});

test("--min 2 fails with one good ticket and passes with two", async () => {
	const one = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket() });
	const two = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket(), "f/03-more.md": ticket({ number: "03" }) });

	const fail = await exec(["tickets", "check", "f", "--min", "2", "--dir", one]);
	const pass = await exec(["tickets", "check", "f", "--min", "2", "--dir", two]);

	assert.equal(fail.code, 1);
	assert.match(fail.stdout, /f: only 1 of 2 required tickets ready besides 01/);
	assert.equal(pass.code, 0);
});

test("--except moves the exclusion (comma-separated, repeatable, padded)", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-skip.md": ticket(), "f/03-build.md": ticket({ number: "03" }) });

	const result = await exec(["tickets", "check", "f", "--except", "01,2", "--dir", root]);
	const repeated = await exec(["tickets", "check", "f", "--except", "01", "--except", "02", "--dir", root]);

	assert.equal(result.code, 0);
	assert.match(result.stdout, /f: 1 ready ticket besides 01, 02 \(need 1\)/);
	assert.equal(repeated.code, 0);
	assert.match(repeated.stdout, /f: 1 ready ticket besides 01, 02 \(need 1\)/);
});

test("a failure prints one line per problem ticket, naming each reason", async () => {
	const root = await repo({
		"f/01-plan.md": plan(),
		"f/02-broken.md": ticket({ verify: "", checkboxes: 0 }),
		"f/03-ghost.md": ticket({ number: "03", blockedBy: "77" }),
	});

	const result = await exec(["tickets", "check", "f", "--dir", root]);
	const lines = result.stdout.trim().split("\n");

	assert.equal(result.code, 1);
	assert.deepEqual(lines, [
		"f/02: no acceptance checkboxes",
		"f/02: no Verify line",
		"f/03: blocked by missing 77",
		"f: only 0 of 1 required ticket ready besides 01",
	]);
});

test("parseExcept normalizes numbers, commas and repeats", () => {
	assert.deepEqual(parseExcept(["01,03", "2"]), ["01", "03", "02"]);
	assert.deepEqual(parseExcept("1"), ["01"]);
	assert.deepEqual(parseExcept([]), []);
});

test("a bad --min is an error", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket() });

	const result = await exec(["tickets", "check", "f", "--min", "x", "--dir", root]);

	assert.equal(result.code, 1);
	assert.match(result.stderr, /--min must be a positive integer/);
});

test("shiftwork --help lists the command", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	const { stdout } = await promisify(execFile)(process.execPath, [bin, "--help"], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.match(stdout, /shiftwork tickets check <feature> \[--min <n>\] \[--except NN\]/);
});
