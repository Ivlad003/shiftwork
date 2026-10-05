import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgent, spawnAgent } from "../src/spawn-agent.js";

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitFor(check, timeoutMs = 5_000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
}

function run(command, args, options = {}) {
	const lines = [];
	let resolveClose;
	const closed = new Promise((resolve) => {
		resolveClose = resolve;
	});
	const agent = spawnAgent(command, args, {
		...options,
		onLine: (line) => lines.push(line),
		onClose: (exit) => resolveClose(exit),
	});
	return { agent, lines, closed };
}

test("stdout streams line by line (the last line without a newline too) and the exit code is reported", async () => {
	const { lines, closed } = run("sh", ["-c", 'printf "a\\nb\\n"; printf "c"; exit 3']);
	const exit = await closed;
	assert.deepEqual(lines, ["a", "b", "c"]);
	assert.equal(exit.code, 3);
	assert.equal(exit.timedOut, false);
});

test("only a bounded tail of stderr is kept", async () => {
	const { agent, closed } = run("sh", ["-c", "i=0; while [ $i -lt 2000 ]; do echo noise-$i >&2; i=$((i+1)); done; echo last-line >&2"], { stderrTailChars: 100 });
	await closed;
	assert.ok(agent.stderrTail().length <= 100);
	assert.match(agent.stderrTail(), /last-line\n$/);
});

test("stdin is closed, so a CLI that reads stdin until EOF does not hang", async () => {
	const { lines, closed } = run("sh", ["-c", "cat; echo done"]);
	assert.equal((await closed).code, 0);
	assert.deepEqual(lines, ["done"]);
});

test("the agent runs in its own process group, so a terminal Ctrl-C does not reach it", async () => {
	const { agent, lines, closed } = run("sh", ["-c", "ps -o pgid= -p $$"]);
	await closed;
	assert.equal(Number(lines[0].trim()), agent.pid);
});

test("kill() stops the whole process group, grandchildren included", async () => {
	const { agent, lines } = run("sh", ["-c", "sleep 60 & echo $!; wait"]);
	await waitFor(() => lines.length > 0);
	const grandchild = Number(lines[0]);
	assert.ok(alive(grandchild));
	await agent.kill();
	assert.ok(await waitFor(() => !alive(grandchild)), "the grandchild is gone");
	assert.ok(!alive(agent.pid));
});

test("an agent that ignores SIGTERM gets SIGKILL after the grace period", async () => {
	const { agent, lines, closed } = run("sh", ["-c", 'trap "" TERM; echo ready; while :; do sleep 0.05; done'], { graceMs: 200 });
	await waitFor(() => lines.length > 0);
	const started = Date.now();
	await agent.kill();
	const exit = await closed;
	assert.equal(exit.signal, "SIGKILL");
	assert.ok(Date.now() - started >= 150, "SIGTERM came first, SIGKILL only after the grace");
});

test("a timeout kills the group and is reported", async () => {
	const { closed } = run("sh", ["-c", "sleep 60"], { timeoutMs: 150, graceMs: 200 });
	const exit = await closed;
	assert.equal(exit.timedOut, true);
	assert.equal(exit.code, null);
});

test("a missing binary is reported through onError", async () => {
	const error = await new Promise((resolve) => spawnAgent("shiftwork-no-such-binary", [], { onError: resolve }));
	assert.match(error.message, /ENOENT/);
});

test("the agent's process group is killed when the Shiftwork process exits", { timeout: 20_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "sw-spawn-exit-"));
	const script = join(dir, "parent.mjs");
	const helper = new URL("../src/spawn-agent.js", import.meta.url).href;
	await writeFile(
		script,
		`import { spawnAgent } from ${JSON.stringify(helper)};
spawnAgent("sh", ["-c", "sleep 60 & echo $!; wait"], {
	onLine(line) {
		console.log(line);
		setTimeout(() => process.exit(0), 50);
	},
});
`,
	);
	const output = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 10_000 });
	const grandchild = Number(output.trim());
	assert.ok(grandchild > 0);
	assert.ok(await waitFor(() => !alive(grandchild)), "the agent's grandchild did not outlive Shiftwork");
});

test("runAgent collects output for short calls such as probes", async () => {
	const result = await runAgent("sh", ["-c", "echo out; echo err >&2; exit 2"]);
	assert.equal(result.code, 2);
	assert.equal(result.stdout, "out\n");
	assert.equal(result.stderr, "err\n");
	assert.equal(result.error, undefined);
	const missing = await runAgent("shiftwork-no-such-binary", []);
	assert.ok(missing.error);
});
