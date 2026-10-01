import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/scripted-provider.ts", import.meta.url));

test("shiftwork run resolves a ticket end to end with a real pi shift", { timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-e2e-"));
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await mkdir(join(root, ".pi"));
	await writeFile(
		join(root, ".scratch", "demo", "issues", "01-hello.md"),
		"# 01: Hello file\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n**Verify:** `test -f hello.txt`\n\n- [ ] hello.txt exists\n",
	);
	await writeFile(
		join(root, ".pi", "shiftwork.json"),
		JSON.stringify({ model: "scripted/s1", thinking: "off", pi: { args: ["--offline", "-ns", "-ne", "-e", fixture] } }),
	);
	const script = [{ tool: { name: "write", args: { path: "hello.txt", content: "hi\n" } } }, { text: "Wrote hello.txt." }];

	const { stdout } = await promisify(execFile)(process.execPath, [bin, "run", "--dir", root], {
		env: { ...process.env, PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), "sw-e2e-home-")), SHIFTWORK_SCRIPT: JSON.stringify(script) },
	});

	assert.match(stdout, /✔ demo\/01 resolved/);
	const ticket = await readFile(join(root, ".scratch", "demo", "issues", "01-hello.md"), "utf8");
	assert.match(ticket, /\*\*Status:\*\* resolved/);
	assert.match(ticket, /### Shift 1 — pi scripted\/s1 \(off\)[\s\S]*Verify: passed/);
	assert.deepEqual(await readdir(join(root, "logs", "demo", "01")), ["attempt-1.jsonl"]);
});

test("in a git repo each ticket runs in its own worktree and lands on the target branch", { timeout: 120_000 }, async () => {
	const { execFileSync } = await import("node:child_process");
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const root = await mkdtemp(join(tmpdir(), "sw-e2e-git-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await mkdir(join(root, ".pi"));
	await writeFile(
		join(root, ".scratch", "demo", "issues", "01-hello.md"),
		"# 01: Hello file\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n**Verify:** `test -f hello.txt` · `test -f setup-ran.txt`\n",
	);
	await writeFile(
		join(root, ".pi", "shiftwork.json"),
		JSON.stringify({
			model: "scripted/s1",
			thinking: "off",
			worktree: { dir: `${root}-worktrees`, setup: ["touch setup-ran.txt"] },
			pi: { args: ["--offline", "-ns", "-ne", "-e", fixture] },
		}),
	);
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	const script = [{ tool: { name: "write", args: { path: "hello.txt", content: "hi\n" } } }, { text: "Done." }];

	const { stdout } = await promisify(execFile)(process.execPath, [bin, "run", "--dir", root], {
		env: { ...process.env, PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), "sw-e2e-home-")), SHIFTWORK_SCRIPT: JSON.stringify(script) },
	});

	assert.match(stdout, /✔ demo\/01 resolved/);
	assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hi\n");
	assert.match(git("log", "-1", "--format=%s"), /^shiftwork: demo\/01 Hello file$/);
	assert.match(await readFile(join(root, ".scratch", "demo", "issues", "01-hello.md"), "utf8"), /- Landed: merged shiftwork\/demo-01 into main/);
	assert.equal(existsSync(join(root, "setup-ran.txt")), false, "setup output must not land");
	assert.equal(existsSync(join(root, "setup-ran.txt")), false);
});

test("parallel tickets touching one file land: a conflicting landing is redone on top of the first", { timeout: 240_000 }, async () => {
	const { execFileSync } = await import("node:child_process");
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const root = await mkdtemp(join(tmpdir(), "sw-e2e-par-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await mkdir(join(root, ".pi"));
	// Two independent tickets touching the same new file: `pwd > hello.txt` gives each worktree
	// its own content, so the second landing conflicts with the first (spec story 4).
	for (const [number, title] of [
		["01", "Greet once"],
		["02", "Greet twice"],
	]) {
		await writeFile(
			join(root, ".scratch", "demo", "issues", `${number}-greet.md`),
			`# ${number}: ${title}\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n**Verify:** \`test -f hello.txt\`\n`,
		);
	}
	await writeFile(
		join(root, ".pi", "shiftwork.json"),
		JSON.stringify({
			model: "scripted/s1",
			thinking: "off",
			parallel: 2,
			worktree: { enabled: true, dir: `${root}-worktrees` },
			pi: { args: ["--offline", "-ns", "-ne", "-e", fixture] },
		}),
	);
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	const script = [{ tool: { name: "bash", args: { command: "pwd > hello.txt" } } }, { text: "Wrote hello.txt." }];

	const { stdout } = await promisify(execFile)(process.execPath, [bin, "run", "--dir", root], {
		env: { ...process.env, PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), "sw-e2e-home-")), SHIFTWORK_SCRIPT: JSON.stringify(script) },
	});

	assert.match(stdout, /✔ demo\/01 resolved/);
	assert.match(stdout, /✔ demo\/02 resolved/);
	assert.ok(existsSync(join(root, "hello.txt")));
	const texts = await Promise.all(
		["01-greet.md", "02-greet.md"].map((f) => readFile(join(root, ".scratch", "demo", "issues", f), "utf8")),
	);
	assert.ok(texts.every((t) => /\*\*Status:\*\* resolved/.test(t)), "both tickets resolved");
	// The ticket that landed second notes the landing conflict and was redone on top of the first.
	const conflicted = texts.find((t) => /- Landing conflict with hello\.txt; redone on top of [0-9a-f]+/.test(t));
	assert.ok(conflicted, "one ticket notes the landing conflict");
	assert.match(conflicted, /### Shift 2 — pi scripted\/s1/);
	const winner = texts.find((t) => t !== conflicted);
	assert.doesNotMatch(winner, /Landing conflict/);
	assert.doesNotMatch(winner, /### Shift 2/);
});

test("run --ticket works exactly the chosen ticket end to end", { timeout: 120_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-e2e-ticket-"));
	await mkdir(join(root, ".scratch", "demo", "issues"), { recursive: true });
	await mkdir(join(root, ".pi"));
	for (const [number, file] of [
		["01", "01-first.md"],
		["02", "02-second.md"],
	]) {
		await writeFile(
			join(root, ".scratch", "demo", "issues", file),
			`# ${number}: Ticket ${number}\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n**Verify:** \`test -f ${number}.txt\`\n`,
		);
	}
	await writeFile(
		join(root, ".pi", "shiftwork.json"),
		JSON.stringify({ model: "scripted/s1", thinking: "off", pi: { args: ["--offline", "-ns", "-ne", "-e", fixture] } }),
	);
	const script = [{ tool: { name: "write", args: { path: "02.txt", content: "hi\n" } } }, { text: "Wrote 02.txt." }];

	const { stdout } = await promisify(execFile)(process.execPath, [bin, "run", "--ticket", "demo/02", "--dir", root], {
		env: { ...process.env, PI_CODING_AGENT_DIR: await mkdtemp(join(tmpdir(), "sw-e2e-home-")), SHIFTWORK_SCRIPT: JSON.stringify(script) },
	});

	assert.match(stdout, /✔ demo\/02 resolved/);
	assert.doesNotMatch(stdout, /demo\/01/);
	const second = await readFile(join(root, ".scratch", "demo", "issues", "02-second.md"), "utf8");
	assert.match(second, /\*\*Status:\*\* resolved/);
	const first = await readFile(join(root, ".scratch", "demo", "issues", "01-first.md"), "utf8");
	assert.match(first, /\*\*Status:\*\* ready-for-agent/);
	assert.doesNotMatch(first, /### Shift/);
});

test("run --ticket refuses --feature and --parallel as usage errors; --help lists --ticket", async () => {
	const help = await promisify(execFile)(process.execPath, [bin, "run", "--help"]);
	assert.match(help.stdout, /--ticket <feature>\/<NN>/);

	const root = await mkdtemp(join(tmpdir(), "sw-e2e-usage-"));
	for (const extra of [["--feature", "demo"], ["--parallel", "2"]]) {
		const error = await promisify(execFile)(process.execPath, [bin, "run", "--ticket", "demo/01", ...extra, "--dir", root]).then(
			() => null,
			(e) => e,
		);
		assert.equal(error?.code, 1);
		assert.match(error?.stderr, /--ticket cannot be combined with/);
	}
});
