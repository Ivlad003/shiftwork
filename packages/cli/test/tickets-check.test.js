import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkFeatureTickets, parseExcept, resolveTrackerRoot } from "../src/tickets-check.js";

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

const plan = (status = "resolved", comments = "") => `# 01: Plan\n\n**Blocked by:** None\n\n**Status:** ${status}\n\n**Type:** plan\n${comments}`;

/** The runner's record that the plan shift asked: its shift report's `- Outcome: needs-info: …` line. */
const asked = "\n## Comments\n\n### Shift 1 — pi glm-5.3 (medium)\n- Ended: stop\n- Outcome: needs-info: Which database should it use?\n";

const ticket = ({ number = "02", title = "Build", status = "ready-for-agent", verify = "`npm test`", checkboxes = 1, blockedBy = "None" } = {}) => {
	const boxes = Array.from({ length: checkboxes }, (_, i) => `- [${i === 0 && checkboxes > 1 ? " " : "x"}] Does thing ${i + 1}`).join("\n");
	return `# ${number}: ${title}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n\n**Verify:** ${verify}\n\n${boxes}\n`;
};

test("passes with one good ticket besides the plan", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-build.md": ticket() });

	const result = await exec(["tickets", "check", "f", "--dir", root]);
	const direct = await checkFeatureTickets({ root, feature: "f" });

	assert.equal(result.code, 0);
	assert.equal(result.stdout, `f: 1 ready ticket besides 01 (need 1)\n`);
	assert.equal(direct.ok, true);
	assert.equal(direct.ready, 1);
});

test("a needs-info plan with no implementation tickets passes", async () => {
	const root = await repo({ "f/01-plan.md": plan("needs-info", asked) });

	const result = await exec(["tickets", "check", "f", "--dir", root]);
	const direct = await checkFeatureTickets({ root, feature: "f" });

	assert.equal(result.code, 0);
	assert.equal(result.stdout, "f: plan needs information; no implementation tickets required\n");
	assert.equal(direct.ok, true);
	assert.equal(direct.asked, true);
	assert.equal(direct.ready, 0);
});

test("the importer's Shift 0 needs-info outcome counts as the plan having asked", async () => {
	const imported = "\n## Comments\n\n### Shift 0 — import\n- Outcome: needs-info: The issue has no description. What should Shiftwork build?\n";
	const direct = await checkFeatureTickets({ root: await repo({ "f/01-plan.md": plan("needs-info", imported) }), feature: "f" });
	assert.equal(direct.ok, true);
	assert.equal(direct.asked, true);
});

test("a plan that set needs-info itself, with no runner-recorded outcome, does not pass", async () => {
	for (const comments of [
		"",
		"\n## Comments\n\n### Shift 1 — pi glm-5.3 (medium)\n- Outcome: new attempt\n",
		// An earlier needs-info outcome, answered since: the latest outcome is what counts.
		"\n## Comments\n\n### Shift 1 — pi glm-5.3\n- Outcome: needs-info: Which db?\n\n### Shift 2 — pi glm-5.3\n- Outcome: new attempt\n",
		// The line outside ## Comments is the agent's text, not the runner's record.
		"\n- Outcome: needs-info: I wrote this myself\n",
	]) {
		const root = await repo({ "f/01-plan.md": plan("needs-info", comments) });
		const direct = await checkFeatureTickets({ root, feature: "f" });
		assert.equal(direct.ok, false, comments);
		assert.equal(direct.asked, undefined);
		assert.match(direct.problems.join("\n"), /only 0 of 1 required ticket ready/);
	}
});

test("a needs-info plan still rejects a ready ticket that is missing its gate", async () => {
	const root = await repo({
		"f/01-plan.md": plan("needs-info", asked),
		"f/02-build.md": ticket({ verify: "", checkboxes: 0 }),
	});

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 1);
	assert.match(result.stdout, /f\/02: no acceptance checkboxes/);
	assert.doesNotMatch(result.stdout, /plan needs information/);
});

test("a needs-info plan with a good implementation ticket still counts that ticket", async () => {
	const root = await repo({ "f/01-plan.md": plan("needs-info", asked), "f/02-build.md": ticket() });

	const result = await exec(["tickets", "check", "f", "--dir", root]);

	assert.equal(result.code, 0);
	assert.equal(result.stdout, "f: 1 ready ticket besides 01 (need 1)\n");
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

	assert.match(stdout, /shiftwork tickets check <feature> \[--min <n>\] \[--except NN\] \[--dir <path>\]/);
	assert.match(stdout, /shiftwork github labels \[--create\] \[--dir <path>\]/);
});

test("an unknown github subcommand prints help and exits 1", async () => {
	const result = await exec(["github", "nope"]);
	assert.equal(result.code, 1);
	assert.match(result.stdout, /shiftwork github labels \[--create\] \[--dir <path>\]/);
});

const execCwd = async (args, cwd) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	const cache = await mkdtemp(join(tmpdir(), "sw-cache-"));
	return promisify(execFile)(process.execPath, [bin, ...args], {
		cwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CACHE_HOME: cache },
	}).then(
		({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
		(error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
	);
};

async function gitRepoWithTickets() {
	const { execFileSync } = await import("node:child_process");
	const main = await mkdtemp(join(tmpdir(), "sw-check-main-"));
	const git = (...args) => execFileSync("git", args, { cwd: main, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	await writeFile(join(main, "README.md"), "# t\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "init");
	await mkdir(join(main, ".scratch", "f", "issues"), { recursive: true });
	await writeFile(join(main, ".scratch", "f", "issues", "01-plan.md"), plan());
	await writeFile(join(main, ".scratch", "f", "issues", "02-build.md"), ticket());
	return { main, git };
}

test("tickets check from a linked worktree reads the main checkout's .scratch", async () => {
	const { main, git } = await gitRepoWithTickets();
	const wt = await mkdtemp(join(tmpdir(), "sw-check-wt-"));
	await rmdir(wt);
	git("worktree", "add", "--detach", wt);

	const result = await execCwd(["tickets", "check", "f"], wt);

	assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
	assert.match(result.stdout, /f: 1 ready ticket besides 01 \(need 1\)/);
});

test("--dir pointing at an empty directory does not fall back to the main checkout", async () => {
	const { git } = await gitRepoWithTickets();
	const wt = await mkdtemp(join(tmpdir(), "sw-check-wt-"));
	await rmdir(wt);
	git("worktree", "add", "--detach", wt);
	const empty = await mkdtemp(join(tmpdir(), "sw-check-empty-"));

	const result = await execCwd(["tickets", "check", "f", "--dir", empty], wt);

	assert.equal(result.code, 1);
	assert.match(result.stdout, /f: no tickets found in \.scratch\/f\/issues/);
});

test("resolveTrackerRoot keeps cwd for a non-git directory and a normal clone", async () => {
	const { main } = await gitRepoWithTickets();
	const plain = await mkdtemp(join(tmpdir(), "sw-check-plain-"));
	assert.equal(await resolveTrackerRoot({ cwd: plain }), plain);
	assert.equal(await resolveTrackerRoot({ cwd: main }), main);
});

test("resolveTrackerRoot honours dir without calling git", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sw-check-dir-"));
	let called = false;
	const root = await resolveTrackerRoot({
		cwd: "/tmp",
		dir,
		exec: async () => {
			called = true;
			return "";
		},
	});
	assert.equal(root, dir);
	assert.equal(called, false);
});

test("resolveTrackerRoot keeps a subdirectory cwd of a normal clone", async () => {
	const { main } = await gitRepoWithTickets();
	const sub = join(main, "packages", "x");
	await mkdir(sub, { recursive: true });
	assert.equal(await resolveTrackerRoot({ cwd: sub }), sub);
});

test("resolveTrackerRoot asks git for absolute paths and returns the first worktree of a linked worktree", async () => {
	const calls = [];
	const replies = {
		"rev-parse --path-format=absolute --git-dir": "/repo/.git/worktrees/wt\n",
		"rev-parse --path-format=absolute --git-common-dir": "/repo/.git\n",
		"worktree list --porcelain": "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt\nHEAD def\ndetached\n",
	};
	const root = await resolveTrackerRoot({
		cwd: "/wt",
		exec: async (args) => {
			calls.push(args.join(" "));
			assert.equal(args[0], "git");
			const reply = replies[args.slice(1).join(" ")];
			if (reply === undefined) throw new Error(`unexpected ${args.join(" ")}`);
			return reply;
		},
	});
	assert.equal(root, "/repo");
	assert.ok(calls.includes("git worktree list --porcelain"));
});

test("resolveTrackerRoot keeps cwd when git reports the same absolute git and common dirs", async () => {
	const root = await resolveTrackerRoot({
		cwd: "/repo/sub",
		exec: async (args) => {
			if (args.includes("--git-dir") || args.includes("--git-common-dir")) return "/repo/.git\n";
			throw new Error(`unexpected ${args.join(" ")}`);
		},
	});
	assert.equal(root, "/repo/sub");
});

test("resolveTrackerRoot keeps cwd when git fails (not a repository)", async () => {
	const root = await resolveTrackerRoot({
		cwd: "/nowhere",
		exec: async () => {
			throw new Error("fatal: not a git repository");
		},
	});
	assert.equal(root, "/nowhere");
});

test("a ticket blocked by itself fails and does not count", async () => {
	const root = await repo({ "f/01-plan.md": plan(), "f/02-a.md": ticket({ number: "02", blockedBy: "02" }) });
	const direct = await checkFeatureTickets({ root, feature: "f" });
	assert.equal(direct.ok, false);
	assert.equal(direct.ready, 0);
	assert.ok(direct.problems.includes("f/02: blocked by itself"), direct.problems.join("\n"));
	assert.ok(!direct.problems.some((p) => p.includes("blocker cycle")), direct.problems.join("\n"));
});

test("a 2-cycle is named once and its tickets do not count toward --min", async () => {
	const root = await repo({
		"f/01-plan.md": plan(),
		"f/02-ok.md": ticket({ number: "02" }),
		"f/03-a.md": ticket({ number: "03", blockedBy: "04" }),
		"f/04-b.md": ticket({ number: "04", blockedBy: "03" }),
	});
	const direct = await checkFeatureTickets({ root, feature: "f" });
	assert.equal(direct.ok, false);
	assert.equal(direct.ready, 1);
	assert.deepEqual(
		direct.problems.filter((p) => p.includes("cycle")),
		["f: blocker cycle 03 → 04 → 03"],
	);

	const result = await exec(["tickets", "check", "f", "--dir", root]);
	assert.equal(result.code, 1);
	assert.match(result.stdout, /^f: blocker cycle 03 → 04 → 03$/m);
});

test("a 3-cycle starts at its lowest number, and the excepted plan ticket is covered", async () => {
	const root = await repo({
		"f/01-plan.md": plan().replace("**Blocked by:** None", "**Blocked by:** 03"),
		"f/02-a.md": ticket({ number: "02", blockedBy: "01" }),
		"f/03-b.md": ticket({ number: "03", blockedBy: "02" }),
		"f/04-ok.md": ticket({ number: "04" }),
	});
	const direct = await checkFeatureTickets({ root, feature: "f" });
	assert.equal(direct.ok, false);
	assert.equal(direct.ready, 1);
	assert.deepEqual(
		direct.problems.filter((p) => p.includes("cycle")),
		["f: blocker cycle 01 → 03 → 02 → 01"],
	);
});

test("an acyclic diamond passes", async () => {
	const root = await repo({
		"f/01-plan.md": plan(),
		"f/02-a.md": ticket({ number: "02", blockedBy: "01" }),
		"f/03-b.md": ticket({ number: "03", blockedBy: "01" }),
		"f/04-c.md": ticket({ number: "04", blockedBy: "02, 03" }),
	});
	const direct = await checkFeatureTickets({ root, feature: "f", min: 3 });
	assert.deepEqual(direct.problems, []);
	assert.equal(direct.ok, true);
	assert.equal(direct.ready, 3);
});
