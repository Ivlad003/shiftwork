import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLAIMED, frontier as computeFrontier, orderFrontier, READY, RESOLVED } from "./index.js";
import { isAlive, readOwner, takeClaim } from "./lock.js";
import { openTracker, writeAtomic } from "./tracker.js";

/** Default verify gate of an OpenSpec task; `<change>` is replaced by the change name. */
const DEFAULT_VERIFY = ["openspec validate <change>"];
/** The folder of finished changes that must never produce tickets. */
const ARCHIVE = "archive";

/**
 * Tracker on an OpenSpec layout. Each `openspec/changes/<change>/` is a feature;
 * each `- [ ] N.M title` task in its `tasks.md` is a ticket blocked by the previous
 * task. A checked box is a resolved ticket. Status beyond done/undone (claimed,
 * needs-info, …) plus shift reports and comments live in `.shiftwork.md` next to
 * `tasks.md`, one `## N.M` section per task. Resolving a task ticks its checkbox.
 *
 * The verify gate is `verify` (default `["openspec validate <change>"]`) plus the
 * task's own indented `Verify:` line, if any.
 */
export function openOpenSpecTracker(root, { verify } = {}) {
	const changesDir = join(root, "openspec", "changes");
	const claimsDir = join(root, "openspec", ".claims");
	const gate = (change) => (verify ?? DEFAULT_VERIFY).map((cmd) => cmd.replaceAll("<change>", change));
	const statePath = (change) => join(changesDir, change, ".shiftwork.md");
	const claimPath = (t) => join(claimsDir, `${t.feature}--${t.number}.lock`);
	const key = (t) => `${t.feature}/${t.number}`;

	async function liveClaim(t) {
		const owner = await readOwner(claimPath(t));
		return owner && isAlive(owner.pid) ? owner : null;
	}

	async function loadChangeTickets(change) {
		const dir = join(changesDir, change);
		let tasksText;
		try {
			tasksText = await readFile(join(dir, "tasks.md"), "utf8");
		} catch {
			return [];
		}
		const state = await readState(change);
		const tasks = parseTasks(tasksText);
		return tasks.map((task, index) => {
			const section = state?.sections.get(task.number);
			return {
				path: statePath(change),
				specPath: join(dir, "proposal.md"),
				feature: change,
				number: task.number,
				title: task.title,
				status: task.done ? RESOLVED : (statusOf(section)?.toLowerCase() ?? READY),
				blockedBy: index > 0 ? [tasks[index - 1].number] : [],
				type: undefined,
				model: undefined,
				skills: [],
				budget: undefined,
				verify: [...gate(change), ...task.verify],
				checkboxes: [{ done: task.done, text: task.title }],
				lastRoute: lastRouteOf(section),
			};
		});
	}

	async function list() {
		let entries;
		try {
			entries = await readdir(changesDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const tickets = [];
		const changes = entries
			.filter((e) => e.isDirectory() && e.name !== ARCHIVE && !e.name.startsWith("."))
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of changes) {
			tickets.push(...(await loadChangeTickets(entry.name)));
		}
		return tickets;
	}

	async function readState(change) {
		try {
			return splitSections(await readFile(statePath(change), "utf8"));
		} catch {
			return null;
		}
	}

	async function writeState(change, state) {
		await mkdir(join(changesDir, change), { recursive: true });
		await writeAtomic(statePath(change), renderState(state));
	}

	async function setStatus(ticketOrClaim, status) {
		const t = ticketOrClaim.ticket ?? ticketOrClaim;
		const state = (await readState(t.feature)) ?? freshState(t.feature);
		const section = state.sections.get(t.number) ?? "";
		state.sections.set(t.number, withStatus(section, status));
		await writeState(t.feature, state);
		if (status === RESOLVED) await tickCheckbox(t);
	}

	return {
		list,

		/** Ready tasks with resolved blockers, plus claimed tasks whose runner is gone. */
		async frontier() {
			const tickets = await list();
			const orphaned = [];
			for (const t of tickets) {
				if (t.status === CLAIMED && !(await liveClaim(t))) orphaned.push(t);
			}
			const reopened = tickets.map((t) => (orphaned.includes(t) ? { ...t, status: READY } : t));
			const ready = new Set(computeFrontier(reopened).map(key));
			// Orphaned claims included: they are reopened above and matched by key here.
			return orderFrontier(tickets.filter((t) => ready.has(key(t))), tickets, { current: null });
		},

		/** Take an exclusive claim on `ticket`; null when a live process already holds it. */
		async claim(t, { pid = process.pid } = {}) {
			await mkdir(claimsDir, { recursive: true });
			const path = claimPath(t);
			const owner = { pid, token: randomUUID(), at: new Date().toISOString() };
			if (!(await takeClaim(root, path, owner))) return null;
			await setStatus(t, CLAIMED);
			return { ticket: t, path, ...owner };
		},

		async release(claim) {
			const owner = await readOwner(claim.path);
			if (owner?.token === claim.token) await unlink(claim.path).catch(() => {});
		},

		/** Live claims with their owner pid and timestamp. */
		async activeClaims() {
			const tickets = await list();
			const live = [];
			for (const t of tickets) {
				const owner = await readOwner(claimPath(t));
				if (owner && isAlive(owner.pid)) live.push({ ticket: t, ...owner });
			}
			return live;
		},

		setStatus,

		async appendComment(ticketOrClaim, markdown) {
			const t = ticketOrClaim.ticket ?? ticketOrClaim;
			const state = (await readState(t.feature)) ?? freshState(t.feature);
			const body = state.sections.get(t.number)?.trim();
			state.sections.set(t.number, body ? `${body}\n\n${markdown.trim()}\n` : `${markdown.trim()}\n`);
			await writeState(t.feature, state);
		},
	};
}

/** Parse the numbered `- [ ] N.M title` tasks of a tasks.md, in file order. */
export function parseTasks(text) {
	const tasks = [];
	let current;
	for (const line of text.split("\n")) {
		const task = line.match(/^(\s*)- \[( |x|X)\] (\d+(?:\.\d+)*)\s+(.+?)\s*$/);
		if (task) {
			current = { indent: task[1].length, done: task[2] !== " ", number: task[3], title: task[4], verify: [] };
			tasks.push(current);
			continue;
		}
		// A task's own Verify gate: an indented `Verify:` (sub-)line under the task.
		const verifyLine = line.match(/^(\s+)(?:-\s*)?Verify:\s*(.+?)\s*$/);
		if (current && verifyLine && verifyLine[1].length > current.indent) {
			current.verify.push(...verifyCommands(verifyLine[2]));
		}
	}
	return tasks;
}

/** Verify commands: the backtick-quoted spans; without backticks, split on "·". */
function verifyCommands(value) {
	const quoted = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
	if (quoted.length) return quoted;
	return value
		.split(/·/)
		.map((cmd) => cmd.trim())
		.filter(Boolean);
}

/** Split a .shiftwork.md into the head and one body per `## N.M` section. */
function splitSections(text) {
	const state = { head: "", sections: new Map() };
	let number = null;
	let buffer = [];
	const flush = () => {
		if (number === null) state.head = buffer.join("\n");
		else state.sections.set(number, buffer.join("\n"));
	};
	for (const line of text.split("\n")) {
		const heading = line.match(/^## (\d+(?:\.\d+)*)\s*$/);
		if (heading) {
			flush();
			number = heading[1];
			buffer = [];
		} else {
			buffer.push(line);
		}
	}
	flush();
	return state;
}

function renderState({ head, sections }) {
	let text = `${head.trimEnd()}\n`;
	for (const [number, body] of sections) {
		text += `\n## ${number}\n\n${body.trim()}\n`;
	}
	return text;
}

function freshState(change) {
	return {
		head: [
			`# Shiftwork: ${change}`,
			"",
			`<!-- Shiftwork state for the OpenSpec change "${change}": one \`## N.M\` section per task of tasks.md. The runner owns the **Status:** lines; shift reports, handoff notes and comments live under each task's section. Put notes under the task's own section. -->`,
		].join("\n"),
		sections: new Map(),
	};
}

const STATUS_LINE = /^\s*(?:\*\*)?Status:(?:\*\*)?[ \t]*[^\r\n]*$/im;

/** The section body with its Status line set, creating the line when missing. */
function withStatus(section, status) {
	const line = `**Status:** ${status}`;
	if (STATUS_LINE.test(section)) return section.replace(STATUS_LINE, line);
	const body = section.trim();
	return body ? `${line}\n\n${body}\n` : `${line}\n`;
}

function statusOf(section) {
	return section?.match(/^\s*(?:\*\*)?Status:(?:\*\*)?\s*(.+?)\s*$/im)?.[1];
}

/** Model of the latest shift report in the section: `### Shift N — <backend> <model> (<thinking>)`. */
function lastRouteOf(section) {
	let model;
	for (const match of section?.matchAll(/^### Shift \d+ — \S+ (\S+) \([^)]*\)$/gm) ?? []) {
		model = match[1];
	}
	return model;
}

/** Tick the task's checkbox in tasks.md (`- [ ] N.M` → `- [x] N.M`), leaving all other bytes alone. */
async function tickCheckbox(t) {
	const path = join(dirname(t.path), "tasks.md");
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	const number = t.number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const box = new RegExp(`^(\\s*- \\[) (\\] ${number}(?=\\s|$))`, "m");
	const next = text.replace(box, "$1x$2");
	if (next !== text) await writeAtomic(path, next);
}

/** Which tracker the repo at `root` uses: the configured one, or auto-detected. */
export async function detectTracker(root, config = {}) {
	if (config.tracker !== undefined) return config.tracker;
	if (existsSync(join(root, ".scratch"))) return "scratch";
	if (existsSync(join(root, "openspec", "changes"))) return "openspec";
	return "scratch";
}

/**
 * Open the tracker of the repo at `root`: `config.tracker` decides when set
 * ("scratch" | "openspec"); otherwise `.scratch/` wins when it exists, then
 * `openspec/changes/`, then the mattpocock tracker by default.
 */
export async function openRepoTracker(root, config = {}) {
	const kind = await detectTracker(root, config);
	if (kind === "openspec") return openOpenSpecTracker(root, { verify: config.openspec?.verify });
	return openTracker(root);
}
