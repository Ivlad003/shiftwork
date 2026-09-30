import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

test("a diverged target gets a merge commit instead of a fast-forward", async () => {
	const root = await repo();
	const ws = createGitWorkspace({ dir: `${root}-worktrees`, root });
	const t = ticket(root);
	const { cwd } = await ws.prepare(t);
	await writeFile(join(cwd, "feature.txt"), "done\n");
	await writeFile(join(root, "other.txt"), "meanwhile\n");
	git(root, "add", "other.txt");
	git(root, "commit", "-q", "-m", "meanwhile");

	assert.equal((await ws.land(t)).ok, true);
	assert.equal(git(root, "log", "-1", "--format=%p").split(" ").length, 2);
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
