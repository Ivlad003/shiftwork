import { spawn } from "node:child_process";

const TAIL_CHARS = 4000;

const DEFAULT_TIMEOUT_MIN = 10;
const running = new Set();

/** Kill every verify command still running, with all it started (the runner calls this on SIGTERM/SIGINT). */
export function killRunningVerify() {
	for (const child of running) killGroup(child);
}

function killGroup(child) {
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

/** The runner's verify function for a config: each command may run `verifyTimeoutMin` minutes (default 10). */
export function createVerify(config = {}) {
	const minutes = config.verifyTimeoutMin ?? DEFAULT_TIMEOUT_MIN;
	return (commands, cwd) => runVerify(commands, cwd, { timeoutMs: minutes * 60_000, timeoutLabel: `${minutes} min (verifyTimeoutMin)` });
}

/** Run verify gate commands in order, stopping at the first failure. */
export async function runVerify(commands, cwd, { timeoutMs = DEFAULT_TIMEOUT_MIN * 60_000, timeoutLabel = `${timeoutMs} ms` } = {}) {
	const results = [];
	for (const cmd of commands) {
		const result = await runOne(cmd, cwd, timeoutMs, timeoutLabel);
		results.push(result);
		if (result.code !== 0) return { ok: false, results };
	}
	return { ok: true, results };
}

function runOne(cmd, cwd, timeoutMs, timeoutLabel) {
	return new Promise((resolve) => {
		// Its own process group, so a timeout kills everything the command started, not just `sh`.
		const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let output = "";
		const collect = (chunk) => {
			output = (output + chunk).slice(-TAIL_CHARS * 2);
		};
		running.add(child);
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			output += `\n[shiftwork] timed out after ${timeoutLabel}`;
			killGroup(child);
		}, timeoutMs);
		child.on("close", (code, signal) => {
			running.delete(child);
			clearTimeout(timer);
			resolve({ cmd, code: code ?? (signal ? 124 : 1), outputTail: output.slice(-TAIL_CHARS) });
		});
	});
}
