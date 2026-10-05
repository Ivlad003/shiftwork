import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { openTracker, shiftworkPath, withLock } from "shiftwork-core";

import { installSignalStop, registerChild } from "./signal-stop.js";

/**
 * `shiftwork jobs`: deterministic (non-LLM) batch and scheduled scripts with resumable
 * per-item state. Jobs live in `.shiftwork/jobs.json`, item state in
 * `.shiftwork/jobs-state.json`, item logs in `logs/jobs/<name>/<stem>.log`.
 */

export const JOBS_FILE = "jobs.json";
export const JOBS_STATE_FILE = "jobs-state.json";
/** The state key of a job without `inputs`: it runs as one item. */
export const SINGLE = "_";
const TAIL_CHARS = 2000;
const PLACEHOLDERS = ["input", "stem", "dir", "output", "name"];
const JOB_KEYS = new Set(["name", "run", "inputs", "output", "order", "concurrency", "timeoutMin", "retries", "schedule", "after", "env", "ticket"]);

// ---------- config ----------

/** Validate a parsed jobs.json; returns `{ jobs }` with defaults filled, throws listing every problem. */
export function validateJobs(raw) {
	const errors = [];
	if (!raw || typeof raw !== "object" || !Array.isArray(raw.jobs)) throw new Error('jobs.json: expected { "jobs": [ ... ] }');
	const names = new Set();
	const jobs = raw.jobs.map((job, index) => {
		const where = `jobs[${index}]${typeof job?.name === "string" ? ` (${job.name})` : ""}`;
		const bad = (message) => errors.push(`${where}: ${message}`);
		if (!job || typeof job !== "object" || Array.isArray(job)) {
			bad("must be an object");
			return null;
		}
		for (const key of Object.keys(job)) if (!JOB_KEYS.has(key)) bad(`unknown key "${key}"`);
		if (typeof job.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(job.name)) bad('"name" must be letters, digits, ".", "_" or "-"');
		else if (names.has(job.name)) bad(`duplicate name "${job.name}"`);
		else names.add(job.name);
		if (typeof job.run !== "string" || !job.run.trim()) bad('"run" must be a non-empty command string');
		if (job.inputs != null && (typeof job.inputs !== "string" || !job.inputs.trim())) bad('"inputs" must be a glob string or null');
		else if (typeof job.inputs === "string" && !insideRepo(job.inputs)) bad('"inputs" must be a relative glob inside the repo');
		if (job.output != null && (typeof job.output !== "string" || !job.output.trim())) bad('"output" must be a path template string');
		const int = (key, min) => {
			if (job[key] == null) return;
			if (!Number.isInteger(job[key]) || job[key] < min) bad(`"${key}" must be an integer >= ${min}`);
		};
		int("order", -1e9);
		int("concurrency", 1);
		int("retries", 0);
		if (job.timeoutMin != null && !(typeof job.timeoutMin === "number" && job.timeoutMin > 0)) bad('"timeoutMin" must be a number > 0');
		if (job.after != null && !(Array.isArray(job.after) && job.after.every((a) => typeof a === "string"))) bad('"after" must be an array of job names');
		if (job.env != null && !(typeof job.env === "object" && !Array.isArray(job.env) && Object.values(job.env).every((v) => typeof v === "string"))) bad('"env" must map names to strings');
		if (job.ticket != null && typeof job.ticket !== "boolean") bad('"ticket" must be true or false');
		if (job.schedule != null) {
			try {
				parseSchedule(job.schedule);
			} catch (error) {
				bad(error.message);
			}
		}
		const tokens = [...String(job.run ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
		if (job.inputs == null && tokens.some((t) => ["input", "stem", "dir"].includes(t))) bad('"run" uses {input}/{stem}/{dir} but the job has no "inputs"');
		if (job.output == null && tokens.includes("output")) bad('"run" uses {output} but the job has no "output"');
		return {
			name: job.name,
			run: job.run,
			inputs: job.inputs ?? null,
			output: job.output ?? null,
			order: job.order ?? 0,
			concurrency: job.concurrency ?? 1,
			timeoutMin: job.timeoutMin ?? 60,
			retries: job.retries ?? 0,
			schedule: job.schedule ?? null,
			after: job.after ?? [],
			env: job.env ?? {},
			ticket: job.ticket ?? false,
			index,
		};
	});
	for (const job of jobs) {
		if (!job) continue;
		for (const dep of job.after) {
			if (dep === job.name) errors.push(`jobs[${job.index}] (${job.name}): "after" names itself`);
			else if (!names.has(dep)) errors.push(`jobs[${job.index}] (${job.name}): "after" names unknown job "${dep}"`);
		}
	}
	if (!errors.length) {
		try {
			orderJobs(jobs);
		} catch (error) {
			errors.push(error.message);
		}
	}
	if (errors.length) throw new Error(`jobs.json is invalid:\n  ${errors.join("\n  ")}`);
	return { jobs };
}

function insideRepo(pattern) {
	return !isAbsolute(pattern) && !pattern.split("/").includes("..");
}

/** Read and validate `<root>/.shiftwork/jobs.json`. */
export async function loadJobs(root) {
	const path = shiftworkPath(root, JOBS_FILE);
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") throw new Error(`no jobs defined: create ${relative(root, path)} (see docs/guide.md "Jobs")`);
		throw error;
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`${relative(root, path)}: ${error.message}`);
	}
	return validateJobs(raw).jobs;
}

/** Jobs in run order: every job after the jobs in its `after`, else by `order`, then file position. Throws on a cycle. */
export function orderJobs(jobs) {
	const byName = new Map(jobs.map((j) => [j.name, j]));
	const rank = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.index ?? 0) - (b.index ?? 0);
	const done = new Set();
	const out = [];
	const pending = [...jobs].sort(rank);
	while (pending.length) {
		const next = pending.findIndex((j) => (j.after ?? []).every((d) => done.has(d) || !byName.has(d)));
		if (next < 0) throw new Error(`"after" cycle between jobs: ${pending.map((j) => j.name).join(", ")}`);
		const [job] = pending.splice(next, 1);
		done.add(job.name);
		out.push(job);
	}
	return out;
}

// ---------- glob ----------

/** A glob (`*`, `?`, `**`) as a RegExp over `/`-separated relative paths. */
export function globToRegExp(pattern) {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			const slash = pattern[i + 2] === "/";
			re += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** Files under `root` matching `pattern`, as sorted repo-relative `/` paths. `.git` and `node_modules` are skipped. */
export async function globFiles(root, pattern) {
	if (!insideRepo(pattern)) throw new Error(`glob "${pattern}" must stay inside the repo`);
	const parts = pattern.split("/");
	const fixed = [];
	while (parts.length > 1 && !/[*?]/.test(parts[0])) fixed.push(parts.shift());
	const base = fixed.join("/");
	const re = globToRegExp(pattern);
	const deep = parts.some((p) => p.includes("**"));
	const maxDepth = deep ? Infinity : parts.length;
	const found = [];
	async function walk(dir, depth) {
		let entries;
		try {
			entries = await readdir(join(root, dir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (depth + 1 < maxDepth) await walk(path, depth + 1);
			} else if (entry.isFile() && re.test(path)) found.push(path);
		}
	}
	await walk(base, 0);
	return found.sort();
}

// ---------- placeholders ----------

/** Quote a string for `sh`. */
export function shellQuote(value) {
	const s = String(value);
	return /^[A-Za-z0-9_\-./=:@%+,]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Replace `{key}` placeholders with `vars[key]`, shell-quoted when `quote`; unknown ones stay. */
export function fillTemplate(template, vars, { quote = false } = {}) {
	return template.replace(/\{(\w+)\}/g, (all, key) => (PLACEHOLDERS.includes(key) && vars[key] != null ? (quote ? shellQuote(vars[key]) : String(vars[key])) : all));
}

/** The placeholder values for one item (`input` null for a job without inputs). */
export function itemVars(job, input) {
	const vars = { name: job.name };
	if (input != null) {
		vars.input = input;
		vars.stem = basename(input, extname(input));
		vars.dir = dirname(input);
	}
	if (job.output) vars.output = fillTemplate(job.output, vars);
	return vars;
}

/** The shell command for one item, every placeholder shell-quoted. */
export function itemCommand(job, input) {
	return fillTemplate(job.run, itemVars(job, input), { quote: true });
}

/** `logs/jobs/<name>/<stem>.log` (`<name>.log` for a job without inputs), repo-relative. */
export function itemLogPath(job, input) {
	const stem = input == null ? job.name : basename(input, extname(input));
	return join("logs", "jobs", job.name, `${stem}.log`);
}

// ---------- schedule ----------

/** Parse a schedule: `{ everyMin }`, `{ at: "HH:MM" }` or `{ cron: "m h dom mon dow" }`. Throws on a bad one. */
export function parseSchedule(schedule) {
	if (!schedule || typeof schedule !== "object") throw new Error('"schedule" must be { everyMin } | { at: "HH:MM" } | { cron: "m h dom mon dow" }');
	const keys = Object.keys(schedule);
	if (keys.length !== 1) throw new Error('"schedule" takes exactly one of everyMin, at, cron');
	if ("everyMin" in schedule) {
		if (!(typeof schedule.everyMin === "number" && schedule.everyMin > 0)) throw new Error('"schedule.everyMin" must be a number > 0');
		return { everyMin: schedule.everyMin };
	}
	if ("at" in schedule) {
		const m = /^(\d{1,2}):(\d{2})$/.exec(String(schedule.at));
		if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('"schedule.at" must be "HH:MM" (24h, local time)');
		return { cron: parseCron(`${Number(m[2])} ${Number(m[1])} * * *`) };
	}
	if ("cron" in schedule) return { cron: parseCron(schedule.cron) };
	throw new Error('"schedule" takes exactly one of everyMin, at, cron');
}

const CRON_FIELDS = [
	["minute", 0, 59],
	["hour", 0, 23],
	["day of month", 1, 31],
	["month", 1, 12],
	["day of week", 0, 7],
];

/** A 5-field cron (`*`, `n`, `a-b`, `,` lists, `/step`) as sets of allowed values; local time; dow 7 = Sunday. */
export function parseCron(expr) {
	const fields = String(expr ?? "").trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`"schedule.cron" must have 5 fields (m h dom mon dow): "${expr}"`);
	const sets = fields.map((field, i) => {
		const [label, min, max] = CRON_FIELDS[i];
		const values = new Set();
		for (const part of field.split(",")) {
			const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
			if (!m) throw new Error(`"schedule.cron": bad ${label} "${part}"`);
			let [lo, hi] = m[1] === "*" ? [min, max] : m[1].split("-").map(Number);
			if (hi === undefined) hi = m[2] ? max : lo;
			const step = m[2] ? Number(m[2]) : 1;
			if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`"schedule.cron": ${label} "${part}" out of range ${min}-${max}`);
			for (let v = lo; v <= hi; v += step) values.add(i === 4 && v === 7 ? 0 : v);
		}
		return values;
	});
	return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domAny: fields[2] === "*", dowAny: fields[4] === "*" };
}

function cronDayMatches(cron, d) {
	const dom = cron.dom.has(d.getDate());
	const dow = cron.dow.has(d.getDay());
	if (cron.domAny || cron.dowAny) return (cron.domAny || dom) && (cron.dowAny || dow);
	return dom || dow; // both restricted: classic cron ORs them
}

/** The first minute strictly after `after` (a Date or ms) that matches `cron`; null past ~4 years. */
export function nextCron(cron, after) {
	const d = new Date(after);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);
	const limit = d.getTime() + 4 * 366 * 86_400_000;
	while (d.getTime() < limit) {
		if (!cron.month.has(d.getMonth() + 1) || !cronDayMatches(cron, d)) {
			d.setDate(d.getDate() + 1);
			d.setHours(0, 0, 0, 0);
			continue;
		}
		if (!cron.hour.has(d.getHours())) {
			d.setHours(d.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (cron.minute.has(d.getMinutes())) return d;
		d.setMinutes(d.getMinutes() + 1);
	}
	return null;
}

/**
 * When a scheduled job is next due (ms), given when it last started (`lastRun`, ms or ISO, or null).
 * everyMin: `lastRun + everyMin` (now when it never ran); at/cron: the first matching minute after
 * `lastRun` (never ran: from the minute before `now`, so a job whose minute is now runs now).
 */
export function nextDue(schedule, lastRun, now = Date.now()) {
	const parsed = schedule.everyMin || (schedule.cron && typeof schedule.cron === "object") ? schedule : parseSchedule(schedule);
	const last = lastRun == null ? null : new Date(lastRun).getTime();
	if (parsed.everyMin) return last == null ? now : last + parsed.everyMin * 60_000;
	const due = nextCron(parsed.cron, last ?? now - 60_000);
	return due ? due.getTime() : Infinity;
}

// ---------- state ----------

export function statePath(root) {
	return shiftworkPath(root, JOBS_STATE_FILE);
}

export async function readState(root) {
	try {
		const state = JSON.parse(await readFile(statePath(root), "utf8"));
		return state && typeof state.jobs === "object" ? state : { jobs: {} };
	} catch {
		return { jobs: {} };
	}
}

/** Read-modify-write the jobs state under the repo's `jobs` lock. */
export async function updateState(root, fn) {
	return withLock(
		root,
		async () => {
			const state = await readState(root);
			const result = await fn(state);
			const path = statePath(root);
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.tmp-${process.pid}`;
			await writeFile(tmp, `${JSON.stringify(state, null, "\t")}\n`);
			await rename(tmp, path);
			return result;
		},
		{ name: "jobs" },
	);
}

function jobState(state, name) {
	state.jobs[name] ??= { items: {} };
	state.jobs[name].items ??= {};
	return state.jobs[name];
}

// ---------- items ----------

/** The items of a job: its sorted input files, or one `_` item. Each `{ key, input, output, command, log }`. */
export async function jobItems(root, job) {
	const inputs = job.inputs ? await globFiles(root, job.inputs) : [null];
	return inputs.map((input) => {
		const vars = itemVars(job, input);
		return { key: input ?? SINGLE, input, output: vars.output ?? null, command: itemCommand(job, input), log: itemLogPath(job, input) };
	});
}

/** done / failed / exhausted (failed with no attempts left) / pending for one item. */
export function itemStatus(job, item, record, root) {
	if (record?.status === "done") return "done";
	if (job.inputs && item.output && root && existsSync(join(root, item.output))) return "done";
	if (record?.status === "failed") return (record.attempts ?? 0) >= job.retries + 1 ? "exhausted" : "failed";
	return "pending";
}

/** Counts per status for a job: `{ total, done, failed, pending }` (failed includes exhausted). */
export async function jobCounts(root, job, state) {
	const items = await jobItems(root, job);
	const records = state.jobs[job.name]?.items ?? {};
	const counts = { total: items.length, done: 0, failed: 0, pending: 0 };
	for (const item of items) {
		const s = itemStatus(job, item, records[item.key], root);
		counts[s === "exhausted" ? "failed" : s]++;
	}
	return counts;
}

function stopRequested(root) {
	return existsSync(join(root, "STOP"));
}

/** Run one shell command with its output appended to `logFile`; resolves `{ code, timedOut }`. */
export function runCommand(command, { cwd, env, logFile, timeoutMs }) {
	return new Promise((resolve) => {
		mkdirSync(dirname(logFile), { recursive: true });
		const fd = openSync(logFile, "a");
		writeSync(fd, `\n[shiftwork jobs] ${new Date().toISOString()} $ ${command}\n`);
		let child;
		try {
			child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd], detached: true });
		} catch (error) {
			writeSync(fd, `[shiftwork jobs] could not start: ${error.message}\n`);
			closeSync(fd);
			resolve({ code: 127, timedOut: false });
			return;
		}
		const unregister = registerChild(child.pid);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		let finished = false;
		const finish = (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			unregister();
			try {
				if (timedOut) writeSync(fd, `\n[shiftwork jobs] timed out after ${Math.round(timeoutMs / 60_000)} min (timeoutMin)\n`);
				writeSync(fd, `[shiftwork jobs] exit ${code}\n`);
			} catch {}
			closeSync(fd);
			resolve({ code, timedOut });
		};
		child.on("error", (error) => {
			try {
				writeSync(fd, `[shiftwork jobs] could not start: ${error.message}\n`);
			} catch {}
			finish(127);
		});
		child.on("close", (code, signal) => finish(timedOut ? 124 : (code ?? (signal ? 128 : 1))));
	});
}

async function logTail(root, log) {
	try {
		return (await readFile(join(root, log), "utf8")).slice(-TAIL_CHARS);
	} catch {
		return "";
	}
}

/** Write a ready-for-agent ticket in `.scratch/jobs-<name>/` for an item that failed every attempt. */
export async function createFailureTicket(root, job, item, { code, attempts }) {
	const feature = `jobs-${job.name}`;
	const specPath = join(root, ".scratch", feature, "spec.md");
	if (!existsSync(specPath)) {
		await mkdir(dirname(specPath), { recursive: true });
		await writeFile(specPath, `# Spec: job ${job.name} failures\n\n**Status:** ready-for-agent\n\nItems of the \`${job.name}\` job (\`.shiftwork/jobs.json\`) that failed every attempt. Fix the script or its inputs so \`shiftwork jobs run ${job.name}\` passes.\n`);
	}
	const label = item.input ?? job.name;
	const verify = `shiftwork jobs run ${job.name} --retry-failed`;
	const created = await openTracker(root).createTicket(feature, {
		title: `Fix job ${job.name}: ${label} fails`,
		what: `make the \`${job.name}\` job succeed for \`${label}\` — it exited ${code} on all ${attempts} attempt(s).`,
		verify: [verify],
	});
	const tail = await logTail(root, item.log);
	const text = await readFile(created.path, "utf8");
	const details = [
		`- [ ] \`${verify}\` exits 0 (the item is done${item.output ? ` and \`${item.output}\` exists` : ""})`,
		"- [ ] The fix is in the script or the job definition, not a one-off manual edit of the output",
		"",
		"## Failure",
		"",
		`- Job: \`${job.name}\` in \`.shiftwork/jobs.json\``,
		`- Item: \`${label}\``,
		`- Command: \`${item.command}\``,
		`- Exit: ${code} after ${attempts} attempt(s)`,
		`- Log: \`${item.log}\``,
		"",
		"Log tail:",
		"",
		"```",
		tail.trimEnd().replaceAll("```", "'''"),
		"```",
		"",
	].join("\n");
	await writeFile(created.path, text.replace("- [ ] It works\n", details));
	return created;
}

/**
 * Run jobs (all, or those named) in order. Items run `concurrency` at a time; done items are
 * skipped, failed ones retried while attempts remain (`retries` + 1 in all). A job whose `after`
 * job failed or stopped in this run is skipped. Returns `{ code, summary }`:
 * code 0 all done, 2 some items failed, 3 stopped.
 */
export async function runJobs(root, { jobs, names = [], force = false, retryFailed = false, dryRun = false, log = console.log, now = () => Date.now() } = {}) {
	jobs ??= await loadJobs(root);
	const unknown = names.filter((n) => !jobs.some((j) => j.name === n));
	if (unknown.length) throw new Error(`unknown job(s): ${unknown.join(", ")}`);
	const selected = orderJobs(names.length ? jobs.filter((j) => names.includes(j.name)) : jobs);
	const outcome = new Map();
	const summary = [];
	let stopped = false;
	let anyFailed = false;

	for (const job of selected) {
		if (stopRequested(root)) {
			stopped = true;
			break;
		}
		const blocker = job.after.find((d) => outcome.has(d) && outcome.get(d) !== "ok");
		if (blocker) {
			log(`jobs: ${job.name}: skipped — "${blocker}" did not finish cleanly`);
			outcome.set(job.name, "skipped");
			anyFailed = true;
			summary.push({ name: job.name, skipped: true });
			continue;
		}
		const result = await runJob(root, job, { force, retryFailed, dryRun, log, now });
		summary.push({ name: job.name, ...result });
		if (result.stopped) {
			stopped = true;
			outcome.set(job.name, "stopped");
			break;
		}
		outcome.set(job.name, result.failed ? "failed" : "ok");
		if (result.failed) anyFailed = true;
	}
	return { code: stopped ? 3 : anyFailed ? 2 : 0, summary };
}

async function runJob(root, job, { force, retryFailed, dryRun, log, now }) {
	const items = await jobItems(root, job);
	const counts = { done: 0, ran: 0, failed: 0, skipped: 0, stopped: false };
	if (!dryRun) {
		await updateState(root, (state) => {
			const js = jobState(state, job.name);
			js.lastRun = new Date(now()).toISOString();
			// A job without inputs is one action per run: every run starts it afresh.
			if (!job.inputs || force) js.items = {};
			if (retryFailed) for (const r of Object.values(js.items)) if (r.status === "failed") r.attempts = 0;
		});
	}
	const state = await readState(root);
	const records = state.jobs[job.name]?.items ?? {};
	const queue = [];
	for (const item of items) {
		const record = dryRun && (force || !job.inputs) ? undefined : records[item.key];
		const status = force ? "pending" : itemStatus(job, item, record, root);
		if (status === "done") {
			counts.done++;
			continue;
		}
		if (status === "exhausted" && !retryFailed) {
			counts.failed++;
			counts.skipped++;
			continue;
		}
		queue.push({ item, attempts: retryFailed ? 0 : (record?.attempts ?? 0) });
	}
	log(`jobs: ${job.name}: ${items.length} item(s) · ${counts.done} done · ${queue.length} to run${counts.skipped ? ` · ${counts.skipped} failed with no retries left (--retry-failed)` : ""}`);
	if (dryRun) {
		for (const { item } of queue) log(`  would run: ${item.command}`);
		return { ...counts, toRun: queue.length };
	}

	const maxAttempts = job.retries + 1;
	const runItem = async ({ item, attempts }) => {
		const startedAt = new Date(now()).toISOString();
		let last = { code: 0 };
		while (attempts < maxAttempts) {
			if (stopRequested(root)) return "stopped";
			attempts++;
			await updateState(root, (s) => {
				const items = jobState(s, job.name).items;
				items[item.key] = { status: "running", attempts, startedAt, log: item.log, ...keepTicket(items[item.key]) };
			});
			log(`jobs: ${job.name}: ${item.input ?? "run"} (attempt ${attempts}/${maxAttempts})`);
			last = await runCommand(item.command, { cwd: root, env: job.env, logFile: join(root, item.log), timeoutMs: job.timeoutMin * 60_000 });
			if (last.code === 0 && item.output && !existsSync(join(root, item.output))) {
				appendLog(root, item.log, `[shiftwork jobs] exit 0 but output ${item.output} was not written\n`);
				last = { code: 1, missingOutput: true };
			}
			const ok = last.code === 0;
			await updateState(root, (s) => {
				const items = jobState(s, job.name).items;
				items[item.key] = { status: ok ? "done" : "failed", attempts, startedAt, finishedAt: new Date(now()).toISOString(), code: last.code, log: item.log, ...keepTicket(items[item.key]) };
			});
			counts.ran++;
			if (ok) {
				counts.done++;
				return "done";
			}
			if (stopRequested(root)) break;
		}
		counts.failed++;
		log(`jobs: ${job.name}: ${item.input ?? "run"} failed (exit ${last.code}); log ${item.log}`);
		if (job.ticket && attempts >= maxAttempts) {
			const already = (await readState(root)).jobs[job.name]?.items[item.key]?.ticket;
			if (!already) {
				const ticket = await createFailureTicket(root, job, item, { code: last.code, attempts });
				const rel = relative(root, ticket.path);
				await updateState(root, (s) => {
					jobState(s, job.name).items[item.key].ticket = rel;
				});
				log(`jobs: ${job.name}: ticket ${rel}`);
			}
		}
		return "failed";
	};

	const workers = Array.from({ length: Math.min(job.concurrency, queue.length) }, async () => {
		while (queue.length) {
			if (stopRequested(root)) {
				counts.stopped = true;
				return;
			}
			const result = await runItem(queue.shift());
			if (result === "stopped") counts.stopped = true;
		}
	});
	await Promise.all(workers);
	if (queue.length || counts.stopped) counts.stopped = true;
	await updateState(root, (s) => {
		jobState(s, job.name).lastFinished = new Date(now()).toISOString();
	});
	return counts;
}

/** A failure ticket already written for an item is remembered, so a later failure writes no second one. */
function keepTicket(record) {
	return record?.ticket ? { ticket: record.ticket } : {};
}

function appendLog(root, log, text) {
	try {
		const fd = openSync(join(root, log), "a");
		writeSync(fd, text);
		closeSync(fd);
	} catch {}
}

/**
 * Loop over the scheduled jobs: run those due, sleep until the next is due, until STOP.
 * Jobs without a `schedule` are not run here (`shiftwork jobs run` runs them).
 * `maxRounds` bounds the loop (tests). Resolves 3 when stopped.
 */
export async function watchJobs(root, { jobs, log = console.log, now = () => Date.now(), sleep = defaultSleep, maxRounds = Infinity, pollMs = 1000 } = {}) {
	jobs ??= await loadJobs(root);
	const scheduled = jobs.filter((j) => j.schedule);
	if (!scheduled.length) throw new Error('no job has a "schedule": nothing to watch (use "shiftwork jobs run")');
	log(`jobs: watching ${scheduled.length} scheduled job(s); create STOP or press Ctrl-C to stop`);
	let worst = 0;
	for (let round = 0; round < maxRounds; round++) {
		if (stopRequested(root)) return 3;
		const state = await readState(root);
		const due = scheduled.filter((j) => nextDue(j.schedule, state.jobs[j.name]?.lastRun ?? null, now()) <= now());
		if (due.length) {
			const { code } = await runJobs(root, { jobs, names: due.map((j) => j.name), log, now });
			if (code === 3) return 3;
			worst = Math.max(worst, code);
			continue;
		}
		const next = Math.min(...scheduled.map((j) => nextDue(j.schedule, state.jobs[j.name]?.lastRun ?? null, now())));
		if (next === Infinity) {
			log("jobs: no scheduled job will ever be due again");
			return worst;
		}
		log(`jobs: next due ${new Date(next).toLocaleString()}`);
		// Sleep in short steps so a STOP file is noticed promptly.
		while (now() < next) {
			if (stopRequested(root)) return 3;
			await sleep(Math.min(pollMs, next - now()));
		}
	}
	return worst;
}

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeSchedule(schedule) {
	if (!schedule) return "manual";
	if (schedule.everyMin) return `every ${schedule.everyMin} min`;
	if (schedule.at) return `daily at ${schedule.at}`;
	return `cron ${schedule.cron}`;
}

// ---------- CLI ----------

const USAGE = `usage: shiftwork jobs <list|run|watch|status> [options]
  list                         Jobs, schedule, next due time, item counts
  run [name...] [--force] [--retry-failed] [--dry-run]
                               Run jobs (all, or the named ones) in order/after order
  watch                        Run scheduled jobs when due, until STOP or Ctrl-C
  status [name...]             Per-item state: failed items with their log, pending ones
  --dir <path>                 Repo root (default: current directory)`;

/** `shiftwork jobs <sub>`: returns the exit code. */
export async function jobsCommand(argv, { log = console.log } = {}) {
	const { positionals, values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			dir: { type: "string" },
			force: { type: "boolean", default: false },
			"retry-failed": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	const [sub, ...names] = positionals;
	const root = values.dir ?? process.cwd();
	if (values.help || !sub) {
		log(USAGE);
		return sub || values.help ? 0 : 1;
	}
	switch (sub) {
		case "list":
			return listJobs(root, { log });
		case "status":
			return jobsStatus(root, { names, log });
		case "run": {
			const signals = values["dry-run"] ? null : installSignalStop({ root, log: console.error });
			try {
				const { code, summary } = await runJobs(root, { names, force: values.force, retryFailed: values["retry-failed"], dryRun: values["dry-run"], log });
				if (!values["dry-run"]) for (const s of summary) if (!s.skipped) log(`jobs: ${s.name}: ${s.done} done · ${s.failed} failed${s.stopped ? " · stopped" : ""}`);
				return code;
			} finally {
				signals?.dispose();
			}
		}
		case "watch": {
			const signals = installSignalStop({ root, log: console.error });
			try {
				return await watchJobs(root, { log });
			} finally {
				signals.dispose();
			}
		}
		default:
			throw new Error(`unknown jobs command "${sub}"\n${USAGE}`);
	}
}

async function listJobs(root, { log }) {
	const jobs = orderJobs(await loadJobs(root));
	const state = await readState(root);
	for (const job of jobs) {
		const c = await jobCounts(root, job, state);
		const last = state.jobs[job.name]?.lastRun ?? null;
		const due = job.schedule ? new Date(nextDue(job.schedule, last)).toLocaleString() : "—";
		const after = job.after.length ? ` · after ${job.after.join(", ")}` : "";
		log(`${job.name}  [${describeSchedule(job.schedule)}${after}]  next: ${due}  items: ${c.done}/${c.total} done · ${c.failed} failed · ${c.pending} pending`);
	}
	return 0;
}

async function jobsStatus(root, { names, log }) {
	const jobs = orderJobs(await loadJobs(root)).filter((j) => !names.length || names.includes(j.name));
	const state = await readState(root);
	let failed = 0;
	for (const job of jobs) {
		const js = state.jobs[job.name] ?? { items: {} };
		const c = await jobCounts(root, job, state);
		failed += c.failed;
		log(`${job.name}: ${c.done}/${c.total} done · ${c.failed} failed · ${c.pending} pending${js.lastRun ? ` · last run ${js.lastRun}` : ""}`);
		for (const item of await jobItems(root, job)) {
			const record = js.items?.[item.key];
			const s = itemStatus(job, item, record, root);
			if (s === "done") continue;
			const extra = record ? ` · ${record.attempts} attempt(s)${record.code != null ? ` · exit ${record.code}` : ""} · ${record.log}${record.ticket ? ` · ticket ${record.ticket}` : ""}` : "";
			log(`  ${s.padEnd(9)} ${item.input ?? "(run)"}${extra}`);
		}
	}
	return failed ? 2 : 0;
}
