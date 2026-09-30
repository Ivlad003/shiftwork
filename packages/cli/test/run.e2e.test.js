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
