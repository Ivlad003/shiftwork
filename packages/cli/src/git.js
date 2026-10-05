import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { withLock } from "shiftwork-core";

import { execIn } from "./exec.js";

const TRACKER = ":(exclude).scratch";

/**
 * One git worktree per ticket, on branch `shiftwork/<feature>-<NN>`, created from the target branch.
 * Options: { root, target? (default: the branch checked out in root), setup?: string[], dir? }
 * Worktrees live outside the repo (default ~/.cache/shiftwork/worktrees/<repo>-<hash>/), so tools that
 * walk up from the worktree never find the main checkout.
 */
export function createGitWorkspace({ root, target, setup = [], dir } = {}) {
	const git = async (cwd, ...args) => (await execIn(cwd)(["git", ...args])).trim();
	const base =
		dir ??
		join(
			process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
			"shiftwork",
			"worktrees",
			`${basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`,
		);
	// A dual-shift candidate (`t.suffix`, "a" or "b") gets its own branch and worktree beside the ticket's.
	const idOf = (t) => `${t.feature}-${t.number}${t.suffix ? `-${t.suffix}` : ""}`;
	const branchOf = (t) => `shiftwork/${idOf(t)}`;
	const pathOf = (t) => join(base, idOf(t));
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
		const stdout = await execIn(cwd)(["git", "status", "--porcelain", "-z", "--untracked-files=normal"]);
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

	/** After an accepted before-land review, discard what the review round left in the worktree
	 * (reviewer edits, verify strays): modified tracked files restored (`git checkout -- .`) and
	 * untracked files removed (`git clean -fd`, no `-x`, so ignored files stay) — the tracker copy
	 * and setup output untouched. Returns the discarded paths, for the landing notes: empty when
	 * the review left nothing, so the landing commits only the work the review saw. */
	async function discardAfterReview(t) {
		const cwd = pathOf(t);
		const setupPaths = await readFile(await setupPathsFile(cwd), "utf8").then(
			(text) => text.split("\n").filter(Boolean),
			() => [],
		);
		const discarded = (await changedPaths(cwd)).filter((p) => !p.startsWith(".scratch/") && !setupPaths.includes(p));
		if (discarded.length === 0) return [];
		const excluded = [TRACKER, ...setupPaths.map((p) => `:(exclude,literal)${p}`)];
		await git(cwd, "checkout", "--", ".", ...excluded);
		await git(cwd, "clean", "-fd", "--", ".", ...excluded);
		return discarded;
	}

	/** The commit message of a ticket's work: `git log --grep "shiftwork: <feature>/<NN>"` finds it. */
	function landMessage(t) {
		return `shiftwork: ${t.feature}/${t.number}${t.suffix ? `-${t.suffix}` : ""} ${t.title ?? ""}`.trim();
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

	/** Rebase the ticket's branch onto the target in its worktree. Uncommitted leftovers (the tracker
	 * copy, setup output) are autostashed, so a dirty worktree doesn't refuse the rebase. On a
	 * conflict the rebase is aborted and nothing changes; a rebase that refuses to run for any other
	 * reason is `ok: false` without `conflict`. `commit` is the target's short sha, what landed first. */
	async function rebaseOnto(t, into) {
		const cwd = pathOf(t);
		const commit = await git(root, "rev-parse", "--short", into);
		try {
			await git(cwd, "rebase", "--autostash", into);
		} catch (error) {
			const files = (await git(cwd, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
			await git(cwd, "rebase", "--abort").catch(() => {});
			return { ok: false, conflict: files.length > 0, files, commit, error: error.message };
		}
		// The rebase went through but re-applying the autostash conflicted (the tracker copy edited
		// on both sides): take the rebased version, so the worktree has no unmerged paths left. Git
		// kept those leftovers in the stash, which the main checkout shares; they are the worktree's
		// tracker copy and setup output (the root tracker is the real one), so the entry is dropped
		// — only when the newest entry is git's autostash, never an operator's stash.
		const unmerged = (await git(cwd, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
		if (unmerged.length) {
			await git(cwd, "reset", "-q", "--", ...unmerged);
			await git(cwd, "checkout", "HEAD", "--", ...unmerged);
			const newest = await git(cwd, "stash", "list", "-1", "--format=%gs").catch(() => "");
			if (/^autostash\b/i.test(newest)) await git(cwd, "stash", "drop", "-q").catch(() => {});
		}
		return { ok: true, conflict: false, files: [], commit };
	}

	/** Commit the ticket's work and merge it into the target (see `land` below). Runs under the
	 * repo's cross-process landing lock: the in-process landing queue doesn't stop a second runner. */
	async function landLocked(t) {
		const branch = branchOf(t);
		const into = await resolveTarget();
		await commitAll(t, landMessage(t));
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
			// The rebase refused to run: a merge now would land a state the gate never saw.
			return {
				ok: false,
				message: `could not rebase onto the moved target ${rebased.commit} (${rebased.error.split("\n")[0]}); branch ${branch} kept`,
			};
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
	}

	return {
		/** The ticket's worktree on its branch, created from the target — or from `from` (a branch:
		 * a dual-shift candidate's, for the merge shift) when the branch is new. A ticket with a
		 * `suffix` is a dual-shift candidate: `shiftwork/<feature>-<NN>-<suffix>` in its own worktree. */
		async prepare(t, { from } = {}) {
			const cwd = pathOf(t);
			const branch = branchOf(t);
			if (existsSync(join(cwd, ".git"))) return { cwd, branch, reused: true };
			await mkdir(dirname(cwd), { recursive: true });
			await git(root, "worktree", "prune");
			if (await branchExists(branch)) await git(root, "worktree", "add", "-q", cwd, branch);
			else await git(root, "worktree", "add", "-q", "-b", branch, cwd, from ?? (await resolveTarget()));
			for (const command of setup) await execIn(cwd)(["sh", "-c", command]);
			if (setup.length) await writeFile(await setupPathsFile(cwd), (await changedPaths(cwd)).join("\n"));
			return { cwd, branch, reused: false };
		},

		/** Commit the ticket's work and merge it into the target. A target moved by a parallel landing
		 * rebases the branch onto it in its worktree (`rebase`: re-verify there and land again); a
		 * conflicting rebase changes nothing and keeps the branch (`conflict`: redo the work on top);
		 * a rebase that refuses to run fails the landing, the branch kept: never a merge unverified. */
		async land(t) {
			// Its own lock file: a landing never holds up the shared state (cooldowns, run state), and
			// a live landing is waited for however long its hooks take (a dead one is taken over).
			return withLock(root, () => landLocked(t), { name: "land", timeoutMs: Infinity });
		},

		/** Commit the ticket's work on its branch with the landing's own message (tracker and setup
		 * output excluded), so a before-land review's `git diff <target>...HEAD` shows it; `land`
		 * then has nothing left to commit and merges this commit. Returns whether a commit was made. */
		async commit(t) {
			return commitAll(t, landMessage(t));
		},

		/** After an accepted before-land review: drop what that round left in the worktree, so
		 * `land` merges exactly the committed work the review saw. Returns the discarded paths. */
		async discardAfterReview(t) {
			return discardAfterReview(t);
		},

		/** The branch tickets land into: a before-land review's branch diff points at it. */
		async target() {
			return resolveTarget();
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

		/** The paths the ticket's branch changed against the target (`git diff <target>...HEAD`),
		 * plus uncommitted and untracked ones — the tracker copy and setup output excluded, as in
		 * `hasChanges`. Empty when the ticket has no worktree. Frozen paths are checked against it. */
		async changedFiles(t) {
			const cwd = pathOf(t);
			if (!existsSync(cwd)) return [];
			const lines = async (...args) => (await git(cwd, ...args)).split("\n").filter(Boolean);
			const setupPaths = await readFile(await setupPathsFile(cwd), "utf8").then(
				(text) => new Set(text.split("\n").filter(Boolean)),
				() => new Set(),
			);
			const files = new Set([
				...(await lines("diff", "--name-only", `${await resolveTarget()}...HEAD`)),
				...(await lines("diff", "--name-only", "HEAD")),
				...(await lines("ls-files", "--others", "--exclude-standard")),
			]);
			return [...files].filter((p) => !p.startsWith(".scratch/") && !setupPaths.has(p));
		},

		/** The ticket's (or a dual candidate's) branch against the target: its name, the target, and
		 * `git diff --stat <target>...<branch>` of its committed work. */
		async diff(t) {
			const into = await resolveTarget();
			const branch = branchOf(t);
			return { branch, target: into, stat: await git(root, "diff", "--stat", `${into}...${branch}`) };
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
