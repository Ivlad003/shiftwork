import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/scripted-provider.ts", import.meta.url));
const ghStub = fileURLToPath(new URL("./fixtures/gh-stub.mjs", import.meta.url));

const LABELS = ["shiftwork:in", "shiftwork:working", "shiftwork:needs-info", "shiftwork:done"];

/** A repo root for a dark-factory run: a git repo (no remote), the config, the gh-stub state. */
async function makeRoot({ issues = [], labels = [...LABELS], noAuth = false, gh = ghStub } = {}) {
	const { execFileSync } = await import("node:child_process");
	const root = await mkdtemp(join(tmpdir(), "sw-df-e2e-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	await writeFile(join(root, "README.md"), "# test\n");
	// One initial commit, so syncIssues' `git log --grep` runs in a repo with history.
	await mkdir(join(root, ".pi"));
	git("add", "README.md");
	git("commit", "-q", "-m", "init");
	await writeFile(
		join(root, ".pi", "shiftwork.json"),
		JSON.stringify({
			model: "scripted/s1",
			thinking: "off",
			pi: { args: ["--offline", "-ns", "-ne", "-e", fixture] },
			github: { repo: "owner/name", gh, labels: { in: LABELS[0], working: LABELS[1], needsInfo: LABELS[2], done: LABELS[3] } },
		}),
	);
	const statePath = join(root, "gh-stub-state.json"); // outside .pi: a stub, not shiftwork state
	await writeFile(
		statePath,
		JSON.stringify({
			repo: "owner/name",
			collaborators: ["octocat"],
			labels,
			noAuth,
			issues: issues.map((issue) => ({ state: "open", comments: [], ...issue })),
		}),
	);
	// `shiftwork` on PATH: the planning ticket's Verify runs `shiftwork tickets check <feature>`.
	const pathDir = join(root, "path-bin");
	await mkdir(pathDir, { recursive: true });
	symlinkSync(bin, join(pathDir, "shiftwork"));
	return { root, statePath, pathDir };
}

/** Run `shiftwork <args>` in `root` and collect stdout/stderr/exit code. */
async function shiftwork(args, { root, statePath, pathDir, script }) {
	const home = await mkdtemp(join(tmpdir(), "sw-df-home-"));
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args], {
			env: {
				...process.env,
				PATH: `${pathDir}:${process.env.PATH}`,
				PI_CODING_AGENT_DIR: home,
				SHIFTWORK_GH_STATE: statePath,
				...(script !== undefined && { SHIFTWORK_SCRIPT: JSON.stringify(script) }),
			},
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

/** Run `shiftwork run --dark-factory --once --no-worktree` in `root`. */
function runOnce(ctx) {
	return shiftwork(["run", "--dark-factory", "--once", "--no-worktree", "--dir", ctx.root], ctx);
}

test("run --dark-factory --once: an issue is imported, planned and built, its comments land, it is closed, exit 0", { timeout: 240_000 }, async () => {
	const feature = "gh-5-add-a-greeting-file";
	const { root, statePath, pathDir } = await makeRoot({
		issues: [
			{
				number: 5,
				title: "Add a greeting file",
				body: "Write greeting.txt in the repo root, containing hi.",
				author: "octocat",
				labels: [LABELS[0]],
				url: "https://github.com/owner/name/issues/5",
			},
		],
	});

	// One script, replayed by every shift of the pass: the plan shift writes the
	// implementation ticket, the implementation shift finds both already there.
	const ticket02 = [
		"# 02: Write the greeting file",
		"",
		"**What to build:** Write `greeting.txt` with `hi` in it, in the repo root.",
		"",
		"**Blocked by:** None (can start immediately)",
		"",
		"**Status:** ready-for-agent",
		"",
		"**Verify:** `test -f greeting.txt`",
		"",
		"- [ ] greeting.txt exists and contains hi",
		"",
	].join("\n");
	const script = [
		{
			tool: {
				name: "bash",
				args: {
					command: `test -e .scratch/${feature}/issues/02-greeting.md || cat > .scratch/${feature}/issues/02-greeting.md <<'TICKET'\n${ticket02}TICKET`,
				},
			},
		},
		{ tool: { name: "bash", args: { command: "test -f greeting.txt || printf 'hi\\n' > greeting.txt" } } },
		{ text: "Wrote the implementation ticket and greeting.txt." },
	];

	const { code, stdout, stderr } = await runOnce({ root, statePath, pathDir, script });
	assert.equal(code, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);

	// The import and the sync actions each print one line.
	assert.match(stdout, /github#5 imported: Add a greeting file → gh-5-add-a-greeting-file/);
	assert.match(stdout, /✔ gh-5-add-a-greeting-file\/01 resolved/);
	assert.match(stdout, /✔ gh-5-add-a-greeting-file\/02 resolved/);
	assert.match(stdout, /github#5: comment: ticket 01 resolved/);
	assert.match(stdout, /github#5: comment: ticket 02 resolved/);
	assert.match(stdout, /github#5: comment: closing summary/);
	assert.match(stdout, /github#5: closed the issue/);
	assert.match(stdout, /github#5: labeled done/);

	// Both tickets are resolved on disk; the plan shift filed exactly one ticket.
	const plan = await readFile(join(root, ".scratch", feature, "issues", "01-plan.md"), "utf8");
	const impl = await readFile(join(root, ".scratch", feature, "issues", "02-greeting.md"), "utf8");
	assert.match(plan, /\*\*Status:\*\* resolved/);
	assert.match(impl, /\*\*Status:\*\* resolved/);
	assert.equal(await readFile(join(root, "greeting.txt"), "utf8"), "hi\n");

	// The issue got its comments and is closed with the done label.
	const state = JSON.parse(await readFile(statePath, "utf8"));
	const issue = state.issues[0];
	assert.equal(issue.state, "closed");
	assert.deepEqual(issue.labels, [LABELS[0], LABELS[3]]);
	const bodies = issue.comments.map((c) => c.body);
	assert.equal(bodies.filter((b) => /Ticket 01 resolved/.test(b)).length, 1);
	assert.equal(bodies.filter((b) => /Ticket 02 resolved/.test(b)).length, 1);
	assert.equal(bodies.filter((b) => /All tickets of this issue are resolved/.test(b)).length, 1);
});

test("run --dark-factory --ticket exits 1 with the combination message", { timeout: 60_000 }, async () => {
	const ctx = await makeRoot();
	const { code, stderr } = await shiftwork(["run", "--dark-factory", "--ticket", "gh-8-fix-the-thing/01", "--dir", ctx.root], ctx);
	assert.equal(code, 1);
	assert.match(stderr, /--dark-factory cannot be combined with --ticket/);
});

test("gh auth status failing exits 1 with the login message", { timeout: 60_000 }, async () => {
	const { root, statePath, pathDir } = await makeRoot({ noAuth: true });
	const { code, stderr } = await runOnce({ root, statePath, pathDir });
	assert.equal(code, 1);
	assert.match(stderr, /dark-factory needs an authenticated gh: run gh auth login/);
	assert.equal(existsSync(join(root, ".scratch")), false, "nothing imported");
});

test("a bad github.gh exits 1 with the install message", { timeout: 60_000 }, async () => {
	const { root, statePath, pathDir } = await makeRoot({ gh: "/nonexistent/gh" });
	const { code, stderr } = await runOnce({ root, statePath, pathDir });
	assert.equal(code, 1);
	assert.match(stderr, /dark-factory needs the GitHub CLI: install it from https:\/\/cli\.github\.com, then run gh auth login/);
	assert.equal(existsSync(join(root, ".scratch")), false, "nothing imported");
});

test("a missing label exits 1 with the missing-labels error and imports nothing", { timeout: 60_000 }, async () => {
	const { root, statePath, pathDir } = await makeRoot({ labels: [LABELS[0]] });
	const { code, stderr } = await runOnce({ root, statePath, pathDir });
	assert.equal(code, 1);
	assert.match(stderr, new RegExp(`dark-factory: missing GitHub labels in owner/name: ${LABELS.slice(1).join(", ").replace(/:/g, "\\:")}`));
	assert.match(stderr, /shiftwork github labels --create/);
	assert.equal(existsSync(join(root, ".scratch")), false, "nothing imported");
	assert.deepEqual(await readdir(join(root, ".pi")).catch(() => []), ["shiftwork.json"], "no issue state written");
});
