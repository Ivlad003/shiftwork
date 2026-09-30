import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a temp repo root with the given tickets: { "feature/01-slug.md": "markdown" }. */
export async function makeRepo(tickets) {
	const root = await mkdtemp(join(tmpdir(), "shiftwork-test-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		const dir = join(root, ".scratch", feature, "issues");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, file), body);
	}
	return root;
}

export function ticket(number, title, { status = "ready-for-agent", blockedBy = "None (can start immediately)", extra = "" } = {}) {
	return `# ${number}: ${title}\n\n**What to build:** something.\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n${extra}\n- [ ] It works\n`;
}

/**
 * Create a temp repo root with an OpenSpec layout: { "change": { tasks, proposal?, state? } }
 * writes openspec/changes/<change>/tasks.md (+ optional proposal.md and .shiftwork.md).
 */
export async function makeOpenSpecRepo(changes) {
	const root = await mkdtemp(join(tmpdir(), "shiftwork-opspec-"));
	for (const [change, spec] of Object.entries(changes)) {
		const dir = join(root, "openspec", "changes", change);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "tasks.md"), spec.tasks);
		if (spec.proposal) await writeFile(join(dir, "proposal.md"), spec.proposal);
		if (spec.state) await writeFile(join(dir, ".shiftwork.md"), spec.state);
	}
	return root;
}
