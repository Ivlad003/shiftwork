import { readFile } from "node:fs/promises";
import { loadTickets, READY } from "shiftwork-core";

import { execIn } from "./exec.js";

/** Statuses at or past ready-for-agent: once an agent may hold the ticket, it counts. */
const READY_OR_LATER = new Set([READY, "claimed", "resolved"]);

/** A `**Verify:**` line with something after the colon (core's field parser skips empty values, so read the line directly). */
const VERIFY_LINE = /^[ \t]*(?:\*\*)?Verify:(?:\*\*)?[ \t]*(.*?)[ \t]*$/m;

const pad = (number) => String(Number(number)).padStart(2, "0");

/**
 * Tracker root for `tickets check` when `--dir` is omitted.
 *
 * The runner runs Verify inside the ticket's worktree, but planning writes the
 * live `.scratch` at the main checkout. So a **linked** worktree (its git dir
 * differs from the common dir) resolves to the primary worktree: the first
 * `worktree` line of `git worktree list --porcelain`. A normal clone (even from
 * a subdirectory) and a non-git cwd keep `cwd`. `--dir` (passed as `dir`) wins.
 * Paths come back absolute (`--path-format=absolute`), so a relative `.git`
 * from a subdirectory is never mistaken for a different repo.
 *
 * @param {{ cwd?: string, dir?: string, exec?: (args: string[]) => Promise<string> }} [options]
 * `exec` is the injectable command runner (default {@link execIn}`(cwd)`).
 */
export async function resolveTrackerRoot({ cwd = process.cwd(), dir, exec } = {}) {
	if (dir) return dir;
	const run = exec ?? execIn(cwd);
	try {
		const absolute = async (flag) => (await run(["git", "rev-parse", "--path-format=absolute", flag])).trim();
		const gitDir = await absolute("--git-dir");
		const common = await absolute("--git-common-dir");
		if (!gitDir || !common || gitDir === common) return cwd;
		const list = await run(["git", "worktree", "list", "--porcelain"]);
		const line = list.split("\n").find((row) => row.startsWith("worktree "));
		if (line) return line.slice("worktree ".length).trim();
	} catch {
		// not a git repo, or git missing
	}
	return cwd;
}

/** `--except 01,03` (repeatable) → `["01", "03"]`; bare numbers are padded like ticket numbers. */
export function parseExcept(except) {
	const list = (Array.isArray(except) ? except : [except]).flatMap((value) => String(value ?? "").split(","));
	return [...new Set(list.map((s) => s.trim()).filter(Boolean).map((s) => (/^\d+$/.test(s) ? pad(s) : s)))];
}

/**
 * The planning ticket's verify gate: `shiftwork tickets check <feature>`.
 *
 * Passes when at least `min` (default 1) tickets besides the excepted ones
 * (default `01`, the plan itself) are `ready-for-agent` or later, each with at
 * least one acceptance checkbox and a non-empty `**Verify:**` line, and every
 * `**Blocked by:**` number of a counted ticket exists in the feature. No ticket
 * of the feature (excepted ones included) may block itself or sit on a blocker
 * cycle ({@link blockerCycles}); such tickets never count as workable.
 * An excepted plan ticket at `needs-info` with no implementation-ready ticket
 * also passes (`asked`): the plan asked instead of inventing a ticket. The
 * status alone is not enough — an agent can write it — so the ticket's
 * `## Comments` must end on a runner- or importer-written
 * `- Outcome: needs-info: …` line (a shift report, or the import's Shift 0).
 *
 * @returns {Promise<{ ok: boolean, problems: string[], ready: number }>} one
 * problem line per broken ticket (`<feature>/<NN>: no Verify line`) plus, when
 * too few tickets qualify, a count line naming the feature.
 */
export async function checkFeatureTickets({ root = process.cwd(), feature, min = 1, except = ["01"] } = {}) {
	const exceptions = new Set(parseExcept(except));
	const tickets = (await loadTickets(root)).filter((t) => t.feature === feature);
	if (!tickets.length) {
		return { ok: false, ready: 0, problems: [`${feature}: no tickets found in .scratch/${feature}/issues`] };
	}

	// Core's `parseTicket` skips an empty Verify value (the next line would be
	// swallowed as the field), so the gate reads the line from the raw file.
	const verifyLines = new Map(
		await Promise.all(
			tickets.map(async (t) => [t.number, Boolean(t.path && (await readFile(t.path, "utf8")).match(VERIFY_LINE)?.[1]?.trim())]),
		),
	);

	const numbers = new Set(tickets.map((t) => t.number));
	const candidates = tickets.filter((t) => !exceptions.has(t.number));
	const problems = [];

	for (const t of candidates) {
		for (const blocker of t.blockedBy) {
			if (!numbers.has(blocker)) problems.push(`${feature}/${t.number}: blocked by missing ${blocker}`);
		}
		// Statuses before ready (needs-triage, needs-info, …) are not claimed
		// workable, so they neither count nor fail.
		if (!READY_OR_LATER.has(t.status)) continue;
		if (!t.checkboxes.length) problems.push(`${feature}/${t.number}: no acceptance checkboxes`);
		if (!verifyLines.get(t.number)) problems.push(`${feature}/${t.number}: no Verify line`);
	}

	// Blocker cycles deadlock a feature: check every ticket, excepted ones included.
	const { selfBlocked, cycles } = blockerCycles(tickets);
	for (const number of selfBlocked) problems.push(`${feature}/${number}: blocked by itself`);
	for (const cycle of cycles) problems.push(`${feature}: blocker cycle ${cycle.join(" → ")}`);
	const onCycle = new Set([...selfBlocked, ...cycles.flat()]);

	// A ticket whose blocker does not exist, or that sits on a cycle, can never be unblocked, so it does not count.
	const workable = (t) => t.blockedBy.every((n) => numbers.has(n)) && !onCycle.has(t.number);
	const ready = candidates.filter((t) => workable(t) && READY_OR_LATER.has(t.status) && t.checkboxes.length && verifyLines.get(t.number));
	// The plan asked instead of inventing tickets: that is success when nothing
	// implementation-ready was written. A ready ticket still has to pass the gate.
	const askedPlans = await Promise.all(
		tickets.filter((t) => exceptions.has(t.number) && t.status === "needs-info").map(async (t) => recordedNeedsInfo(await readFile(t.path, "utf8"))),
	);
	const asked =
		askedPlans.some(Boolean) &&
		candidates.every((t) => !READY_OR_LATER.has(t.status)) &&
		!problems.some((line) => line.includes("blocked by missing")) &&
		onCycle.size === 0;
	if (asked) return { ok: true, problems: [], ready: 0, asked: true };
	if (ready.length < min) {
		const besides = [...exceptions].join(", ") || "none";
		problems.push(`${feature}: only ${ready.length} of ${min} required ticket${min === 1 ? "" : "s"} ready besides ${besides}`);
	}

	return { ok: problems.length === 0, problems, ready: ready.length };
}

/**
 * Blocker cycles among one feature's tickets, by a plain DFS over `blockedBy`
 * (an edge runs from a ticket to each of its blockers; missing blockers are skipped).
 *
 * @param {{ number?: string, blockedBy: string[] }[]} tickets
 * @returns {{ selfBlocked: string[], cycles: string[][] }} `selfBlocked`: tickets that
 * list their own number. `cycles`: each other cycle once, as a closed path that starts
 * and ends at its lowest number (`["03", "04", "03"]`), sorted by that start.
 */
export function blockerCycles(tickets) {
	const byNumber = new Map(tickets.filter((t) => t.number).map((t) => [t.number, t]));
	const sorted = (list) => [...list].sort((a, b) => Number(a) - Number(b));
	const blockers = (number) => sorted(new Set(byNumber.get(number).blockedBy)).filter((n) => n !== number && byNumber.has(n));
	const selfBlocked = sorted([...byNumber.values()].filter((t) => t.blockedBy.includes(t.number)).map((t) => t.number));

	const cycles = new Map();
	const done = new Set();
	const stack = [];
	const onStack = new Set();
	const visit = (number) => {
		stack.push(number);
		onStack.add(number);
		for (const next of blockers(number)) {
			if (onStack.has(next)) {
				const path = stack.slice(stack.indexOf(next));
				const start = path.indexOf(sorted(path)[0]);
				const rotated = [...path.slice(start), ...path.slice(0, start)];
				cycles.set(rotated.join(","), [...rotated, rotated[0]]);
			} else if (!done.has(next)) visit(next);
		}
		stack.pop();
		onStack.delete(number);
		done.add(number);
	};
	for (const number of sorted(byNumber.keys())) if (!done.has(number)) visit(number);

	return { selfBlocked, cycles: [...cycles.values()].sort((a, b) => Number(a[0]) - Number(b[0]) || a.join().localeCompare(b.join())) };
}

/**
 * Whether the runner (or the importer) recorded that this ticket asked: the last
 * `- Outcome:` line under `## Comments` is `- Outcome: needs-info…`. Only the runner
 * writes shift reports there; a status the agent flipped itself has no such line.
 */
function recordedNeedsInfo(markdown) {
	const comments = markdown.split(/^## /m).find((section) => section.startsWith("Comments"));
	if (!comments) return false;
	const outcomes = comments.split("\n").filter((line) => /^- Outcome: /.test(line));
	return /^- Outcome: needs-info\b/.test(outcomes.at(-1) ?? "");
}
