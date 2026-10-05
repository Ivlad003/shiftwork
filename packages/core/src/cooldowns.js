import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withLock } from "./lock.js";
import { shiftworkPath } from "./paths.js";

/**
 * Open the shared cooldown state at `.shiftwork/shiftwork-state.json` (legacy `.pi/`).
 * Cooldowns are records of providers that hit a provider limit and must be
 * skipped by every runner until `until`.
 */
export function openCooldowns(root) {
	const path = shiftworkPath(root, "shiftwork-state.json");

	async function read() {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			return { cooldowns: [] };
		}
	}

	async function update(change) {
		// Read-modify-write under the shared-state lock: parallel shifts in this
		// process and a second runner never lose each other's cooldowns.
		await withLock(root, async () => {
			const state = await read();
			state.cooldowns = change(state.cooldowns ?? []);
			await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
		});
	}

	return {
		path,

		/** Cooldowns whose `until` timestamp is still in the future. */
		async active(now = new Date()) {
			const state = await read();
			return (state.cooldowns ?? []).filter((c) => new Date(c.until) > now);
		},

		/**
		 * Add or refresh a cooldown and write the state file atomically.
		 * `exact` marks an end time the provider gave us; guessed ones may be probed early.
		 */
		async add(provider, until, kind = "limit", { at = new Date(), exact = false } = {}) {
			await update((cooldowns) => [
				...cooldowns.filter((c) => c.provider !== provider),
				{ provider, until: iso(until), kind, at: iso(at), exact },
			]);
		},

		/** End a cooldown early (a probe found the provider answering again). */
		async remove(provider) {
			await update((cooldowns) => cooldowns.filter((c) => c.provider !== provider));
		},

		/** Remember when a guessed cooldown was last probed. */
		async markProbed(provider, at = new Date()) {
			await update((cooldowns) => cooldowns.map((c) => (c.provider === provider ? { ...c, probedAt: iso(at) } : c)));
		},
	};
}

function iso(value) {
	return value instanceof Date ? value.toISOString() : value;
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
