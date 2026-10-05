import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { openRunState, openTracker } from "shiftwork-core";

import { darkFactoryRun, ghAuthMessage, ghInstallMessage, NO_GITHUB_CONFIG_MESSAGE } from "../src/dark-factory.js";
import { missingLabelsMessage } from "../src/github-labels.js";

const run = promisify(execFile);

/** A temp repo root: a real git repo with one initial commit (syncIssues reads landed commits with git log). */
async function makeRoot() {
	const dir = await mkdtemp(join(tmpdir(), "sw-df-"));
	await run("git", ["init", "-q"], { cwd: dir });
	await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await run("git", ["config", "user.name", "Test"], { cwd: dir });
	await writeFile(join(dir, "README.md"), "# test\n");
	await run("git", ["add", "-A"], { cwd: dir });
	await run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	return dir;
}

const LABELS = ["shiftwork:in", "shiftwork:working", "shiftwork:needs-info", "shiftwork:done"];

const config = () => ({
	github: { repo: "owner/name", labels: { in: LABELS[0], working: LABELS[1], needsInfo: LABELS[2], done: LABELS[3] } },
});

/** A stub GitHub: every op recorded, one importable issue by a collaborator. */
function stubGitHub({ labels = [...LABELS], issues = [{ number: 8, title: "Fix the thing", body: "It is broken.", author: "octocat", labels: [LABELS[0]], url: "https://github.com/owner/name/issues/8" }] } = {}) {
	const calls = [];
	const github = {
		async repo() {
			calls.push({ op: "repo" });
			return "owner/name";
		},
		async collaborators() {
			calls.push({ op: "collaborators" });
			return ["octocat"];
		},
		async listIssues() {
			calls.push({ op: "listIssues" });
			return issues.map((issue) => ({ ...issue, state: "open" }));
		},
		async labelActor(n, label) {
			calls.push({ op: "labelActor", n, label });
			return undefined;
		},
		async issueComments(n) {
			calls.push({ op: "issueComments", n });
			return [];
		},
		async comment(n, body) {
			calls.push({ op: "comment", n, body });
			return `https://github.com/owner/name/issues/${n}#comment-${calls.length}`;
		},
		async addLabels(n, list) {
			calls.push({ op: "addLabels", n, list: [...list] });
			return "";
		},
		async removeLabel(n, label) {
			calls.push({ op: "removeLabel", n, label });
			return "";
		},
		async close(n, body) {
			calls.push({ op: "close", n, body });
			return "";
		},
		async listLabels() {
			calls.push({ op: "listLabels" });
			return [...labels];
		},
	};
	return { github, calls };
}

/** A stub runFrontier: records every pass, answers from `summaries` in order (last one repeats). */
function stubFrontier(summaries = []) {
	const passes = [];
	const runFrontierImpl = async (args) => {
		passes.push({ args, tickets: (await args.tracker.list()).map((t) => `${t.feature}/${t.number}`) });
		return { resolved: [], needsInfo: [], reopened: [], ...(summaries[Math.min(passes.length - 1, summaries.length - 1)] ?? {}) };
	};
	return { runFrontierImpl, passes };
}

/** A stub exec for the pre-flight: `gh auth status` passes unless it rejects. */
const okExec = async () => "";

/** A ticket with a shift report on disk, as a poll's frontier pass would leave it. */
async function writeResolvedTicket(root, feature, status = "resolved") {
	const path = join(root, ".scratch", feature, "issues", "02-ticket.md");
	await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
	await writeFile(
		path,
		[
			"# 02: Fix the thing",
			"",
			"**What to build:** Fix it.",
			"",
			`**Status:** ${status}`,
			"",
			"## Comments",
			"",
			"### Shift 1 — pi claude-4-sonnet (medium)",
			"- Ended: done",
			"- Outcome: resolved",
			"",
		].join("\n"),
	);
	return path;
}

/** Collect log/err lines. */
function lines() {
	const out = [];
	const log = (...args) => out.push(args.join(" "));
	return { out, log, err: log };
}

test("--once: imports the issue, syncs it, works one frontier pass, pushes nothing, exits 0", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	const { runFrontierImpl, passes } = stubFrontier([{ resolved: [{ feature: "gh-8-fix-the-thing", number: "02", title: "Fix the thing", reason: "Verify: passed" }] }]);
	const gitCalls = [];
	const { out, log, err } = lines();

	await writeResolvedTicket(root, "gh-8-fix-the-thing");
	const code = await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, push: false } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		git: async (args) => {
			gitCalls.push(args);
			return "";
		},
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		once: true,
		log,
		err,
	});

	assert.equal(code, 0);
	assert.equal(passes.length, 1, "one frontier pass");
	assert.equal(passes[0].args.options.holdOnNeedsInfo, true, "dark-factory holds a feature that asked a question");
	assert.deepEqual(passes[0].tickets, ["gh-8-fix-the-thing/01", "gh-8-fix-the-thing/02"], "the pass works the imported feature");
	assert.ok(out.some((line) => /github#8 imported: Fix the thing → gh-8-fix-the-thing/.test(line)), `import line: ${out}`);
	assert.ok(out.some((line) => /github#8: comment: ticket 02 resolved/.test(line)), `sync line: ${out}`);
	assert.equal(gitCalls.filter((args) => args[0] === "push").length, 0, "push off: no git push");
	assert.equal(existsSync(join(root, "STOP")), false);
	const state = JSON.parse(await readFile(join(root, ".shiftwork", "shiftwork-github.json"), "utf8"));
	assert.equal(state.issues["8"].feature, "gh-8-fix-the-thing");
});

test("the loop: a STOP file during the wait ends it after the current pass, exit 3", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	const { runFrontierImpl, passes } = stubFrontier();
	const { out, log, err } = lines();

	const code = await darkFactoryRun({
		root,
		config: config(),
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		log,
		err,
		sleep: async () => {
			await writeFile(join(root, "STOP"), "stop\n");
			return true;
		},
	});

	assert.equal(code, 3);
	assert.equal(passes.length, 1, "the STOP ends the loop, not a second poll");
	assert.ok(out.some((line) => /⚠ Stopped: STOP file/.test(line)), out.join("\n"));
});

test("a STOP file before a pass stops at once, exit 3", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	const { runFrontierImpl, passes } = stubFrontier();
	await writeFile(join(root, "STOP"), "stop\n");

	const code = await darkFactoryRun({
		root,
		config: config(),
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		...lines(),
	});
	assert.equal(code, 3);
	assert.equal(passes.length, 1, "the STOP'd pass runs (it stops at once, like the runner)");
});

test("gh auth status failing exits 1 with the login message, importing nothing", async () => {
	const root = await makeRoot();
	const { github, calls } = stubGitHub();
	const { runFrontierImpl, passes } = stubFrontier();
	const { out, log, err } = lines();

	const code = await darkFactoryRun({
		root,
		config: config(),
		tracker: openTracker(root),
		github,
		exec: async () => {
			throw Object.assign(new Error("gh: exit status 1"), { code: 1, stderr: "not logged in" });
		},
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		log,
		err,
	});

	assert.equal(code, 1);
	assert.ok(out[0].startsWith("dark-factory:"), out[0]);
	assert.equal(out[0], ghAuthMessage());
	assert.equal(passes.length, 0);
	assert.equal(calls.filter((c) => c.op === "listIssues" || c.op === "listLabels").length, 0, "nothing is read from GitHub");
	assert.equal(existsSync(join(root, ".scratch")), false, "nothing imported");
});

test("gh missing (a bad github.gh, or no gh on PATH) exits 1 with the install message", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	const { runFrontierImpl, passes } = stubFrontier();
	const { out, log, err } = lines();

	const code = await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, gh: "/nonexistent/gh" } },
		tracker: openTracker(root),
		github,
		exec: async () => {
			throw Object.assign(new Error("spawn /nonexistent/gh ENOENT"), { code: "ENOENT" });
		},
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		log,
		err,
	});

	assert.equal(code, 1);
	assert.ok(out[0].startsWith("dark-factory:"), out[0]);
	assert.equal(out[0], ghInstallMessage());
	assert.equal(passes.length, 0);
	assert.equal(existsSync(join(root, ".scratch")), false, "nothing imported");
});

test("a missing label exits 1 with the missing-labels error, importing nothing", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub({ labels: [LABELS[0]] });
	const { runFrontierImpl, passes } = stubFrontier();
	const { out, log, err } = lines();

	const code = await darkFactoryRun({
		root,
		config: config(),
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		log,
		err,
	});

	assert.equal(code, 1);
	assert.equal(out[0], missingLabelsMessage("owner/name", [LABELS[1], LABELS[2], LABELS[3]]));
	assert.equal(passes.length, 0);
	assert.equal(existsSync(join(root, ".scratch")), false, "nothing imported before the labels check");
	assert.deepEqual(await readdir(join(root, ".shiftwork")).catch(() => []), [], "no issue state written");
});

test("a failing git push is caught: the message, short shas, the loop continues and the push is retried next poll", async () => {
	const root = await makeRoot();
	// Ticket 02 is claimed when the poll starts; the first pass resolves it, so
	// its resolved comment lands in the sync right after the failed push.
	await writeResolvedTicket(root, "gh-8-fix-the-thing", "claimed");
	const { github, calls } = stubGitHub();
	const passes = [];
	let pass = 0;
	const runFrontierImpl = async (args) => {
		passes.push(args);
		pass += 1;
		if (pass === 1) await writeResolvedTicket(root, "gh-8-fix-the-thing");
		return { resolved: [{ feature: "gh-8-fix-the-thing", number: "02", title: "Fix the thing", reason: "Verify: passed" }], needsInfo: [], reopened: [] };
	};
	const { out, log, err } = lines();

	// Every git stub: every frontier pass "lands" (HEAD moves), the landed commit
	// is found by `git log`, every push fails.
	const gitCalls = [];
	let i = 0;
	const git = async (args) => {
		gitCalls.push([...args]);
		if (args[0] === "rev-parse") return ["a", "b", "c", "c"][Math.min(i++, 3)].repeat(40);
		if (args[0] === "log") return `${"d".repeat(40)}\n`;
		if (args[0] === "push") throw new Error("git: push declined");
		return "";
	};
	let polls = 0;

	const code = await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, push: true } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		git,
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		sleep: async () => ++polls === 2, // continue after the first poll, STOP after the second
		log,
		err,
	});

	assert.equal(code, 3);
	assert.equal(passes.length, 2, "the loop continued to a second poll");
	// The push failed, and was retried on the next poll.
	assert.deepEqual(gitCalls.filter((args) => args[0] === "push"), [["push", "origin", "HEAD"], ["push", "origin", "HEAD"]]);
	assert.equal(out.filter((line) => /dark-factory: git push failed: git: push declined; commit links stay short shas until it succeeds/.test(line)).length, 2, out.join("\n"));
	// The resolved comment posted while the commits are not on GitHub shows the short sha, not a link.
	const resolved = calls.filter((c) => c.op === "comment" && /Ticket 02 resolved/.test(c.body)).map((c) => c.body);
	assert.equal(resolved.length, 1);
	assert.match(resolved[0], /- `ddddddd`/);
	assert.doesNotMatch(resolved[0], /github\.com\/.*\/commit\//);
});

test("no github block: exit 1 with the config message", async () => {
	const root = await makeRoot();
	const { out, log, err } = lines();
	const code = await darkFactoryRun({ root, config: {}, tracker: openTracker(root), exec: okExec, shiftLog: () => {}, log, err });
	assert.equal(code, 1);
	assert.equal(out[0], NO_GITHUB_CONFIG_MESSAGE);
});

test("push: git push origin HEAD runs once after a pass that landed, never without landing", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();

	// A git stub whose HEAD changes after the frontier pass: the pass landed a commit.
	const git = (heads) => {
		const calls = [];
		let i = 0;
		return {
			calls,
			git: async (args) => {
				calls.push([...args]);
				if (args[0] === "rev-parse") return heads[Math.min(i++, heads.length - 1)];
				return "";
			},
		};
	};

	const landed = git(["a".repeat(40), "b".repeat(40)]);
	const code = await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, push: true } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		git: landed.git,
		runFrontier: stubFrontier([{ resolved: [{ feature: "gh-8-fix-the-thing", number: "02", title: "Fix the thing", reason: "Verify: passed" }] }]).runFrontierImpl,
		shiftLog: () => {},
		once: true,
		...lines(),
	});
	assert.equal(code, 0);
	const pushes = landed.calls.filter((args) => args[0] === "push");
	assert.deepEqual(pushes, [["push", "origin", "HEAD"]], "one push after the landing pass");
	assert.equal(landed.calls.filter((args) => args[0] === "rev-parse").length, 2, "HEAD checked before and after the pass");

	// Nothing landed (same HEAD before and after): no push at all.
	const none = git(["c".repeat(40), "c".repeat(40)]);
	await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, push: true } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		git: none.git,
		runFrontier: stubFrontier([{ resolved: [{ feature: "gh-8-fix-the-thing", number: "02", title: "Fix the thing", reason: "Verify: passed" }] }]).runFrontierImpl,
		shiftLog: () => {},
		once: true,
		...lines(),
	});
	assert.equal(none.calls.filter((args) => args[0] === "push").length, 0, "no landing: no push");
});

test("a failing gh poll is logged as one line, the pass still runs, the wait backs off and resets after a good poll", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	let failures = 2;
	const listIssues = github.listIssues;
	github.listIssues = async () => {
		if (failures-- > 0) throw new Error("gh: HTTP 502: Bad Gateway\n(https://api.github.com/graphql)");
		return listIssues();
	};
	const { runFrontierImpl, passes } = stubFrontier();
	const { out, log, err } = lines();
	const waits = [];

	const code = await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, pollMin: 1 } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: runFrontierImpl,
		shiftLog: () => {},
		sleep: async (ms) => waits.push(ms) === 4,
		log,
		err,
	});

	assert.equal(code, 3);
	assert.equal(passes.length, 4, "every poll works a frontier pass, failed import or not");
	assert.deepEqual(waits, [120_000, 240_000, 60_000, 60_000], "the wait doubles after a failed poll and resets after a good one");
	const failed = out.filter((line) => /^dark-factory: GitHub poll failed: gh: HTTP 502: Bad Gateway/.test(line));
	assert.equal(failed.length, 2, out.join("\n"));
	assert.ok(failed.every((line) => !line.includes("\n")), "one line per failure");
	assert.ok(out.some((line) => /github#8 imported/.test(line)), "the issue is imported once gh recovers");
});

test("the backoff is capped at an hour", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	github.listIssues = async () => {
		throw new Error("gh: HTTP 403: API rate limit exceeded");
	};
	const waits = [];

	await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, pollMin: 10 } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: stubFrontier().runFrontierImpl,
		shiftLog: () => {},
		sleep: async (ms) => waits.push(ms) === 4,
		...lines(),
	});
	assert.deepEqual(waits, [1_200_000, 2_400_000, 3_600_000, 3_600_000]);
});

test("the run state stays running between passes (runFrontier marks it idle) and is not running after exit", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub();
	const entry = async () => JSON.parse(await readFile(join(root, ".shiftwork", "shiftwork-run.json"), "utf8")).runners.find((r) => r.pid === process.pid);
	const seen = [];

	const code = await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, pollMin: 1 } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: async ({ root: dir }) => {
			// Like the real runner: every pass ends with running:false.
			await openRunState(dir).update({ running: false, finishedAt: new Date().toISOString() });
			return { resolved: [], needsInfo: [], reopened: [] };
		},
		shiftLog: () => {},
		sleep: async () => {
			const { running, mode } = await entry();
			seen.push({ running, mode });
			return seen.length === 2;
		},
		...lines(),
	});

	assert.equal(code, 3);
	assert.deepEqual(seen, [{ running: true, mode: "dark-factory" }, { running: true, mode: "dark-factory" }]);
	assert.equal((await entry()).running, false, "not running once dark-factory exits");
});

test("a skipped issue is printed once per process, not on every poll", async () => {
	const root = await makeRoot();
	const { github } = stubGitHub({
		issues: [{ number: 9, title: "From outside", body: "Please.", author: "rando", labels: [LABELS[0]], url: "https://github.com/owner/name/issues/9" }],
	});
	const { out, log, err } = lines();
	let polls = 0;

	await darkFactoryRun({
		root,
		config: { ...config(), github: { ...config().github, pollMin: 1 } },
		tracker: openTracker(root),
		github,
		exec: okExec,
		runFrontier: stubFrontier().runFrontierImpl,
		shiftLog: () => {},
		sleep: async () => ++polls === 3,
		log,
		err,
	});

	const skipped = out.filter((line) => /^github#9 skipped: rando /.test(line));
	assert.equal(skipped.length, 1, out.join("\n"));
	assert.match(skipped[0], /not a collaborator/);
});
