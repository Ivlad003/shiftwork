import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { shiftworkPath } from "./paths.js";

/** How long a waiter polls a live lock before taking it over anyway. */
const LOCK_TIMEOUT_MS = 60_000;
/** How often a waiter re-checks the lock file. */
const LOCK_STEP_MS = 20;

/** The shared-state lock path: `.shiftwork/shiftwork.lock`, or `.shiftwork/shiftwork-<name>.lock` for a named lock (legacy `.pi/`, see paths.js). */
export function lockPath(root, name) {
	return shiftworkPath(root, name ? `shiftwork-${name}.lock` : "shiftwork.lock");
}

/**
 * Run `fn` while holding the repo's shared-state lock, so parallel shifts in one
 * process and a second `shiftwork run` in the same repo never interleave a
 * read-modify-write of the shared state (cooldowns, run-state, the spec tickets table).
 * The lock is an O_EXCL file holding pid + token; one left by a dead pid is stale
 * and taken over at once (like ticket claims), a live one is waited for.
 * `name` takes a separate lock file for a longer section (landing) that must not hold up the
 * shared state; `timeoutMs: Infinity` waits for a live holder however long it takes.
 */
export async function withLock(root, fn, { pid = process.pid, timeoutMs = LOCK_TIMEOUT_MS, stepMs = LOCK_STEP_MS, name } = {}) {
	const path = lockPath(root, name);
	await mkdir(dirname(path), { recursive: true });
	const owner = { pid, token: randomUUID(), at: new Date().toISOString() };
	await acquire(path, owner, timeoutMs, stepMs);
	try {
		return await fn();
	} finally {
		await release(path, owner);
	}
}

async function acquire(path, owner, timeoutMs, stepMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await createExclusive(path, owner)) return;
		const held = await readLock(path);
		if (held.missing) continue; // released meanwhile: try again at once
		// An unreadable file is a lock whose owner is still being written (createExclusive opens
		// before it writes): it is held. Stale only when the holder's pid is gone; past the timeout
		// it is taken over too (every guarded write is atomic, so the worst case is one racing update).
		const stale = held.owner ? !isAlive(held.owner.pid) || Date.now() >= deadline : Date.now() >= deadline;
		if (stale) {
			// Take over only the lock we judged: another waiter may already have replaced it.
			const again = await readLock(path);
			if (again.missing || again.owner?.token === held.owner?.token) await unlink(path).catch(() => {});
			continue;
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

/** The lock file's state: `{ missing: true }`, `{ owner }`, or `{ owner: null }` while it is being written. */
async function readLock(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return { missing: true };
		return { owner: null };
	}
	try {
		return { owner: JSON.parse(text) };
	} catch {
		return { owner: null };
	}
}

async function release(path, owner) {
	// Only the holder's own token removes the lock: a taken-over lock is left for its new owner.
	const held = await readOwner(path);
	if (held?.token === owner.token) await unlink(path).catch(() => {});
}

/**
 * Take the claim file at `path` for `owner`: create it, or take over one whose owner is
 * gone. The takeover runs under the shared-state lock and removes only the stale claim it
 * judged (its token re-read right before the unlink), so a claim another process created
 * meanwhile is never deleted. False when a live process holds the claim.
 */
export async function takeClaim(root, path, owner) {
	if (await createExclusive(path, owner)) return true;
	return withLock(root, async () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (await createExclusive(path, owner)) return true;
			const held = await readOwner(path);
			if (held && isAlive(held.pid)) return false;
			// Dead owner, or a file that isn't a claim at all: remove it, but only if unchanged.
			const again = await readOwner(path);
			if (again?.token !== held?.token) continue;
			await unlink(path).catch(() => {});
		}
		return createExclusive(path, owner);
	});
}

/**
 * Create `path` holding `owner`, or return false when it exists. The owner is written to a
 * temp file first and hard-linked into place, so the file never appears empty: a reader
 * (a waiter judging staleness, a claim check) always sees a complete owner.
 */
export async function createExclusive(path, owner) {
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(tmp, JSON.stringify(owner));
	try {
		await link(tmp, path);
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	} finally {
		await unlink(tmp).catch(() => {});
	}
}

export async function readOwner(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

export function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
