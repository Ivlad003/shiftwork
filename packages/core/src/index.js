import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const VERSION = "0.0.1";

/** Statuses a runner may pick up or treat as finished. */
export const READY = "ready-for-agent";
export const CLAIMED = "claimed";
export const RESOLVED = "resolved";

const FIELD = (name) => new RegExp(`^\\s*(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*(.+?)\\s*$`, "im");

function field(text, name) {
	const match = text.match(FIELD(name));
	if (!match) return undefined;
	return match[1].replace(/<!--.*?-->/g, "").trim() || undefined;
}

function list(value, separator = /[,·]/) {
	if (!value) return [];
	return value
		.split(separator)
		.map((item) => item.trim().replace(/^`|`$/g, ""))
		.filter(Boolean);
}

/**
 * Parse one ticket in the mattpocock-skills local tracker format, plus the
 * optional Shiftwork lines `Type`, `Model`, `Skills`, `Budget`, `Verify`.
 */
export function parseTicket(markdown, path = "") {
	const heading = markdown.match(/^#\s+(\d+)\s*:\s*(.+)$/m);
	const fileNumber = basename(path).match(/^(\d+)-/)?.[1];
	const number = heading?.[1] ?? fileNumber;

	const blocked = field(markdown, "Blocked by");
	const blockedBy = !blocked || /^none\b/i.test(blocked) ? [] : (blocked.match(/\d+/g) ?? []).map(pad);

	const checkboxes = [...markdown.matchAll(/^\s*- \[( |x|X)\]\s+(.+)$/gm)].map((m) => ({
		done: m[1] !== " ",
		text: m[2].trim(),
	}));

	return {
		path,
		number: number ? pad(number) : undefined,
		title: heading?.[2]?.trim(),
		status: field(markdown, "Status")?.toLowerCase(),
		blockedBy,
		type: field(markdown, "Type"),
		model: field(markdown, "Model"),
		skills: list(field(markdown, "Skills"), /\s+/),
		budget: field(markdown, "Budget"),
		verify: commands(field(markdown, "Verify")),
		checkboxes,
	};
}

/** Verify commands: the backtick-quoted spans; without backticks, split on "·". */
function commands(value) {
	if (!value) return [];
	const quoted = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
	return quoted.length ? quoted : list(value, /·/);
}

function pad(number) {
	return String(Number(number)).padStart(2, "0");
}

/** Tickets that are ready for an agent and whose blockers are all resolved, lowest number first. */
export function frontier(tickets) {
	// Blockers are ticket numbers within the same feature.
	const key = (feature, number) => `${feature ?? ""}/${number}`;
	const status = new Map(tickets.map((t) => [key(t.feature, t.number), t.status]));
	return tickets
		.filter((t) => t.status === READY && t.blockedBy.every((n) => status.get(key(t.feature, n)) === RESOLVED))
		.sort((a, b) => Number(a.number) - Number(b.number) || String(a.feature).localeCompare(String(b.feature)));
}

/** Read every `.scratch/<feature>/issues/*.md` under `root`. */
export async function loadTickets(root = process.cwd()) {
	const scratch = join(root, ".scratch");
	let features;
	try {
		features = await readdir(scratch, { withFileTypes: true });
	} catch {
		return [];
	}
	const tickets = [];
	for (const feature of features.filter((f) => f.isDirectory())) {
		const issuesDir = join(scratch, feature.name, "issues");
		let files;
		try {
			files = await readdir(issuesDir);
		} catch {
			continue;
		}
		for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
			const path = join(issuesDir, file);
			tickets.push({ feature: feature.name, ...parseTicket(await readFile(path, "utf8"), path) });
		}
	}
	return tickets;
}
export { openTracker } from "./tracker.js";
export { openCooldowns } from "./cooldowns.js";
export { noRunState, openRunState } from "./run-state.js";
export { buildShiftPrompt, WORKER_PROMPT } from "./prompt.js";
export { decideNext, runFrontier } from "./runner.js";
export { loadConfig, THINKING_LEVELS, validateConfig } from "./config.js";
export { chooseHandoffMode, planShift, resolveTicketBudget, skillsForModel, TIER_ORDER } from "./planner.js";
export { applyProfileContext, createMeter } from "./meter.js";
export { classifyError, cooldownMs, DEFAULT_COOLDOWN_MS } from "./classify.js";
