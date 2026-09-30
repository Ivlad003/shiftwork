import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Open the runner state at `.pi/shiftwork-run.json`: what the runner is doing right
 * now (ticket, attempt, shift, model, budget use) and how the run ended.
 * A runner writes it; `shiftwork status` and the pi status widget read it.
 */
export function openRunState(root) {
	const path = join(root, ".pi", "shiftwork-run.json");
	// Writes are chained so a reader never sees two updates crossing each other.
	let queue = Promise.resolve();

	async function read() {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			return null;
		}
	}

	return {
		path,

		/** The last state written, with `live` telling whether the runner process is still there. */
		async read() {
			const state = await read();
			if (!state) return null;
			return { ...state, live: Boolean(state.running && state.pid && isAlive(state.pid)) };
		},

		/** Merge `patch` into the state and write it atomically. Never rejects: a run outlives its bookkeeping. */
		update(patch) {
			queue = queue.then(async () => {
				const state = (await read()) ?? {};
				const next = { ...state, ...patch, updatedAt: new Date().toISOString() };
				await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
			});
			return queue.catch(() => {});
		},

		/** Forget the run entirely. */
		clear() {
			queue = queue.then(() => unlink(path).catch(() => {}));
			return queue.catch(() => {});
		},
	};
}

/** A run state that keeps nothing, for runs without a root on disk. */
export function noRunState() {
	return { path: undefined, read: async () => null, update: async () => {}, clear: async () => {} };
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
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
