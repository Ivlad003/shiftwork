import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Open the shared cooldown state at `.pi/shiftwork-state.json`.
 * Cooldowns are records of providers that hit a provider limit and must be
 * skipped by every runner until `until`.
 */
export function openCooldowns(root) {
	const path = join(root, ".pi", "shiftwork-state.json");

	async function read() {
		try {
			return JSON.parse(await readFile(path, "utf8"));
		} catch {
			return { cooldowns: [] };
		}
	}

	return {
		path,

		/** Cooldowns whose `until` timestamp is still in the future. */
		async active(now = new Date()) {
			const state = await read();
			return (state.cooldowns ?? []).filter((c) => new Date(c.until) > now);
		},

		/** Add or refresh a cooldown and write the state file atomically. */
		async add(provider, until, kind = "limit") {
			const state = await read();
			const cooldowns = (state.cooldowns ?? []).filter((c) => c.provider !== provider);
			cooldowns.push({ provider, until: until instanceof Date ? until.toISOString() : until, kind });
			state.cooldowns = cooldowns;
			await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
		},
	};
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
