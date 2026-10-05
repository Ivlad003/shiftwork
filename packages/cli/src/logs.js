import { watch } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openRunState } from "shiftwork-core";
import { currentShiftLogName, shiftLogSlot } from "./dashboard.js";

/** How often `-f` looks for new lines, new attempt files and the runner's liveness when fs.watch says nothing. */
export const POLL_MS = 500;

const USAGE = "usage: shiftwork logs [<feature>/<NN>] [-f|--follow] [--raw] [--all] [--dir <path>]";

const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const FG_OFF = "\x1b[39m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const INTENSITY_OFF = "\x1b[22m";

const TIME_WIDTH = 9; // "HH:MM:SS "
const SHELL_TOOLS = /^(bash|shell|sh|exec|exec_command|run|run_command|terminal|command)$/i;
const EDIT_TOOLS = /^(edit|write|multiedit|multi_edit|create|patch|apply_patch|str_replace|str_replace_editor|write_file|edit_file)$/i;

/**
 * One shift-log event (an NDJSON record of createShiftLogger) as display lines, for
 * `shiftwork logs`: `start` a header, `text` the agent's words wrapped to `width`, `tool`
 * `$ cmd` / `✎ path` / `⚙ name {input}`, `turn` and `cost` dim, `error` red, `end` the stop
 * reason. `context` and unknown events are skipped unless `raw` (then `context` is a ctx line
 * and unknown events their JSON). Every line starts with the event's HH:MM:SS (UTC, as the
 * dashboard's Log tab) and, when given, `prefix` (the ticket, when several are followed).
 * Returns [] for a skipped event.
 */
export function formatEvent(event, { color = false, raw = false, width = 100, prefix = "" } = {}) {
	const time = typeof event?.at === "string" ? event.at.slice(11, 19) : "??:??:??";
	const lead = prefix ? `${prefix} ` : "";
	const paint = (on, off, text) => (color ? `${on}${text}${off}` : text);
	const one = (body, tone) => {
		const text = `${lead}${time} ${body}`;
		return [tone ? paint(tone[0], tone[1], text) : text];
	};
	switch (event?.type) {
		case "start": {
			const parts = [
				event.backend,
				event.model,
				event.tier,
				event.attempt !== undefined && event.attempt !== null ? `attempt ${event.attempt}` : null,
				event.shift !== undefined && event.shift !== null ? `shift ${event.shift}` : null,
			].filter(Boolean);
			return one(["▶ start", ...parts].join(" · "), [BOLD, INTENSITY_OFF]);
		}
		case "text": {
			const indent = `${lead}${" ".repeat(TIME_WIDTH)}`;
			const room = Math.max(20, width - lead.length - TIME_WIDTH);
			const lines = wrap(String(event.text ?? ""), room);
			return lines.map((l, i) => (i === 0 ? `${lead}${time} ${l}` : `${indent}${l}`));
		}
		case "tool":
			return one(toolLine(event, width - lead.length - TIME_WIDTH), [CYAN, FG_OFF]);
		case "turn": {
			const cost = event.costUsd > 0 ? ` · ${money(event.costUsd)}` : "";
			return one(`· turn ${Number(event.usage?.totalTokens ?? 0).toLocaleString("en-US")} tokens${cost}`, [DIM, INTENSITY_OFF]);
		}
		case "cost":
			return one(`· cost ${money(event.costUsd)}`, [DIM, INTENSITY_OFF]);
		case "context":
			return raw ? one(`· ctx ${Math.round(event.percent ?? 0)}%`, [DIM, INTENSITY_OFF]) : [];
		case "error":
			return one(`✖ error: ${event.message ?? ""}`, [RED, FG_OFF]);
		case "end":
			return one(`■ end · ${event.stopReason ?? "?"}`, event.stopReason === "error" ? [RED, FG_OFF] : [BOLD, INTENSITY_OFF]);
		case "wait":
			return one(`· wait until ${typeof event.until === "string" ? event.until.slice(11, 19) : event.until}`, [DIM, INTENSITY_OFF]);
		case "probe":
			return one(`· probe ${event.provider} ${event.ok ? "ok" : "still limited"}`, [DIM, INTENSITY_OFF]);
		default:
			return raw ? one(JSON.stringify(event), [DIM, INTENSITY_OFF]) : [];
	}
}

/** One raw NDJSON line as display lines: formatEvent, or the line itself (with --raw) when it is not JSON. */
export function formatLine(line, options = {}) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		return options.raw ? [`${options.prefix ? `${options.prefix} ` : ""}${line}`] : [];
	}
	return formatEvent(event, options);
}

function toolLine(event, room) {
	const name = String(event.name ?? "tool");
	const input = event.input;
	const command = typeof input === "string" && SHELL_TOOLS.test(name) ? input : (input?.command ?? input?.cmd);
	if (command !== undefined && command !== null) {
		const text = Array.isArray(command) ? command.join(" ") : String(command);
		const [first, ...rest] = text.split("\n");
		return `$ ${first}${rest.some((l) => l.trim()) ? " …" : ""}`;
	}
	const path = input?.file_path ?? input?.filePath ?? input?.path;
	if (path && EDIT_TOOLS.test(name)) return `✎ ${path}`;
	if (input === undefined || input === null) return `⚙ ${name}`;
	const json = typeof input === "string" ? input : JSON.stringify(input);
	const max = Math.max(20, room - name.length - 3);
	return `⚙ ${name} ${json.length > max ? `${json.slice(0, max - 1)}…` : json}`;
}

function money(usd) {
	return `$${Number(usd ?? 0).toFixed(2)}`;
}

/** Word-wrap `text` to `width` columns, keeping its own line breaks; an overlong word is split. */
function wrap(text, width) {
	const out = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		for (let word of paragraph.split(/\s+/).filter(Boolean)) {
			while (word.length > width) {
				if (current) {
					out.push(current);
					current = "";
				}
				out.push(word.slice(0, width));
				word = word.slice(width);
			}
			if (!current) current = word;
			else if (current.length + 1 + word.length <= width) current += ` ${word}`;
			else {
				out.push(current);
				current = word;
			}
		}
		out.push(current);
	}
	while (out.length > 1 && out.at(-1) === "") out.pop();
	return out;
}

/**
 * The whole lines of `file` from byte `offset` on, and the offset after the last one: a
 * line still being written (no newline yet) is left for the next read. A missing file is
 * no lines; a file shorter than `offset` (truncated, replaced) is read from the start.
 */
export async function readFrom(file, offset = 0) {
	let handle;
	try {
		handle = await open(file, "r");
	} catch {
		return { lines: [], offset };
	}
	try {
		const { size } = await handle.stat();
		const start = size < offset ? 0 : offset;
		if (size === start) return { lines: [], offset: start };
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const end = buffer.lastIndexOf(0x0a);
		if (end < 0) return { lines: [], offset: start };
		const lines = buffer.subarray(0, end).toString("utf8").split("\n").filter((l) => l.trim());
		return { lines, offset: start + end + 1 };
	} finally {
		await handle.close();
	}
}

/** A ticket's shift logs (`logs/<feature>/<NN>/attempt-*.jsonl`), oldest first by mtime, as absolute paths. */
export async function listShiftLogs(root, feature, number) {
	const dir = join(root, "logs", feature, number);
	return (await statLogs(dir)).map((f) => f.path);
}

async function statLogs(dir) {
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const files = [];
	for (const name of names) {
		if (!/^attempt-.+\.jsonl$/.test(name)) continue;
		try {
			const path = join(dir, name);
			files.push({ path, name, mtime: (await stat(path)).mtimeMs });
		} catch {
			// Gone between readdir and stat.
		}
	}
	return files.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name, "en", { numeric: true }));
}

/** The most recently written shift log of any ticket: { key, file }, or null. */
async function newestShiftLog(root) {
	let newest = null;
	let features;
	try {
		features = await readdir(join(root, "logs"));
	} catch {
		return null;
	}
	for (const feature of features) {
		let numbers;
		try {
			numbers = await readdir(join(root, "logs", feature));
		} catch {
			continue;
		}
		for (const number of numbers) {
			const last = (await statLogs(join(root, "logs", feature, number))).at(-1);
			if (last && (!newest || last.mtime > newest.mtime)) newest = { key: `${feature}/${number}`, file: last.path, mtime: last.mtime };
		}
	}
	return newest;
}

/** The live runner's workers as follow targets, each at its current shift log; null when no runner is live. */
async function liveTargets(root) {
	const run = await openRunState(root).read();
	if (!run?.live) return null;
	const targets = [];
	for (const worker of run.workers ?? []) {
		const { feature, number } = worker.ticket ?? {};
		if (!feature || !number || worker.attempt === undefined || worker.attempt === null) continue;
		const dir = join(root, "logs", feature, number);
		targets.push({ key: `${feature}/${number}`, file: join(dir, await currentShiftLogName(dir, shiftLogSlot(worker.attempt, worker.shift))) });
	}
	return targets;
}

function parseTicket(arg) {
	const match = String(arg).match(/^([^/\s]+)\/([^/\s]+)$/);
	if (!match) return null;
	const number = /^\d$/.test(match[2]) ? `0${match[2]}` : match[2];
	return { feature: match[1], number };
}

/**
 * `shiftwork logs [<feature>/<NN>] [-f|--follow] [--raw] [--all] [--dir <path>]` (GitHub #13):
 * read the agents' shift logs as they work.
 *
 * With no ticket it shows the live runner's workers, each at its current shift log (lines
 * prefixed `feature/NN` when there are several); with no live runner, the most recent shift
 * log. With a ticket, that ticket's current (most recently written) attempt log; `--all`
 * prints every attempt, oldest first. `-f` keeps following by byte offset — fs.watch plus a
 * poll every `pollMs` — switching (with a separator) when a new attempt file appears; it
 * follows the live runner across tickets until no runner is live (exit 0), anything else
 * until SIGINT (or `signal`). Colour unless NO_COLOR or not a TTY.
 *
 * `options` (tests): out, error, color, width, pollMs, signal. Returns the exit code.
 */
export async function logs(argv, options = {}) {
	const out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
	// `shiftwork logs | head`: a closed pipe ends the command quietly.
	if (!options.out) process.stdout.on("error", (e) => (e.code === "EPIPE" ? process.exit(0) : undefined));
	const error = options.error ?? console.error;
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				follow: { type: "boolean", short: "f" },
				raw: { type: "boolean" },
				all: { type: "boolean" },
				dir: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (e) {
		error(`shiftwork logs: ${e.message}\n${USAGE}`);
		return 1;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		out(USAGE);
		return 0;
	}
	if (positionals.length > 1) {
		error(USAGE);
		return 1;
	}
	const ticket = positionals.length ? parseTicket(positionals[0]) : null;
	if (positionals.length && !ticket) {
		error(`shiftwork logs: "${positionals[0]}" is not <feature>/<NN>\n${USAGE}`);
		return 1;
	}
	if (values.all && !ticket) {
		error(`shiftwork logs: --all needs a ticket\n${USAGE}`);
		return 1;
	}
	const root = resolve(values.dir ?? process.cwd());
	const follow = Boolean(values.follow);
	const color = options.color ?? (!process.env.NO_COLOR && Boolean(process.stdout.isTTY));
	const width = options.width ?? (process.stdout.columns || 100);
	const format = { color, raw: Boolean(values.raw), width };

	let resolveTargets;
	let liveMode = false;
	if (ticket) {
		const key = `${ticket.feature}/${ticket.number}`;
		const files = await listShiftLogs(root, ticket.feature, ticket.number);
		if (!files.length && !follow) {
			error(`shiftwork logs: no shift logs for ${key} yet (logs/${key}/)`);
			return 1;
		}
		if (values.all) {
			const printer = createPrinter(out, format);
			for (const file of files.slice(0, -1)) await printer.drain({ key, file }, false);
			if (!follow && files.length) {
				await printer.drain({ key, file: files.at(-1) }, false);
				return 0;
			}
			return pump({ printer, follow, resolveTargets: async () => latestOf(root, ticket), watchDir: join(root, "logs"), options });
		}
		resolveTargets = async () => latestOf(root, ticket);
	} else {
		const live = await liveTargets(root);
		if (live) {
			liveMode = true;
			resolveTargets = () => liveTargets(root);
		} else {
			const newest = await newestShiftLog(root);
			if (!newest && !follow) {
				error(`shiftwork logs: no runner is live and there are no shift logs yet (${relative(process.cwd(), join(root, "logs")) || "logs"}/)`);
				return 1;
			}
			resolveTargets = async () => {
				const n = await newestShiftLog(root);
				return n ? [n] : [];
			};
		}
	}
	return pump({ printer: createPrinter(out, format), follow, resolveTargets, liveMode, watchDir: join(root, "logs"), options });
}

async function latestOf(root, ticket) {
	const file = (await listShiftLogs(root, ticket.feature, ticket.number)).at(-1);
	return file ? [{ key: `${ticket.feature}/${ticket.number}`, file }] : [];
}

/** Prints shift logs from remembered byte offsets: a header when a file starts being shown, then its new lines. */
function createPrinter(out, format) {
	const offsets = new Map(); // file → byte offset
	return {
		offsets,
		/** Print `target.file`'s lines past its offset; `prefixed` puts the ticket in front of each. */
		async drain(target, prefixed) {
			if (!offsets.has(target.file)) {
				offsets.set(target.file, 0);
				const name = target.file.split(/[/\\]/).at(-1);
				const header = `── ${target.key} · ${name} ──`;
				out(format.color ? `${DIM}${header}${INTENSITY_OFF}` : header);
			}
			const { lines, offset } = await readFrom(target.file, offsets.get(target.file));
			offsets.set(target.file, offset);
			for (const line of lines) for (const shown of formatLine(line, { ...format, prefix: prefixed ? target.key : "" })) out(shown);
		},
	};
}

/**
 * Print the targets' logs once, or with `follow` keep printing until `signal`/SIGINT — or, in
 * live mode, until no runner is live. A target whose file changes (a new attempt) gets the new
 * file's header, its old file drained first; a target that drops out (its shift settled) is drained.
 */
async function pump({ printer, follow, resolveTargets, liveMode = false, watchDir, options }) {
	const pollMs = options.pollMs ?? POLL_MS;
	const current = new Map(); // key → file
	const tick = async () => {
		const targets = await resolveTargets();
		if (!targets) return false; // live mode: the runner is gone
		const prefixed = targets.length > 1;
		for (const [key, file] of current) {
			const next = targets.find((t) => t.key === key);
			if (!next || next.file !== file) {
				await printer.drain({ key, file }, prefixed);
				current.delete(key);
			}
		}
		for (const target of targets) {
			current.set(target.key, target.file);
			await printer.drain(target, prefixed);
		}
		return true;
	};

	if (!follow) {
		await tick();
		return 0;
	}

	const controller = new AbortController();
	const onSigint = () => controller.abort();
	const external = options.signal;
	if (external) external.addEventListener("abort", onSigint, { once: true });
	if (!external) process.once("SIGINT", onSigint);
	let wake = null;
	const poke = () => wake?.();
	let watcher = null;
	try {
		watcher = watch(watchDir, { recursive: true }, poke);
		watcher.on("error", () => {});
	} catch {
		// No fs.watch here (or no logs dir yet): polling alone.
	}
	try {
		while (!controller.signal.aborted) {
			const alive = await tick();
			if (liveMode && !alive) {
				for (const [key, file] of current) await printer.drain({ key, file }, current.size > 1);
				return 0;
			}
			await new Promise((r) => {
				const timer = setTimeout(done, pollMs);
				function done() {
					clearTimeout(timer);
					controller.signal.removeEventListener("abort", done);
					wake = null;
					r();
				}
				wake = done;
				controller.signal.addEventListener("abort", done, { once: true });
			});
		}
		// Stopped by SIGINT: print what is already there, then leave quietly.
		await tick().catch(() => {});
		return 0;
	} finally {
		watcher?.close();
		if (external) external.removeEventListener("abort", onSigint);
		else process.removeListener("SIGINT", onSigint);
	}
}
