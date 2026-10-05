import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadTickets } from "shiftwork-core";

import {
	globFiles,
	globToRegExp,
	itemCommand,
	itemVars,
	jobsCommand,
	nextCron,
	nextDue,
	orderJobs,
	parseCron,
	readState,
	runJobs,
	shellQuote,
	validateJobs,
	watchJobs,
} from "../src/jobs.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const quiet = () => {};

async function repo(files = {}, jobs) {
	const root = await mkdtemp(join(tmpdir(), "sw-jobs-"));
	for (const [path, body] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), body);
	}
	if (jobs) {
		await mkdir(join(root, ".shiftwork"), { recursive: true });
		await writeFile(join(root, ".shiftwork", "jobs.json"), JSON.stringify({ jobs }));
	}
	return root;
}

// ---------- validation ----------

test("validateJobs fills defaults", () => {
	const { jobs } = validateJobs({ jobs: [{ name: "a", run: "echo hi" }] });
	assert.deepEqual(
		{ ...jobs[0] },
		{ name: "a", run: "echo hi", inputs: null, output: null, order: 0, concurrency: 1, timeoutMin: 60, retries: 0, schedule: null, after: [], env: {}, ticket: false, index: 0 },
	);
});

test("validateJobs lists every problem", () => {
	assert.throws(
		() =>
			validateJobs({
				jobs: [
					{ name: "a", run: "x {input}", concurrency: 0, bogus: 1 },
					{ name: "a", run: "" },
					{ name: "b", run: "x", after: ["nope"], schedule: { at: "25:00" } },
					{ name: "c", run: "x", inputs: "../etc/*" },
				],
			}),
		(error) => {
			for (const part of ['unknown key "bogus"', '"concurrency" must be an integer >= 1', "uses {input}/{stem}/{dir} but the job has no \"inputs\"", 'duplicate name "a"', '"run" must be a non-empty', 'unknown job "nope"', '"schedule.at"', "inside the repo"]) {
				assert.ok(error.message.includes(part), `missing: ${part}\n${error.message}`);
			}
			return true;
		},
	);
	assert.throws(() => validateJobs({}), /expected \{ "jobs"/);
});

test("validateJobs rejects an after cycle", () => {
	assert.throws(
		() =>
			validateJobs({
				jobs: [
					{ name: "a", run: "x", after: ["b"] },
					{ name: "b", run: "x", after: ["a"] },
				],
			}),
		/cycle/,
	);
});

// ---------- ordering ----------

test("orderJobs: after wins over order, then order, then file position", () => {
	const { jobs } = validateJobs({
		jobs: [
			{ name: "publish", run: "x", order: 1, after: ["translate"] },
			{ name: "translate", run: "x", order: 5 },
			{ name: "clean", run: "x", order: 1 },
			{ name: "fetch", run: "x" },
		],
	});
	assert.deepEqual(
		orderJobs(jobs).map((j) => j.name),
		["fetch", "clean", "translate", "publish"],
	);
});

// ---------- glob ----------

test("globToRegExp handles * ? **", () => {
	assert.ok(globToRegExp("videos/*.mp4").test("videos/a.mp4"));
	assert.ok(!globToRegExp("videos/*.mp4").test("videos/sub/a.mp4"));
	assert.ok(globToRegExp("videos/**/*.mp4").test("videos/a.mp4"));
	assert.ok(globToRegExp("videos/**/*.mp4").test("videos/x/y/a.mp4"));
	assert.ok(globToRegExp("v?.txt").test("v1.txt"));
	assert.ok(!globToRegExp("v?.txt").test("v12.txt"));
	assert.ok(globToRegExp("a.b").test("a.b") && !globToRegExp("a.b").test("axb"));
});

test("globFiles walks the repo, sorted, skipping .git and node_modules", async () => {
	const root = await repo({
		"videos/b.mp4": "",
		"videos/a.mp4": "",
		"videos/a.txt": "",
		"videos/deep/c.mp4": "",
		"node_modules/x/d.mp4": "",
		".git/e.mp4": "",
	});
	assert.deepEqual(await globFiles(root, "videos/*.mp4"), ["videos/a.mp4", "videos/b.mp4"]);
	assert.deepEqual(await globFiles(root, "videos/**/*.mp4"), ["videos/a.mp4", "videos/b.mp4", "videos/deep/c.mp4"]);
	assert.deepEqual(await globFiles(root, "**/*.mp4"), ["videos/a.mp4", "videos/b.mp4", "videos/deep/c.mp4"]);
	assert.deepEqual(await globFiles(root, "missing/*.mp4"), []);
	await assert.rejects(globFiles(root, "/etc/*"), /inside the repo/);
});

// ---------- placeholders ----------

test("shellQuote leaves safe words and quotes the rest", () => {
	assert.equal(shellQuote("videos/a.mp4"), "videos/a.mp4");
	assert.equal(shellQuote("my file.mp4"), "'my file.mp4'");
	assert.equal(shellQuote("it's; rm -rf /"), `'it'\\''s; rm -rf /'`);
	assert.equal(shellQuote(""), "''");
});

test("itemVars and itemCommand fill and quote placeholders", () => {
	const job = validateJobs({ jobs: [{ name: "tr", run: "ffmpeg -i {input} {output} # {stem} {dir} {name} {other}", inputs: "v/*.mp4", output: "out/{stem}.srt" }] }).jobs[0];
	assert.deepEqual(itemVars(job, "v/my clip.mp4"), { name: "tr", input: "v/my clip.mp4", stem: "my clip", dir: "v", output: "out/my clip.srt" });
	assert.equal(itemCommand(job, "v/my clip.mp4"), "ffmpeg -i 'v/my clip.mp4' 'out/my clip.srt' # 'my clip' v tr {other}");
});

// ---------- schedule ----------

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test("nextDue everyMin: now when never run, else lastRun + everyMin", () => {
	const now = local(2026, 1, 1, 10, 0);
	assert.equal(nextDue({ everyMin: 30 }, null, now), now);
	assert.equal(nextDue({ everyMin: 30 }, new Date(now).toISOString(), now), now + 30 * 60_000);
});

test("nextDue at: today when the time is ahead, tomorrow once run", () => {
	const now = local(2026, 1, 1, 1, 0);
	assert.equal(nextDue({ at: "02:30" }, null, now), local(2026, 1, 1, 2, 30));
	assert.equal(nextDue({ at: "02:30" }, local(2026, 1, 1, 2, 30), now), local(2026, 1, 2, 2, 30));
	// The minute itself counts when it never ran.
	assert.equal(nextDue({ at: "02:30" }, null, local(2026, 1, 1, 2, 30)), local(2026, 1, 1, 2, 30));
});

test("parseCron and nextCron: lists, ranges, steps, dow", () => {
	const every15 = parseCron("*/15 * * * *");
	assert.equal(nextCron(every15, local(2026, 1, 1, 10, 7)).getTime(), local(2026, 1, 1, 10, 15));
	const weekdays = parseCron("0 9 * * 1-5");
	// 2026-01-03 is a Saturday: next is Monday the 5th.
	assert.equal(nextCron(weekdays, local(2026, 1, 3, 12, 0)).getTime(), local(2026, 1, 5, 9, 0));
	const sunday = parseCron("30 4 * * 7");
	assert.equal(nextCron(sunday, local(2026, 1, 1, 0, 0)).getTime(), local(2026, 1, 4, 4, 30));
	const firstOfMonth = parseCron("0 0 1 2,3 *");
	assert.equal(nextCron(firstOfMonth, local(2026, 1, 15, 0, 0)).getTime(), local(2026, 2, 1, 0, 0));
	assert.equal(nextDue({ cron: "0 12 * * *" }, null, local(2026, 1, 1, 13, 0)), local(2026, 1, 2, 12, 0));
	assert.throws(() => parseCron("* * *"), /5 fields/);
	assert.throws(() => parseCron("60 * * * *"), /out of range/);
	assert.throws(() => parseCron("a * * * *"), /bad minute/);
});

// ---------- running ----------

test("runJobs runs items, writes logs and state, and a re-run skips done ones", async () => {
	const root = await repo({ "in/a.txt": "A", "in/b c.txt": "B" }, [
		{ name: "copy", run: "mkdir -p out && cat {input} > {output} && echo copied {stem}", inputs: "in/*.txt", output: "out/{stem}.out" },
	]);
	const first = await runJobs(root, { log: quiet });
	assert.equal(first.code, 0);
	assert.equal(await readFile(join(root, "out/b c.out"), "utf8"), "B");
	assert.match(await readFile(join(root, "logs/jobs/copy/b c.log"), "utf8"), /copied b c/);
	const state = await readState(root);
	assert.equal(state.jobs.copy.items["in/a.txt"].status, "done");
	assert.equal(state.jobs.copy.items["in/a.txt"].attempts, 1);

	const lines = [];
	const second = await runJobs(root, { log: (l) => lines.push(l) });
	assert.equal(second.code, 0);
	assert.match(lines.join("\n"), /2 done · 0 to run/);
});

test("an item whose output exists counts as done unless --force", async () => {
	const root = await repo({ "in/a.txt": "A", "out/a.out": "old" }, [{ name: "copy", run: "cp {input} {output}", inputs: "in/*.txt", output: "out/{stem}.out" }]);
	await runJobs(root, { log: quiet });
	assert.equal(await readFile(join(root, "out/a.out"), "utf8"), "old");
	await runJobs(root, { log: quiet, force: true });
	assert.equal(await readFile(join(root, "out/a.out"), "utf8"), "A");
});

test("exit 0 without the output is a failure", async () => {
	const root = await repo({ "in/a.txt": "A" }, [{ name: "lazy", run: "true", inputs: "in/*.txt", output: "out/{stem}.out" }]);
	const { code } = await runJobs(root, { log: quiet });
	assert.equal(code, 2);
	assert.match(await readFile(join(root, "logs/jobs/lazy/a.log"), "utf8"), /was not written/);
});

test("failed items retry up to retries, then stay failed until --retry-failed", async () => {
	const root = await repo({ "in/a.txt": "" }, [{ name: "flaky", run: "echo x >> count; exit 1", inputs: "in/*.txt", retries: 2 }]);
	const first = await runJobs(root, { log: quiet });
	assert.equal(first.code, 2);
	assert.equal((await readFile(join(root, "count"), "utf8")).trim().split("\n").length, 3);
	assert.equal((await readState(root)).jobs.flaky.items["in/a.txt"].attempts, 3);
	// No attempts left: a plain re-run doesn't run it, but still reports the failure.
	const second = await runJobs(root, { log: quiet });
	assert.equal(second.code, 2);
	assert.equal((await readFile(join(root, "count"), "utf8")).trim().split("\n").length, 3);
	await runJobs(root, { log: quiet, retryFailed: true });
	assert.equal((await readFile(join(root, "count"), "utf8")).trim().split("\n").length, 6);
});

test("a re-run retries a failed item that has attempts left, and skips done ones", async () => {
	const root = await repo({ "in/a.txt": "", "in/b.txt": "" }, [{ name: "j", run: "echo {stem} >> ran", inputs: "in/*.txt", retries: 1 }]);
	const items = {
		"in/a.txt": { status: "done", attempts: 1 },
		"in/b.txt": { status: "failed", attempts: 1, code: 1 },
	};
	await writeFile(join(root, ".shiftwork/jobs-state.json"), JSON.stringify({ jobs: { j: { items } } }));
	assert.equal((await runJobs(root, { log: quiet })).code, 0);
	assert.equal((await readFile(join(root, "ran"), "utf8")).trim(), "b");
	assert.equal((await readState(root)).jobs.j.items["in/b.txt"].attempts, 2);
});

test("a job after a failed job is skipped", async () => {
	const root = await repo({}, [
		{ name: "first", run: "exit 3" },
		{ name: "second", run: "touch second", after: ["first"] },
	]);
	const { code, summary } = await runJobs(root, { log: quiet });
	assert.equal(code, 2);
	assert.ok(summary.find((s) => s.name === "second").skipped);
	assert.ok(!existsSync(join(root, "second")));
});

test("concurrency runs items at once", async () => {
	const root = await repo({ "in/a.txt": "", "in/b.txt": "", "in/c.txt": "" }, [{ name: "par", run: "sleep 0.4", inputs: "in/*.txt", concurrency: 3 }]);
	const started = Date.now();
	await runJobs(root, { log: quiet });
	assert.ok(Date.now() - started < 1100, `took ${Date.now() - started} ms`);
});

test("a timeout kills the item", async () => {
	const root = await repo({}, [{ name: "slow", run: "sleep 5", timeoutMin: 0.005 }]);
	const { code } = await runJobs(root, { log: quiet });
	assert.equal(code, 2);
	assert.equal((await readState(root)).jobs.slow.items._.code, 124);
});

test("a STOP file stops the run (exit 3)", async () => {
	const root = await repo({ "in/a.txt": "", "in/b.txt": "" }, [{ name: "s", run: "touch STOP; echo {stem} >> ran", inputs: "in/*.txt" }]);
	const { code } = await runJobs(root, { log: quiet });
	assert.equal(code, 3);
	assert.equal((await readFile(join(root, "ran"), "utf8")).trim(), "a");
});

test("dry-run prints commands and changes nothing", async () => {
	const root = await repo({ "in/x y.txt": "" }, [{ name: "d", run: "touch {input}.done", inputs: "in/*.txt" }]);
	const lines = [];
	const { code } = await runJobs(root, { log: (l) => lines.push(l), dryRun: true });
	assert.equal(code, 0);
	assert.match(lines.join("\n"), /would run: touch 'in\/x y\.txt'\.done/);
	assert.ok(!existsSync(join(root, ".shiftwork/jobs-state.json")));
});

test("ticket: true writes a ready-for-agent ticket once an item fails every attempt", async () => {
	const root = await repo({ "videos/clip.mp4": "" }, [{ name: "translate", run: "echo boom-from-script >&2; exit 7", inputs: "videos/*.mp4", ticket: true }]);
	await runJobs(root, { log: quiet });
	const tickets = (await loadTickets(root)).filter((t) => t.feature === "jobs-translate");
	assert.equal(tickets.length, 1);
	assert.equal(tickets[0].status, "ready-for-agent");
	const body = await readFile(tickets[0].path, "utf8");
	assert.match(body, /exited 7/);
	assert.match(body, /boom-from-script/);
	assert.match(body, /\*\*Verify:\*\* `shiftwork jobs run translate --retry-failed`/);
	assert.match(body, /- \[ \]/);
	assert.match(await readFile(join(root, ".scratch/jobs-translate/spec.md"), "utf8"), /shiftwork:tickets:start/);
	// Not again on the next run.
	await runJobs(root, { log: quiet, retryFailed: true });
	assert.equal((await loadTickets(root)).filter((t) => t.feature === "jobs-translate").length, 1);
});

test("watchJobs runs due scheduled jobs and sleeps until the next", async () => {
	const root = await repo({}, [
		{ name: "tick", run: "echo t >> ticks", schedule: { everyMin: 10 } },
		{ name: "manual", run: "touch manual" },
	]);
	let clock = local(2026, 1, 1, 10, 0);
	const slept = [];
	const code = await watchJobs(root, {
		log: quiet,
		now: () => clock,
		sleep: async (ms) => {
			slept.push(ms);
			clock += ms;
		},
		pollMs: 60_000,
		maxRounds: 4,
	});
	assert.equal(code, 0);
	// round 1 runs, round 2 sleeps 10 min, round 3 runs, round 4 sleeps.
	assert.equal((await readFile(join(root, "ticks"), "utf8")).trim().split("\n").length, 2);
	assert.equal(slept.reduce((a, b) => a + b, 0), 20 * 60_000);
	assert.ok(!existsSync(join(root, "manual")));
});

test("watchJobs stops on STOP with exit 3", async () => {
	const root = await repo({ STOP: "" }, [{ name: "tick", run: "true", schedule: { everyMin: 1 } }]);
	assert.equal(await watchJobs(root, { log: quiet }), 3);
});

// ---------- CLI ----------

test("jobsCommand list and status report counts", async () => {
	const root = await repo({ "in/a.txt": "", "in/b.txt": "" }, [{ name: "j", run: "[ {stem} = a ]", inputs: "in/*.txt", schedule: { at: "02:30" } }]);
	const lines = [];
	assert.equal(await jobsCommand(["run", "--dir", root], { log: quiet }), 2);
	assert.equal(await jobsCommand(["list", "--dir", root], { log: (l) => lines.push(l) }), 0);
	assert.match(lines.join("\n"), /j {2}\[daily at 02:30\] {2}next: .* items: 1\/2 done · 1 failed · 0 pending/);
	lines.length = 0;
	assert.equal(await jobsCommand(["status", "--dir", root], { log: (l) => lines.push(l) }), 2);
	assert.match(lines.join("\n"), /exhausted in\/b\.txt · 1 attempt\(s\) · exit 1 · logs\/jobs\/j\/b\.log/);
});

test("integration: shiftwork jobs run via the bin, exit codes 0 / 2 / 1", async () => {
	const root = await repo({ "videos/one.mp4": "1", "videos/two.mp4": "2" }, [
		{ name: "translate", run: "mkdir -p out && sh -c 'cat \"$1\" > \"$2\"' _ {input} {output}", inputs: "videos/*.mp4", output: "out/{stem}.srt", order: 1 },
		{ name: "index", run: "ls out > out/index.txt", after: ["translate"], order: 0 },
	]);
	const run = (args) =>
		promisify(execFile)(process.execPath, [bin, "jobs", ...args, "--dir", root]).then(
			({ stdout }) => ({ code: 0, stdout }),
			(error) => ({ code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
		);
	const ok = await run(["run"]);
	assert.equal(ok.code, 0, ok.stdout + ok.stderr);
	assert.equal(await readFile(join(root, "out/two.srt"), "utf8"), "2");
	assert.match(await readFile(join(root, "out/index.txt"), "utf8"), /one\.srt/);
	await writeFile(join(root, ".shiftwork/jobs.json"), JSON.stringify({ jobs: [{ name: "bad", run: "exit 1" }] }));
	assert.equal((await run(["run"])).code, 2);
	await writeFile(join(root, ".shiftwork/jobs.json"), JSON.stringify({ jobs: [{ name: "bad" }] }));
	const invalid = await run(["run"]);
	assert.equal(invalid.code, 1);
	assert.match(invalid.stderr, /"run" must be a non-empty/);
});
