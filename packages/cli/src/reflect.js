import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openTracker, READY } from "shiftwork-core";

/**
 * `shiftwork reflect`: mine the shift logs (logs/<feature>/<NN>/attempt-*.jsonl) for shell steps
 * agents keep retyping across shifts, and suggest a script for each. The analysis is pure; the
 * file reading and writing sit at the edges.
 */

const SHELL_TOOL = /bash|shell|command|exec|terminal/i;
/** Lookups an agent does to read, not to act: never worth a script on their own. */
const TRIVIAL = new Set(["ls", "pwd", "cat", "head", "tail", "grep", "rg", "find", "echo", "sed", "wc", "cd", "which", "tree", "awk", "less", "stat", "file"]);
const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 200;

/** A shell command as a template: quoted args `<str>`, paths `<path>`, numbers `<n>`, hashes `<sha>`. */
export function normalizeCommand(command) {
	let text = String(command ?? "").trim();
	const wrapped = text.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
	if (wrapped) text = wrapped[2].trim();
	// A leading `cd <dir> &&` says where, not what.
	while (/^cd\s+\S+\s*(&&|;)\s*/.test(text)) text = text.replace(/^cd\s+\S+\s*(&&|;)\s*/, "");
	text = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " <str> ");
	const tokens = text.split(/\s+/).filter(Boolean).map(normalizeToken);
	// `node --test a.js b.js` and `node --test a.js` are the same step.
	return tokens.filter((t, i) => !(t.startsWith("<") && t === tokens[i - 1])).join(" ");
}

function normalizeToken(token) {
	if (/^<(str|path|n|sha)>$/.test(token)) return token;
	const flag = token.match(/^(--?[A-Za-z][\w-]*=)(.+)$/);
	if (flag) return `${flag[1]}${normalizeToken(flag[2])}`;
	if (/^-\d+$/.test(token)) return "-<n>";
	if (token.startsWith("-")) return token;
	if (/^[0-9a-f]{7,40}$/.test(token) && /\d/.test(token)) return "<sha>";
	if (/^[\d.,:-]+[a-z]?$/i.test(token) && /\d/.test(token)) return "<n>";
	if (token.includes("/") || /\.[A-Za-z][\w]{0,5}$/.test(token) || /[*?]/.test(token)) return "<path>";
	return token;
}

/** The shell step of a logged event, or null: only shell tool calls are steps a script can take. */
export function stepOf(event) {
	if (event?.type !== "tool" || !SHELL_TOOL.test(String(event.name ?? ""))) return null;
	const example = String(event.input ?? "").trim();
	if (!example) return null;
	const template = normalizeCommand(example);
	return template ? { template, example } : null;
}

/** One shift log's start time and shell steps, in order. Lines that don't parse are skipped. */
export function parseShiftLog(text) {
	let at = null;
	const steps = [];
	for (const line of String(text).split("\n")) {
		if (!line.trim()) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		at ??= record.at ?? null;
		const step = stepOf(record);
		if (step) steps.push(step);
	}
	return { at, steps };
}

const isTrivial = (template) => TRIVIAL.has(template.split(" ")[0]);

/**
 * Commands and runs of 2..maxN consecutive commands repeated in at least `min` different shifts.
 * `shifts`: [{ id, ticket, steps: [{ template, example }] }]. Ranked by occurrences × shifts.
 */
export function findRepeatedSteps(shifts, { min = 3, maxN = 4 } = {}) {
	const grams = new Map();
	for (const shift of shifts) {
		const steps = shift.steps.filter(Boolean);
		for (let n = 1; n <= maxN; n++) {
			for (let i = 0; i + n <= steps.length; i++) {
				const run = steps.slice(i, i + n);
				const templates = run.map((s) => s.template);
				if (isTrivial(templates[0]) || isTrivial(templates.at(-1))) continue;
				if (n > 1 && templates.every((t) => t === templates[0])) continue;
				const key = templates.join("\n");
				let gram = grams.get(key);
				if (!gram) grams.set(key, (gram = { steps: templates, occurrences: 0, shiftIds: new Set(), ticketIds: new Set(), examples: [] }));
				gram.occurrences++;
				gram.shiftIds.add(shift.id);
				gram.ticketIds.add(shift.ticket);
				const example = run.map((s) => s.example.slice(0, EXAMPLE_CHARS));
				if (gram.examples.length < MAX_EXAMPLES && !gram.examples.some((e) => e.join("\n") === example.join("\n"))) gram.examples.push(example);
			}
		}
	}
	const frequent = [...grams.values()].filter((g) => g.shiftIds.size >= min);
	// A run always seen inside a longer frequent run is reported as that longer run.
	const kept = frequent.filter(
		(g) => !frequent.some((longer) => longer.steps.length > g.steps.length && longer.occurrences >= g.occurrences && contains(longer.steps, g.steps)),
	);
	return kept
		.map((g) => ({
			steps: g.steps,
			occurrences: g.occurrences,
			shifts: g.shiftIds.size,
			score: g.occurrences * g.shiftIds.size,
			tickets: [...g.ticketIds].sort(),
			examples: g.examples,
		}))
		.sort((a, b) => b.score - a.score || b.steps.length - a.steps.length || a.steps.join().localeCompare(b.steps.join()));
}

function contains(haystack, needle) {
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		if (needle.every((t, j) => haystack[i + j] === t)) return true;
	}
	return false;
}

/**
 * The same verify command failing again and again, from the tickets' `## Comments`
 * (`- Verify: failed at \`cmd\``). `tickets`: [{ id, text }]. Commands that failed at least twice.
 */
export function findVerifyFailures(tickets) {
	const byCommand = new Map();
	for (const ticket of tickets) {
		const comments = String(ticket.text ?? "").split(/^## Comments\s*$/m)[1];
		if (!comments) continue;
		for (const match of comments.matchAll(/Verify: failed at `([^`]+)`/g)) {
			const command = match[1];
			let entry = byCommand.get(command);
			if (!entry) byCommand.set(command, (entry = { command, failures: 0, tickets: new Set() }));
			entry.failures++;
			entry.tickets.add(ticket.id);
		}
	}
	return [...byCommand.values()]
		.filter((e) => e.failures >= 2)
		.map((e) => ({ command: e.command, failures: e.failures, tickets: [...e.tickets].sort() }))
		.sort((a, b) => b.failures - a.failures || a.command.localeCompare(b.command));
}

/** A script name, path and bash skeleton for a repeated step; placeholders become arguments. */
export function suggestScript(candidate) {
	const words = [];
	for (const template of candidate.steps) {
		const stepWords = template
			.split(" ")
			.filter((t) => !t.startsWith("<") && !/^-[^-]/.test(t))
			.map((t) => t.replace(/^--/, "").replace(/=.*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
			.filter(Boolean)
			.slice(0, 3);
		for (const word of stepWords) if (!words.includes(word)) words.push(word);
	}
	let name = "";
	for (const word of words) {
		if (name && name.length + word.length + 1 > 40) break;
		name = name ? `${name}-${word}` : word;
	}
	name ||= "step";
	const path = `scripts/${name}.sh`;
	const args = [];
	const body = candidate.steps.map((template) =>
		template.replace(/<(str|path|n|sha)>/g, (_, kind) => {
			args.push(`<${kind}>`);
			return `"$${args.length}"`;
		}),
	);
	const lines = [
		"#!/usr/bin/env bash",
		`# ${name}: a step agents repeated ${candidate.occurrences} times in ${candidate.shifts} shifts (shiftwork reflect).`,
	];
	if (candidate.tickets?.length) lines.push(`# Seen in: ${candidate.tickets.join(", ")}`);
	lines.push("set -euo pipefail", "");
	if (args.length) lines.push(`[ $# -ge ${args.length} ] || { echo "usage: ${path} ${args.join(" ")}" >&2; exit 2; }`, "");
	lines.push(...body);
	return { name, path, skeleton: `${lines.join("\n")}\n` };
}

/** The whole reflection: ranked candidates with a script each, and repeated verify failures. */
export function buildReflection({ shifts, tickets = [], min = 3, sinceDays = null, now = new Date() }) {
	return {
		date: now.toISOString().slice(0, 10),
		min,
		sinceDays,
		shiftsScanned: shifts.length,
		candidates: findRepeatedSteps(shifts, { min }).map((c) => ({ ...c, suggestion: suggestScript(c) })),
		verifyFailures: findVerifyFailures(tickets),
	};
}

const code = (text) => (String(text).includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``);

/** The reflection as Markdown, for the terminal and `.scratch/reflections/<date>.md`. */
export function formatReflection(report) {
	const since = report.sinceDays == null ? "" : ` from the last ${report.sinceDays} day${report.sinceDays === 1 ? "" : "s"}`;
	const lines = [
		`# Shiftwork reflection — ${report.date}`,
		"",
		`Scanned ${report.shiftsScanned} shift log${report.shiftsScanned === 1 ? "" : "s"}${since}. Shell steps repeated in at least ${report.min} different shifts, ranked by occurrences × shifts.`,
		"",
	];
	if (!report.candidates.length) lines.push(`No step repeated in at least ${report.min} shifts.`, "");
	report.candidates.forEach((c, i) => {
		lines.push(
			`## ${i + 1}. ${code(c.steps.join(" && "))} — score ${c.score}`,
			"",
			`- Occurrences: ${c.occurrences} in ${c.shifts} shifts`,
			`- Tickets: ${c.tickets.join(", ")}`,
			"- Examples:",
			...c.examples.map((e) => `  - ${code(e.join(" && "))}`),
			`- Suggested script: \`${c.suggestion.path}\``,
			"",
			"```bash",
			c.suggestion.skeleton.trimEnd(),
			"```",
			"",
		);
	});
	if (report.verifyFailures.length) {
		lines.push("## Repeated verify failures", "");
		for (const f of report.verifyFailures) lines.push(`- ${code(f.command)} failed ${f.failures} times: ${f.tickets.join(", ")}`);
		lines.push("");
	}
	return lines.join("\n");
}

/** Every shift log under `root/logs`, as { id, ticket, at, steps }; `sinceDays` keeps the recent ones. */
export async function collectShiftLogs(root, { sinceDays = null, now = new Date() } = {}) {
	const logs = join(root, "logs");
	const cutoff = sinceDays == null ? null : now.getTime() - sinceDays * 86_400_000;
	const shifts = [];
	for (const feature of await dirs(logs)) {
		for (const number of await dirs(join(logs, feature))) {
			const dir = join(logs, feature, number);
			const files = (await readdir(dir).catch(() => [])).filter((f) => /^attempt-.+\.jsonl$/.test(f)).sort();
			for (const file of files) {
				const path = join(dir, file);
				const { at, steps } = parseShiftLog(await readFile(path, "utf8"));
				const time = at ? Date.parse(at) : (await stat(path)).mtimeMs;
				if (cutoff != null && !(time >= cutoff)) continue;
				shifts.push({ id: `${feature}/${number}/${file}`, ticket: `${feature}/${number}`, at, steps });
			}
		}
	}
	return shifts;
}

async function dirs(path) {
	try {
		return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
	} catch {
		return [];
	}
}

/** Every ticket of the tracker as { id, text }, for the verify-failure scan. */
export async function collectTickets(root) {
	const tickets = await openTracker(root).list();
	return Promise.all(tickets.map(async (t) => ({ id: `${t.feature}/${t.number}`, text: await readFile(t.path, "utf8").catch(() => "") })));
}

/**
 * Save the report to `.scratch/reflections/<date>.md` and file a ready-for-agent feature
 * `.scratch/automate-<name>/` with one ticket per top suggestion. No candidates, no feature.
 */
export async function writeReflection(root, report, { top = 5 } = {}) {
	const scratch = join(root, ".scratch");
	const reportPath = join(scratch, "reflections", `${report.date}.md`);
	await mkdir(join(scratch, "reflections"), { recursive: true });
	await writeFile(reportPath, `${formatReflection(report)}\n`);

	const chosen = report.candidates.slice(0, top);
	if (!chosen.length) return { reportPath, feature: null, tickets: [] };

	const base = `automate-${chosen[0].suggestion.name}`;
	let feature = base;
	for (let k = 2; existsSync(join(scratch, feature)); k++) feature = `${base}-${k}`;
	const issues = join(scratch, feature, "issues");
	await mkdir(issues, { recursive: true });

	const spec = [
		`# Spec: Automate the steps agents repeat (${report.date})`,
		"",
		`**Status:** ${READY}`,
		"",
		`Source: \`shiftwork reflect\` — .scratch/reflections/${report.date}.md`,
		"",
		"## Problem",
		"",
		`Agents retyped the same shell steps in at least ${report.min} different shifts. Each ticket below writes one script for one repeated step and points agents at it, so the next shifts run the script instead of rebuilding the step.`,
		"",
		"## Steps",
		"",
		...chosen.map((c) => `- ${code(c.steps.join(" && "))} → \`${c.suggestion.path}\` (${c.occurrences}× in ${c.shifts} shifts)`),
		"",
	].join("\n");
	await writeFile(join(scratch, feature, "spec.md"), spec);

	const tickets = [];
	for (const [i, c] of chosen.entries()) {
		const number = String(i + 1).padStart(2, "0");
		const { path: script } = c.suggestion;
		const title = `Write script ${script}`;
		const step = c.steps.join(" && ");
		const text = [
			`# ${number}: ${title}`,
			"",
			`**What to build:** Write \`${script}\` that automates the step ${code(step)} — repeated ${c.occurrences} times in ${c.shifts} shifts (${c.tickets.join(", ")}) — and replace the repeated step: tell agents to run the script instead.`,
			"",
			"**Blocked by:** None (can start immediately)",
			"",
			`**Status:** ${READY}`,
			"**Type:** code",
			`**Verify:** \`bash -n ${script}\` · \`test -x ${script}\``,
			"",
			`- [ ] \`${script}\` exists, is executable and runs the step end to end`,
			"- [ ] The parts that varied between shifts (`<path>`, `<str>`, `<n>`, `<sha>`) are arguments, with a usage line",
			"- [ ] AGENTS.md (or the worker prompt) tells agents to run the script for this step",
			"",
			"## Context",
			"",
			"Examples from the shift logs:",
			"",
			...c.examples.map((e) => `- ${code(e.join(" && "))}`),
			"",
			"Skeleton (from `shiftwork reflect`):",
			"",
			"```bash",
			c.suggestion.skeleton.trimEnd(),
			"```",
			"",
		].join("\n");
		const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
		const path = join(issues, `${number}-${slug}.md`);
		await writeFile(path, text);
		tickets.push({ feature, number, title, path });
	}
	// Setting the status it already has syncs the spec's ticket table.
	await openTracker(root).setStatus(tickets[0], READY);
	return { reportPath, feature, tickets };
}

/** `shiftwork reflect [--since <days>] [--min <n>] [--write] [--dir <path>]`. */
export async function reflect(argv, { cwd = process.cwd(), now = new Date(), log = console.log } = {}) {
	const { values } = parseArgs({
		args: argv,
		options: {
			since: { type: "string" },
			min: { type: "string" },
			write: { type: "boolean" },
			dir: { type: "string" },
		},
	});
	const min = values.min === undefined ? 3 : Number(values.min);
	if (!Number.isInteger(min) || min < 1) throw new Error(`--min must be a positive integer, got "${values.min}"`);
	const sinceDays = values.since === undefined ? null : Number(values.since);
	if (sinceDays !== null && !(sinceDays > 0)) throw new Error(`--since must be a positive number of days, got "${values.since}"`);
	const root = values.dir ?? cwd;
	const shifts = await collectShiftLogs(root, { sinceDays, now });
	const report = buildReflection({ shifts, tickets: await collectTickets(root), min, sinceDays, now });
	log(formatReflection(report));
	if (values.write) {
		const written = await writeReflection(root, report);
		log(`Report: ${written.reportPath}`);
		if (written.feature) log(`Feature: .scratch/${written.feature}/ (${written.tickets.length} ticket${written.tickets.length === 1 ? "" : "s"}, ready-for-agent)`);
	}
	return 0;
}
