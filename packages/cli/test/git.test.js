import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLock } from "shiftwork-core";
import { createGitWorkspace } from "../src/git.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repo() {
	const root = await mkdtemp(join(tmpdir(), "sw-git-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	await mkdir(join(root, ".scratch", "f", "issues"), { recursive: true });
	await writeFile(join(root, ".scratch", "f", "issues", "01-a.md"), "# 01: A\n\n**Status:** ready-for-agent\n");
	await writeFile(join(root, "README.md"), "hello\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init");
	return root;
}

const ticket = (root) => ({ feature: "f", number: "01", title: "A", path: join(root, ".scratch", "f", "issues", "01-a.md") });

test("prepare creates a worktree on shiftwork/<feature>-<NN> from the target branch", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });

	const { cwd } = await ws.prepare(ticket(root));

	assert.equal(git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), "shiftwork/f-01");
	assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "hello\n");
	assert.notEqual(cwd, root);
});

test("land commits the worktree's work, merges it into the target and removes the worktree", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");

	const result = await ws.land(t);

	assert.equal(result.ok, true);
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "done\n");
	assert.match(git(root, "log", "-1", "--format=%s"), /shiftwork: f\/01 A/);
	assert.equal(existsSync(cwd), false);
	assert.equal(git(root, "branch", "--list", "shiftwork/f-01"), "");
});

test("the worktree's copy of the tracker is never landed over the main checkout's tickets", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "# 01: A\n\n**Status:** hacked\n");
	await writeFile(join(cwd, "feature.txt"), "done\n");
	await writeFile(t.path, "# 01: A\n\n**Status:** claimed\n");

	assert.equal((await ws.land(t)).ok, true);

	assert.equal(await readFile(t.path, "utf8"), "# 01: A\n\n**Status:** claimed\n");
});

test("a dirty main checkout doesn't block preparing or landing", async () => {
	const root = await repo();
	await writeFile(join(root, "README.md"), "local edit\n");
	await writeFile(join(root, "scratch-notes.txt"), "untracked\n");
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");

	assert.equal((await ws.land(t)).ok, true);
	assert.equal(await readFile(join(root, "README.md"), "utf8"), "local edit\n");
	assert.ok(existsSync(join(root, "feature.txt")));
});

test("a diverged target rebases the branch onto it; landing again fast-forwards", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	await writeFile(join(root, "other.txt"), "meanwhile\n");
	git(root, "add", "other.txt");
	git(root, "commit", "-q", "-m", "meanwhile");

	const moved = await ws.land(t);

	assert.equal(moved.ok, false);
	assert.match(moved.rebase, /^[0-9a-f]{7,}$/);
	assert.match(moved.message, /rebased onto it/);
	assert.equal((await ws.land(t)).ok, true);
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "done\n");
	assert.equal(git(root, "log", "-1", "--format=%p").split(" ").length, 1, "no merge commit: the landing fast-forwards");
});

test("a target moved by a parallel landing rebases the branch; landing again fast-forwards", async () => {
	const root = await repo();
	await writeFile(join(root, "shared.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
	git(root, "add", "shared.txt");
	git(root, "commit", "-q", "-m", "shared");
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t1 = ticket(root);
	const t2 = { ...ticket(root), number: "02", title: "B", path: join(root, ".scratch", "f", "issues", "02-b.md") };
	const a = await ws.prepare(t1);
	const b = await ws.prepare(t2);
	// Two worktrees from the same target, editing different lines of one file.
	await writeFile(join(a.cwd, "shared.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\n");
	await writeFile(join(b.cwd, "shared.txt"), "one\ntwo\nthree\nfour\nfive\nSIX\n");

	assert.equal((await ws.land(t1)).ok, true);
	const moved = await ws.land(t2);

	assert.equal(moved.ok, false);
	assert.match(moved.rebase, /^[0-9a-f]{7,}$/);
	// The rebased worktree holds both tickets' work: the state the gate re-runs on.
	assert.equal(await readFile(join(b.cwd, "shared.txt"), "utf8"), "ONE\ntwo\nthree\nfour\nfive\nSIX\n");

	const landed = await ws.land(t2);

	assert.equal(landed.ok, true);
	assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "ONE\ntwo\nthree\nfour\nfive\nSIX\n");
	assert.equal(existsSync(b.cwd), false);
});

test("a dirty tracker copy doesn't stop the rebase onto a moved target: the gate re-runs before landing", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	// The agent edited its copy of the tracker: never committed, so the worktree stays dirty.
	await writeFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "# 01: A\n\n**Status:** worktree\n");
	await writeFile(join(root, "other.txt"), "meanwhile\n");
	git(root, "add", "other.txt");
	git(root, "commit", "-q", "-m", "meanwhile");

	const moved = await ws.land(t);

	assert.equal(moved.ok, false);
	assert.match(moved.rebase ?? "", /^[0-9a-f]{7,}$/, `a moved target means re-verify, never a plain merge: ${moved.message}`);
	assert.equal(existsSync(join(root, "feature.txt")), false, "nothing landed unverified");
	assert.equal(await readFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "utf8"), "# 01: A\n\n**Status:** worktree\n");
	assert.equal((await ws.land(t)).ok, true);
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "done\n");
});

test("a tracker copy edited on both sides still rebases, and leaves no unmerged paths behind", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	await writeFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "# 01: A\n\n**Status:** worktree\n");
	await writeFile(t.path, "# 01: A\n\n**Status:** claimed\n");
	git(root, "commit", "-q", "-am", "tickets");

	const moved = await ws.land(t);

	assert.match(moved.rebase ?? "", /^[0-9a-f]{7,}$/, moved.message);
	assert.equal(git(cwd, "diff", "--name-only", "--diff-filter=U"), "");
	assert.equal(git(root, "stash", "list"), "", "the conflicted autostash is not left in the shared stash list");
	assert.equal((await ws.land(t)).ok, true);
	assert.equal(await readFile(t.path, "utf8"), "# 01: A\n\n**Status:** claimed\n");
});

test("a rebase that refuses to run (no conflict) fails the landing instead of merging unverified", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	// An untracked tracker file the moved target also adds: the rebase would overwrite it.
	await writeFile(join(cwd, ".scratch", "f", "issues", "02-b.md"), "worktree\n");
	await writeFile(join(root, ".scratch", "f", "issues", "02-b.md"), "target\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "new ticket");
	const head = git(root, "rev-parse", "HEAD");

	const result = await ws.land(t);

	assert.equal(result.ok, false);
	assert.equal(result.rebase, undefined);
	assert.equal(result.conflict, undefined);
	assert.match(result.message, /kept/);
	assert.equal(git(root, "rev-parse", "HEAD"), head, "the target is untouched");
	assert.equal(existsSync(join(root, "feature.txt")), false);
	assert.equal(git(root, "branch", "--list", "--format=%(refname:short)", "shiftwork/f-01"), "shiftwork/f-01");
});

test("land waits for the repo's cross-process landing lock, not the shared-state lock", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	const order = [];

	let landing;
	await withLock(root, async () => {
		landing = ws.land(t).then((r) => {
			order.push("landed");
			return r;
		});
		await new Promise((resolve) => setTimeout(resolve, 1000));
		order.push("released");
	}, { name: "land" });

	assert.equal((await landing).ok, true);
	assert.deepEqual(order, ["released", "landed"]);
});

test("a conflicting parallel landing keeps the branch, and redo starts fresh from the new target", async () => {
	const root = await repo();
	await writeFile(join(root, "shared.txt"), "one\ntwo\nthree\n");
	git(root, "add", "shared.txt");
	git(root, "commit", "-q", "-m", "shared");
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t1 = ticket(root);
	const t2 = { ...ticket(root), number: "02", title: "B", path: join(root, ".scratch", "f", "issues", "02-b.md") };
	const a = await ws.prepare(t1);
	const b = await ws.prepare(t2);
	// The same line edited differently: the second landing conflicts with the first.
	await writeFile(join(a.cwd, "shared.txt"), "ONE\ntwo\nthree\n");
	await writeFile(join(b.cwd, "shared.txt"), "TWO!\ntwo\nthree\n");

	assert.equal((await ws.land(t1)).ok, true);
	const result = await ws.land(t2);

	assert.equal(result.ok, false);
	assert.deepEqual(result.conflict.files, ["shared.txt"]);
	assert.match(result.conflict.commit, /^[0-9a-f]{7,}$/);
	assert.match(result.message, /conflict/i);
	// The rebase was aborted: nothing changed, in the worktree or the main checkout.
	assert.equal(await readFile(join(b.cwd, "shared.txt"), "utf8"), "TWO!\ntwo\nthree\n");
	assert.equal(git(b.cwd, "status", "--porcelain"), "");
	assert.equal(git(root, "status", "--porcelain"), "");

	await ws.redo(t2);

	assert.equal(existsSync(b.cwd), false);
	assert.equal(git(root, "branch", "--list", "shiftwork/f-02"), "");

	const fresh = await ws.prepare(t2);

	assert.equal(await readFile(join(fresh.cwd, "shared.txt"), "utf8"), "ONE\ntwo\nthree\n");
	assert.equal(git(fresh.cwd, "rev-list", "--count", "main..HEAD"), "0");
});

test("a merge conflict keeps the branch and reports it", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "README.md"), "theirs\n");
	await writeFile(join(root, "README.md"), "ours\n");
	git(root, "commit", "-q", "-am", "ours");

	const result = await ws.land(t);

	assert.equal(result.ok, false);
	assert.match(result.message, /conflict/i);
	assert.equal(git(root, "status", "--porcelain"), "");
	assert.equal(git(root, "branch", "--list", "--format=%(refname:short)", "shiftwork/f-01"), "shiftwork/f-01");
});

test("keep leaves the branch; a re-run reuses it", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "partial.txt"), "wip\n");
	await ws.keep(t);

	const again = await ws.prepare(t);

	assert.equal(git(again.cwd, "rev-parse", "--abbrev-ref", "HEAD"), "shiftwork/f-01");
	assert.equal(await readFile(join(again.cwd, "partial.txt"), "utf8"), "wip\n");
});

test("setup commands run in a new worktree", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root, setup: ["echo ready > setup.txt"] });

	const { cwd } = await ws.prepare(ticket(root));

	assert.equal(await readFile(join(cwd, "setup.txt"), "utf8"), "ready\n");
});

test("diffStat reports what changed in the worktree", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const { cwd } = await ws.prepare(ticket(root));
	await writeFile(join(cwd, "README.md"), "changed\n");

	assert.match(await ws.diffStat(ticket(root)), /README\.md/);
});

test("files created by setup commands are never committed", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root, setup: ["mkdir -p deps && echo x > deps/lib.js", "echo y > cache.txt"] });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");

	assert.equal((await ws.land(t)).ok, true);

	assert.equal(existsSync(join(root, "feature.txt")), true);
	assert.equal(existsSync(join(root, "deps")), false);
	assert.equal(existsSync(join(root, "cache.txt")), false);
});

test("hasChanges sees commits and uncommitted work, but not the tracker copy or setup output", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root, setup: ["echo x > setup-out.txt"] });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "edited copy\n");
	assert.equal(await ws.hasChanges(t), false);

	await writeFile(join(cwd, "feature.txt"), "done\n");
	assert.equal(await ws.hasChanges(t), true);

	git(cwd, "add", "feature.txt");
	git(cwd, "commit", "-q", "-m", "work");
	assert.equal(await ws.hasChanges(t), true);
});

test("commit puts the work on the branch with the landing's message; land then merges that commit", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");

	assert.equal(await ws.commit(t), true);
	// A before-land reviewer's range: the shift's work is in it, new files included.
	assert.equal(git(cwd, "diff", "--name-only", `${await ws.target()}...HEAD`), "feature.txt");
	assert.match(git(cwd, "log", "-1", "--format=%s"), /shiftwork: f\/01 A/);
	assert.equal(await ws.commit(t), false, "nothing left to commit");

	const result = await ws.land(t);
	assert.equal(result.ok, true);
	assert.match(git(root, "log", "-1", "--format=%s"), /shiftwork: f\/01 A/);
	assert.equal(git(root, "log", "--format=%s", "--grep", "shiftwork: f/01").split("\n").length, 1, "one commit, not an extra empty one");
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "done\n");
});

test("discardAfterReview drops what the review round left; land merges exactly the committed work", async () => {
	const root = await repo();
	await writeFile(join(root, ".gitignore"), "junk.log\n");
	git(root, "add", ".gitignore");
	git(root, "commit", "-q", "-m", "ignore");
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root, setup: ["echo x > setup-out.txt"] });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	// The commit a before-land reviewer saw: this is all the branch carries.
	assert.equal(await ws.commit(t), true);
	// The review round leaves things behind: an edit to the committed work, an untracked file,
	// an ignored file, and edits to the tracker copy and setup output.
	await writeFile(join(cwd, "feature.txt"), "done\nreviewer edit\n");
	await writeFile(join(cwd, "stray.txt"), "untracked stray\n");
	await writeFile(join(cwd, "junk.log"), "ignored, stays\n");
	await writeFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "edited tracker copy\n");
	await writeFile(join(cwd, "setup-out.txt"), "y\n");

	assert.deepEqual(await ws.discardAfterReview(t), ["feature.txt", "stray.txt"], "only the strays are discarded");

	assert.equal(await readFile(join(cwd, "feature.txt"), "utf8"), "done\n", "the reviewer's edit is reverted");
	assert.equal(existsSync(join(cwd, "stray.txt")), false, "the untracked file is removed");
	assert.equal(existsSync(join(cwd, "junk.log")), true, "ignored files stay (no -x)");
	assert.equal(await readFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "utf8"), "edited tracker copy\n", "the tracker copy is kept");
	assert.equal(await readFile(join(cwd, "setup-out.txt"), "utf8"), "y\n", "setup output is kept");
	assert.deepEqual(await ws.discardAfterReview(t), [], "nothing left to discard");

	const result = await ws.land(t);

	assert.equal(result.ok, true);
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "done\n", "the landing carries the committed work, not the reviewer's edit");
	assert.equal(existsSync(join(root, "stray.txt")), false, "the stray file never landed");
	assert.equal(git(root, "log", "--format=%s", "--grep", "shiftwork: f/01").split("\n").length, 1, "one landing commit, no unseen second one");
});

test("after a rebase, discardAfterReview drops what the re-verify left; the next land merges only the reviewed commit", async () => {
	const root = await repo();
	await writeFile(join(root, ".gitignore"), "junk.log\n");
	git(root, "add", ".gitignore");
	git(root, "commit", "-q", "-m", "ignore");
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	// The commit a before-land review saw, and the first discard: nothing left to drop.
	assert.equal(await ws.commit(t), true);
	assert.deepEqual(await ws.discardAfterReview(t), []);
	// A parallel landing moves the target: the first land rebases the branch onto it.
	await writeFile(join(root, "other.txt"), "meanwhile\n");
	git(root, "add", "other.txt");
	git(root, "commit", "-q", "-m", "meanwhile");
	const moved = await ws.land(t);
	assert.equal(moved.ok, false);
	assert.match(moved.rebase, /^[0-9a-f]{7,}$/);
	// The re-verify runs on the rebased worktree and leaves strays behind: an edit to the
	// committed work, an untracked file and an ignored file.
	await writeFile(join(cwd, "feature.txt"), "done\nre-verify edit\n");
	await writeFile(join(cwd, "stray.txt"), "re-verify stray\n");
	await writeFile(join(cwd, "junk.log"), "ignored, stays\n");

	assert.deepEqual(await ws.discardAfterReview(t), ["feature.txt", "stray.txt"], "what the re-verify left is discarded again");
	assert.equal(await readFile(join(cwd, "feature.txt"), "utf8"), "done\n", "the re-verify's edit is reverted");
	assert.equal(existsSync(join(cwd, "stray.txt")), false, "the re-verify's stray is removed");
	assert.equal(existsSync(join(cwd, "junk.log")), true, "ignored files stay (no -x)");

	const result = await ws.land(t);

	assert.equal(result.ok, true);
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "done\n", "the landing carries the reviewed commit, not the re-verify's edit");
	assert.equal(existsSync(join(root, "stray.txt")), false, "the re-verify's stray never lands");
	assert.equal(git(root, "log", "--format=%s", "--grep", "shiftwork: f/01").split("\n").length, 1, "one landing commit, no unseen second one");
});

test("a dual candidate (suffix) gets its own branch and worktree; diff shows its committed work against the target", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const a = { ...ticket(root), suffix: "a" };
	const b = { ...ticket(root), suffix: "b" };

	const { cwd: cwdA, branch: branchA } = await ws.prepare(a);
	const { cwd: cwdB } = await ws.prepare(b);

	assert.equal(branchA, "shiftwork/f-01-a");
	assert.equal(git(cwdA, "rev-parse", "--abbrev-ref", "HEAD"), "shiftwork/f-01-a");
	assert.equal(git(cwdB, "rev-parse", "--abbrev-ref", "HEAD"), "shiftwork/f-01-b");
	assert.notEqual(cwdA, cwdB);
	await writeFile(join(cwdA, "a.txt"), "from a\n");
	assert.equal(await ws.commit(a), true);
	assert.match(git(cwdA, "log", "-1", "--format=%s"), /^shiftwork: f\/01-a A$/);

	const diff = await ws.diff(a);
	assert.equal(diff.branch, "shiftwork/f-01-a");
	assert.equal(diff.target, "main");
	assert.match(diff.stat, /a\.txt/);
	assert.equal((await ws.diff(b)).stat, "", "nothing committed on b");
	assert.equal(await ws.hasChanges(b), false);
	assert.equal(await ws.hasChanges(a), true);
});

test("prepare from a candidate's branch starts the ticket's own branch there; redo drops a candidate", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const a = { ...t, suffix: "a" };
	const { cwd: cwdA, branch: branchA } = await ws.prepare(a);
	await writeFile(join(cwdA, "a.txt"), "from a\n");
	await ws.commit(a);

	const { cwd, branch } = await ws.prepare(t, { from: branchA });

	assert.equal(branch, "shiftwork/f-01");
	assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "from a\n");
	await ws.redo(a);
	assert.equal(existsSync(cwdA), false);
	assert.equal(git(root, "branch", "--list", "shiftwork/f-01-a"), "");
	const landed = await ws.land(t);
	assert.equal(landed.ok, true);
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "from a\n");
});

test("changedFiles lists the branch's changes against the target, committed and uncommitted, without the tracker copy or setup output", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root, setup: ["echo x > setup-out.txt"] });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, ".scratch", "f", "issues", "01-a.md"), "edited copy\n");
	assert.deepEqual(await ws.changedFiles(t), []);

	await mkdir(join(cwd, "test"), { recursive: true });
	await writeFile(join(cwd, "test", "a.test.js"), "x\n");
	git(cwd, "add", "test/a.test.js");
	git(cwd, "commit", "-q", "-m", "work");
	await writeFile(join(cwd, "README.md"), "changed\n");
	await writeFile(join(cwd, "new.txt"), "new\n");
	assert.deepEqual((await ws.changedFiles(t)).sort(), ["README.md", "new.txt", "test/a.test.js"]);
	assert.deepEqual(await ws.changedFiles({ ...t, number: "09" }), [], "no worktree, nothing changed");
});
