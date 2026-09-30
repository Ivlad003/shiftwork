import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAlive, withLock } from "./lock.js";

/**
 * Open the runner state at `.pi/shiftwork-run.json`: what every runner process is
 * doing right now, one entry per runner pid with one worker per running shift
 * ({ ticket, attempt, shift, model, tier, usage, … }) and how each run ended.
 * A runner writes it under the shared-state lock, so parallel shifts and a
 * second `shiftwork run` in the same repo lose no updates; `shiftwork status`,
 * the dashboard, `shiftwork tui` and the pi status widget read the merged view.
 */
export function openRunState(root) {
	const path = join(root, ".pi", "shiftwork-run.json");
	// Writes are chained so a reader never sees two updates crossing each other.
	let queue = Promise.resolve();

	async function readRaw() {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			return null;
		}
	}

	/** The file's runner entries: the `runners` list, or a legacy flat file as one entry. */
	const runnersOf = (state) => {
		if (Array.isArray(state?.runners)) return state.runners;
		return state && (state.pid !== undefined || state.running !== undefined) ? [state] : [];
	};

	// One entry per runner pid, written under the shared-state lock: a second
	// `shiftwork run` never clobbers this runner's workers.
	const writeLocked = async (write) => {
		await withLock(root, async () => {
			const state = (await readRaw()) ?? {};
			const runners = runnersOf(state);
			await write(runners);
		});
	};

	const patchEntry = (pid, patch) =>
		writeLocked(async (runners) => {
			const entry = { ...(runners.find((r) => r.pid === pid) ?? { pid }), ...patch, pid, updatedAt: new Date().toISOString() };
			const next = runners.some((r) => r.pid === pid) ? runners.map((r) => (r.pid === pid ? entry : r)) : [...runners, entry];
			await writeAtomic(path, `${JSON.stringify({ runners: next }, null, 2)}\n`);
		});

	const patchWorker = (ticket, patch) =>
		writeLocked(async (runners) => {
			const pid = process.pid;
			const key = (t) => `${t?.feature ?? ""}/${t?.number ?? ""}`;
			const entry = { ...(runners.find((r) => r.pid === pid) ?? { pid, running: true }), pid };
			const old = (entry.workers ?? []).find((w) => key(w.ticket) === key(ticket));
			const worker = { ...old, ...patch };
			entry.workers = [...(entry.workers ?? []).filter((w) => w !== old), worker];
			entry.updatedAt = new Date().toISOString();
			const next = runners.some((r) => r.pid === pid) ? runners.map((r) => (r.pid === pid ? entry : r)) : [...runners, entry];
			await writeAtomic(path, `${JSON.stringify({ runners: next }, null, 2)}\n`);
		});

	const enqueue = (write) => {
		queue = queue.then(write);
		return queue.catch(() => {});
	};

	return {
		path,

		/**
		 * The merged view of every runner: the primary runner's fields (the most
		 * recently updated live one, else the last one to write) plus every live
		 * worker, with `live` telling whether any runner process is still there.
		 */
		async read() {
			const raw = await readRaw();
			const runners = runnersOf(raw).map(normalizeRunner).sort(byUpdated);
			if (!runners.length) return null;
			const live = runners.filter((r) => r.live);
			const primary = live.at(-1) ?? runners.at(-1);
			return {
				pid: primary.pid,
				running: live.length > 0,
				live: live.length > 0,
				startedAt: primary.startedAt,
				updatedAt: primary.updatedAt,
				finishedAt: primary.finishedAt ?? null,
				feature: primary.feature ?? null,
				logFile: primary.logFile,
				stoppedReason: primary.stoppedReason ?? null,
				summary: sumSummary(runners),
				workers: live.flatMap((r) => r.workers ?? []),
				runners,
			};
		},

		/** Merge `patch` into `patch.pid`'s runner entry (this process's by default). Never rejects: a run outlives its bookkeeping. */
		update(patch) {
			return enqueue(() => patchEntry(patch.pid ?? process.pid, patch));
		},

		/** Merge `patch` into this process's worker entry for `ticket`: one entry per running shift. */
		updateWorker(ticket, patch) {
			return enqueue(() => patchWorker(ticket, patch));
		},

		/** Remove this process's worker entry for `ticket` once the shift settles. */
		removeWorker(ticket) {
			return enqueue(() =>
				writeLocked(async (runners) => {
					const pid = process.pid;
					const entry = runners.find((r) => r.pid === pid);
					if (!entry?.workers?.length) return;
					const key = (t) => `${t?.feature ?? ""}/${t?.number ?? ""}`;
					entry.workers = entry.workers.filter((w) => key(w.ticket) !== key(ticket));
					entry.updatedAt = new Date().toISOString();
					await writeAtomic(path, `${JSON.stringify({ runners }, null, 2)}\n`);
				}),
			);
		},

		/** Forget this process's run; the file goes when no runner entry is left. */
		clear() {
			return enqueue(() =>
				writeLocked(async (runners) => {
					const rest = runners.filter((r) => r.pid !== process.pid);
					if (!rest.length) {
						await unlink(path).catch(() => {});
						return;
					}
					await writeAtomic(path, `${JSON.stringify({ runners: rest }, null, 2)}\n`);
				}),
			);
		},
	};
}

/** A run state that keeps nothing, for runs without a root on disk. */
export function noRunState() {
	return {
		path: undefined,
		read: async () => null,
		update: async () => {},
		updateWorker: async () => {},
		removeWorker: async () => {},
		clear: async () => {},
	};
}

/** One raw runner entry with its live flag, and legacy single-shift fields as one worker. */
function normalizeRunner(entry) {
	const workers = entry.workers ?? (entry.ticket ? [{ ...entry, ticket: entry.ticket }] : []);
	return { ...entry, workers, live: Boolean(entry.running && entry.pid && isAlive(entry.pid)) };
}

function byUpdated(a, b) {
	return new Date(a.updatedAt ?? 0) - new Date(b.updatedAt ?? 0);
}

function sumSummary(runners) {
	const total = { resolved: 0, needsInfo: 0, reopened: 0 };
	for (const r of runners) {
		total.resolved += r.summary?.resolved ?? 0;
		total.needsInfo += r.summary?.needsInfo ?? 0;
		total.reopened += r.summary?.reopened ?? 0;
	}
	return total;
}

async function writeAtomic(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(tmp, content);
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
}
