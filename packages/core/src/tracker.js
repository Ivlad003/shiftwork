import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAIMED, frontier, loadTickets, READY } from "./index.js";

/** Open the tracker of the repo at `root` (tickets under `.scratch/<feature>/issues/`). */
export function openTracker(root) {
	const claimsDir = join(root, ".scratch", ".claims");
	const claimPath = (t) => join(claimsDir, `${t.feature}--${t.number}.lock`);

	async function liveClaim(t) {
		const owner = await readOwner(claimPath(t));
		return owner && isAlive(owner.pid) ? owner : null;
	}

	return {
		list: () => loadTickets(root),

		/** Ready tickets with resolved blockers, plus claimed tickets whose runner is gone. */
		async frontier() {
			const tickets = await loadTickets(root);
			const orphaned = [];
			for (const t of tickets) {
				if (t.status === CLAIMED && !(await liveClaim(t))) orphaned.push(t);
			}
			const reopened = tickets.map((t) => (orphaned.includes(t) ? { ...t, status: READY } : t));
			const ready = new Set(frontier(reopened).map((t) => t.path));
			return tickets.filter((t) => ready.has(t.path));
		},

		/** Take an exclusive claim on `ticket`; null when a live process already holds it. */
		async claim(t, { pid = process.pid } = {}) {
			await mkdir(claimsDir, { recursive: true });
			const path = claimPath(t);
			const owner = { pid, token: randomUUID(), at: new Date().toISOString() };
			if (!(await createExclusive(path, owner))) {
				if (await liveClaim(t)) return null;
				await unlink(path).catch(() => {});
				if (!(await createExclusive(path, owner))) return null;
			}
			await setStatusLine(t.path, CLAIMED);
			return { ticket: t, path, ...owner };
		},

		async release(claim) {
			const owner = await readOwner(claim.path);
			if (owner?.token === claim.token) await unlink(claim.path).catch(() => {});
		},

		setStatus: (ticketOrClaim, status) => setStatusLine(pathOf(ticketOrClaim), status),

		async appendComment(ticketOrClaim, markdown) {
			const path = pathOf(ticketOrClaim);
			const text = await readFile(path, "utf8");
			const base = text.endsWith("\n") ? text : `${text}\n`;
			const section = /^## Comments\s*$/m.test(base) ? "" : "\n## Comments\n";
			await writeAtomic(path, `${base}${section}\n${markdown.trim()}\n`);
		},
	};
}

function pathOf(ticketOrClaim) {
	return ticketOrClaim.ticket?.path ?? ticketOrClaim.path;
}

async function setStatusLine(path, status) {
	const text = await readFile(path, "utf8");
	const line = /^(\s*(?:\*\*)?Status:(?:\*\*)?[ \t]*)([^\r\n]*?)([ \t]*)$/im;
	let next;
	if (line.test(text)) {
		next = text.replace(line, (_all, prefix, _old, trailing) => `${prefix}${status}${trailing}`);
	} else {
		next = text.replace(/^(#[^\n]*\n)/, `$1\n**Status:** ${status}\n`);
		if (next === text) next = `**Status:** ${status}\n\n${text}`;
	}
	await writeAtomic(path, next);
}

async function writeAtomic(path, content) {
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(tmp, content);
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
}

async function createExclusive(path, owner) {
	try {
		const handle = await open(path, "wx");
		await handle.writeFile(JSON.stringify(owner));
		await handle.close();
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return false;
		throw error;
	}
}

async function readOwner(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
