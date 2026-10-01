import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CLAIMED, frontier, loadTickets, orderFrontier, READY } from "./index.js";
import { createExclusive, isAlive, readOwner, withLock } from "./lock.js";

const TABLE_START = "<!-- shiftwork:tickets:start -->";
const TABLE_END = "<!-- shiftwork:tickets:end -->";

/** Markdown table of tickets: NN · title · status · last route. */
export function formatTicketsTable(tickets) {
	const header = "| NN | title | status | last route |";
	const sep = "| -- | ----- | ------ | ---------- |";
	const rows = [...tickets]
		.sort((a, b) => Number(a.number) - Number(b.number) || String(a.title ?? "").localeCompare(String(b.title ?? "")))
		.map((t) => `| ${t.number ?? ""} | ${cell(t.title)} | ${cell(t.status)} | ${cell(t.lastRoute)} |`);
	return [header, sep, ...rows].join("\n");
}

function cell(value) {
	return String(value ?? "").replaceAll("|", "\\|");
}

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
			// Orphaned claims included: they are reopened above and matched by path here.
			return orderFrontier(tickets.filter((t) => ready.has(t.path)), tickets, { current: null });
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
			await syncSpecTable(root, t.feature);
			return { ticket: t, path, ...owner };
		},

		async release(claim) {
			const owner = await readOwner(claim.path);
			if (owner?.token === claim.token) await unlink(claim.path).catch(() => {});
		},

		/** Live claims with their owner pid and timestamp. */
		async activeClaims() {
			const tickets = await loadTickets(root);
			const live = [];
			for (const t of tickets) {
				const owner = await readOwner(claimPath(t));
				if (owner && isAlive(owner.pid)) live.push({ ticket: t, ...owner });
			}
			return live;
		},

		async setStatus(ticketOrClaim, status) {
			const path = pathOf(ticketOrClaim);
			await setStatusLine(path, status);
			await syncSpecTable(root, featureOf(ticketOrClaim, path));
		},

		async appendComment(ticketOrClaim, markdown) {
			const path = pathOf(ticketOrClaim);
			const text = await readFile(path, "utf8");
			const base = text.endsWith("\n") ? text : `${text}\n`;
			const section = /^## Comments\s*$/m.test(base) ? "" : "\n## Comments\n";
			await writeAtomic(path, `${base}${section}\n${markdown.trim()}\n`);
		},

		/** Append a new ticket to a feature: the next free number, ready and blocked by nothing. */
		async createTicket(feature, { title, what, type, verify = [], status = READY } = {}) {
			const tickets = (await loadTickets(root)).filter((t) => t.feature === feature);
			const next = String(Math.max(0, ...tickets.map((t) => Number(t.number) || 0)) + 1).padStart(2, "0");
			const slug =
				String(title ?? "ticket")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 48) || "ticket";
			const path = join(root, ".scratch", feature, "issues", `${next}-${slug}.md`);
			const lines = [
				`# ${next}: ${title}`,
				"",
				`**What to build:** ${what}`,
				"",
				"**Blocked by:** None (can start immediately)",
				"",
				`**Status:** ${status}`,
			];
			if (type) lines.push(`**Type:** ${type}`);
			if (verify.length) lines.push(`**Verify:** ${verify.map((c) => `\`${c}\``).join(" · ")}`);
			lines.push("", "- [ ] It works", "");
			await writeAtomic(path, lines.join("\n"));
			await syncSpecTable(root, feature);
			return { feature, number: next, title, path };
		},
	};
}

function pathOf(ticketOrClaim) {
	return ticketOrClaim.ticket?.path ?? ticketOrClaim.path;
}

function featureOf(ticketOrClaim, path) {
	return ticketOrClaim.ticket?.feature ?? ticketOrClaim.feature ?? basename(dirname(dirname(path)));
}

async function syncSpecTable(root, feature) {
	if (!feature) return;
	// The spec table is shared state: it is recomputed under the shared-state lock
	// so parallel shifts and a second runner never lose a status change.
	await withLock(root, async () => {
		const specPath = join(root, ".scratch", feature, "spec.md");
		let spec;
		try {
			spec = await readFile(specPath, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const tickets = (await loadTickets(root)).filter((t) => t.feature === feature);
		const next = applyTicketsTable(spec, formatTicketsTable(tickets));
		if (next !== spec) await writeAtomic(specPath, next);
	});
}

function applyTicketsTable(spec, table) {
	// Markers count only on a line of their own, so prose that mentions them is never touched.
	const block = /^<!-- shiftwork:tickets:start -->[ \t]*$[\s\S]*?^<!-- shiftwork:tickets:end -->[ \t]*$/m;
	if (block.test(spec)) return spec.replace(block, () => `${TABLE_START}\n${table}\n${TABLE_END}`);
	const prefix = spec.endsWith("\n") ? spec : `${spec}\n`;
	return `${prefix}\n${TABLE_START}\n${table}\n${TABLE_END}\n`;
}

/** The file with only its Status line set to `status`: the line when there is one, else one
 * under the `#` title, else at the very top. Every other byte is kept. */
export function applyStatusLine(text, status) {
	const line = /^(\s*(?:\*\*)?Status:(?:\*\*)?[ \t]*)([^\r\n]*?)([ \t]*)$/im;
	if (line.test(text)) {
		return text.replace(line, (_all, prefix, _old, trailing) => `${prefix}${status}${trailing}`);
	}
	const titled = text.replace(/^(#[^\n]*\n)/, `$1\n**Status:** ${status}\n`);
	return titled !== text ? titled : `**Status:** ${status}\n\n${text}`;
}

async function setStatusLine(path, status) {
	await writeAtomic(path, applyStatusLine(await readFile(path, "utf8"), status));
}

/** Set a feature spec's Status line (feature pause/resume): only that line changes, and
 * the write goes through the shared-state lock like other tracker writes. A spec that
 * doesn't exist yet gets one holding nothing but the line. */
export async function setSpecStatus(root, feature, status) {
	await withLock(root, async () => {
		const specPath = join(root, ".scratch", feature, "spec.md");
		let spec;
		try {
			spec = await readFile(specPath, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			spec = "";
		}
		await writeAtomic(specPath, applyStatusLine(spec, status));
	});
}

export async function writeAtomic(path, content) {
	const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(tmp, content);
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
}
