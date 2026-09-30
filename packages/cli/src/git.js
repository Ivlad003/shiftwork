import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TRACKER = ":(exclude).scratch";

/**
 * One git worktree per ticket, on branch `shiftwork/<feature>-<NN>`, created from the target branch.
 * Options: { root, target? (default: the branch checked out in root), setup?: string[], dir? }
 * Worktrees live outside the repo (default ~/.cache/shiftwork/worktrees/<repo>-<hash>/), so tools that
 * walk up from the worktree never find the main checkout.
 */
export function createGitWorkspace({ root, target, setup = [], dir } = {}) {
	const git = async (cwd, ...args) => (await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
	const base =
		dir ??
		join(
			process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
			"shiftwork",
			"worktrees",
			`${basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`,
		);
	const branchOf = (t) => `shiftwork/${t.feature}-${t.number}`;
	const pathOf = (t) => join(base, `${t.feature}-${t.number}`);
	let targetBranch = target;
	const resolveTarget = async () => (targetBranch ??= await git(root, "rev-parse", "--abbrev-ref", "HEAD"));

	async function branchExists(branch) {
		return (await git(root, "branch", "--list", branch)) !== "";
	}

	/** Paths that setup commands created: kept out of every commit (recorded in the worktree's git dir). */
	async function setupPathsFile(cwd) {
		return join(await git(cwd, "rev-parse", "--absolute-git-dir"), "shiftwork-setup-paths");
	}

	/** Changed and untracked paths. Uses -z output: `trim()`ing porcelain text would eat the first entry's leading status column. */
	async function changedPaths(cwd) {
		const { stdout } = await run("git", ["status", "--porcelain", "-z", "--untracked-files=normal"], { cwd, maxBuffer: 16 * 1024 * 1024 });
		return stdout
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.slice(3).replace(/\/$/, ""));
	}

	/** Commit everything in the worktree except the tracker copy and setup output; returns whether a commit was made. */
	async function commitAll(t, message) {
		const cwd = pathOf(t);
		const setupPaths = await readFile(await setupPathsFile(cwd), "utf8").then(
			(text) => text.split("\n").filter(Boolean),
			() => [],
		);
		await git(cwd, "add", "-A", "--", ".", TRACKER, ...setupPaths.map((p) => `:(exclude,literal)${p}`));
		if ((await git(cwd, "diff", "--cached", "--name-only")) === "") return false;
		await git(cwd, "commit", "-q", "--no-verify", "-m", message);
		return true;
	}

	async function remove(t) {
		await git(root, "worktree", "remove", "--force", pathOf(t)).catch(() => {});
		await git(root, "worktree", "prune");
		await git(root, "branch", "-D", branchOf(t)).catch(() => {});
	}

	/** Whether the ticket's branch already contains the target, so the merge would fast-forward. */
	async function containsTarget(t, into) {
		return git(pathOf(t), "merge-base", "--is-ancestor", into, "HEAD")
			.then(() => true)
			.catch(() => false);
	}

	/** Rebase the ticket's branch onto the target in its worktree. On a conflict the rebase is
	 * aborted and nothing changes; `commit` is the target's short sha, what landed first. */
	async function rebaseOnto(t, into) {
		const cwd = pathOf(t);
		const commit = await git(root, "rev-parse", "--short", into);
		try {
			await git(cwd, "rebase", into);
			return { ok: true, conflict: false, files: [], commit };
		} catch (error) {
			const files = (await git(cwd, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
			await git(cwd, "rebase", "--abort").catch(() => {});
			return { ok: false, conflict: files.length > 0, files, commit, error: error.message };
		}
	}

	return {
		async prepare(t) {
			const cwd = pathOf(t);
			const branch = branchOf(t);
			if (existsSync(join(cwd, ".git"))) return { cwd, branch, reused: true };
			await mkdir(dirname(cwd), { recursive: true });
			await git(root, "worktree", "prune");
			if (await branchExists(branch)) await git(root, "worktree", "add", "-q", cwd, branch);
			else await git(root, "worktree", "add", "-q", "-b", branch, cwd, await resolveTarget());
			for (const command of setup) await run("sh", ["-c", command], { cwd, maxBuffer: 16 * 1024 * 1024 });
			if (setup.length) await writeFile(await setupPathsFile(cwd), (await changedPaths(cwd)).join("\n"));
			return { cwd, branch, reused: false };
		},

		/** Commit the ticket's work and merge it into the target. A target moved by a parallel landing
		 * rebases the branch onto it in its worktree (`rebase`: re-verify there and land again); a
		 * conflicting rebase changes nothing and keeps the branch (`conflict`: redo the work on top). */
		async land(t) {
			const branch = branchOf(t);
			const into = await resolveTarget();
			await commitAll(t, `shiftwork: ${t.feature}/${t.number} ${t.title ?? ""}`.trim());
			const current = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
			if (current !== into) {
				return { ok: false, message: `main checkout is on "${current}", not the target "${into}"; branch ${branch} kept` };
			}
			// A parallel landing moved the target: rebase the branch onto it in its worktree, so the
			// caller can re-run the ticket's Verify gate on the integrated state before it lands.
			if (!(await containsTarget(t, into))) {
				const rebased = await rebaseOnto(t, into);
				if (rebased.ok) {
					return {
						ok: false,
						rebase: rebased.commit,
						message: `the target moved to ${rebased.commit}: branch ${branch} rebased onto it; re-verify and land again`,
					};
				}
				if (rebased.conflict) {
					return {
						ok: false,
						conflict: { files: rebased.files, commit: rebased.commit },
						message: `merge conflict in ${rebased.files.join(", ")} with the landed ${rebased.commit}; branch ${branch} kept`,
					};
				}
				// The rebase could not run at all: fall through to a plain merge, as before.
			}
			try {
				await git(root, "merge", "-q", "--ff-only", branch);
			} catch {
				try {
					await git(root, "merge", "-q", "--no-ff", "--no-edit", "-m", `shiftwork: merge ${t.feature}/${t.number} ${t.title ?? ""}`.trim(), branch);
				} catch (error) {
					const conflicts = await git(root, "diff", "--name-only", "--diff-filter=U").catch(() => "");
					const files = conflicts.split("\n").filter(Boolean);
					await git(root, "merge", "--abort").catch(() => {});
					return {
						ok: false,
						// Conflict files mean a landing conflict with what landed first: the ticket is
						// redone on top of it; anything else is a plain landing failure.
						...(files.length ? { conflict: { files, commit: await git(root, "rev-parse", "--short", into) } } : {}),
						message: `merge conflict in ${files.join(", ") || "the target"}; branch ${branch} kept (${error.message.split("\n")[0]})`,
					};
				}
			}
			await remove(t);
			return { ok: true, message: `merged ${branch} into ${into}` };
		},

		/** Drop the ticket's worktree and branch, so the next prepare starts fresh from the target
		 * (fix-forward after a landing conflict). */
		async redo(t) {
			await remove(t);
		},

		/** Keep the ticket's branch for inspection, with any unfinished work committed as WIP. */
		async keep(t) {
			if (existsSync(pathOf(t))) await commitAll(t, `shiftwork: WIP ${t.feature}/${t.number} ${t.title ?? ""}`.trim());
			return { branch: branchOf(t) };
		},

		/** Whether the ticket's branch differs from the target: commits ahead or uncommitted work (tracker and setup output excluded). */
		async hasChanges(t) {
			const cwd = pathOf(t);
			if (!existsSync(cwd)) return false;
			const ahead = Number(await git(cwd, "rev-list", "--count", `${await resolveTarget()}..HEAD`));
			if (ahead > 0) return true;
			const setupPaths = await readFile(await setupPathsFile(cwd), "utf8").then(
				(text) => new Set(text.split("\n").filter(Boolean)),
				() => new Set(),
			);
			return (await changedPaths(cwd)).some((p) => !p.startsWith(".scratch/") && !setupPaths.has(p));
		},

		/** What changed in the ticket's worktree since its last commit, including untracked files. */
		async diffStat(t) {
			const cwd = pathOf(t);
			const status = await git(cwd, "status", "--porcelain", "--", ".", TRACKER);
			const stat = await git(cwd, "diff", "--stat", "HEAD", "--", ".", TRACKER);
			return [status, stat].filter(Boolean).join("\n");
		},
	};
}
