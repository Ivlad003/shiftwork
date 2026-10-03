import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadTickets, READY } from "shiftwork-core";

import { execIn } from "./exec.js";

/** Statuses at or past ready-for-agent: once an agent may hold the ticket, it counts. */
const READY_OR_LATER = new Set([READY, "claimed", "resolved"]);

/** A `**Verify:**` line with something after the colon (core's field parser skips empty values, so read the line directly). */
const VERIFY_LINE = /^[ \t]*(?:\*\*)?Verify:(?:\*\*)?[ \t]*(.*?)[ \t]*$/m;

const pad = (number) => String(Number(number)).padStart(2, "0");

/**
 * Tracker root for `tickets check` when `--dir` is omitted.
 * A linked git worktree uses the primary worktree (the live `.scratch`); a
 * non-git cwd and a normal clone keep `cwd`. `--dir` (passed as `dir`) wins.
 */
export async function resolveTrackerRoot({ cwd = process.cwd(), dir, exec } = {}) {
	if (dir) return dir;
	const run = exec ?? execIn(cwd);
	try {
		const gitDir = resolve(cwd, (await run(["git", "rev-parse", "--git-dir"])).trim());
		const common = resolve(cwd, (await run(["git", "rev-parse", "--git-common-dir"])).trim());
		if (gitDir === common) return cwd;
		const list = await run(["git", "worktree", "list", "--porcelain"]);
		const line = list.split("\n").find((row) => row.startsWith("worktree "));
		if (line) return line.slice("worktree ".length);
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
 * `**Blocked by:**` number of a counted ticket exists in the feature.
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

	// A ticket whose blocker does not exist can never be unblocked, so it does not count.
	const workable = (t) => t.blockedBy.every((n) => numbers.has(n));
	const ready = candidates.filter((t) => workable(t) && READY_OR_LATER.has(t.status) && t.checkboxes.length && verifyLines.get(t.number));
	if (ready.length < min) {
		const besides = [...exceptions].join(", ") || "none";
		problems.push(`${feature}: only ${ready.length} of ${min} required ticket${min === 1 ? "" : "s"} ready besides ${besides}`);
	}

	return { ok: problems.length === 0, problems, ready: ready.length };
}
