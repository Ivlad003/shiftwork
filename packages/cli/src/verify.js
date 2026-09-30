import { spawn } from "node:child_process";

const TAIL_CHARS = 4000;

/** Run verify gate commands in order, stopping at the first failure. */
export async function runVerify(commands, cwd, { timeoutMs = 10 * 60_000 } = {}) {
	const results = [];
	for (const cmd of commands) {
		const result = await runOne(cmd, cwd, timeoutMs);
		results.push(result);
		if (result.code !== 0) return { ok: false, results };
	}
	return { ok: true, results };
}

function runOne(cmd, cwd, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const collect = (chunk) => {
			output = (output + chunk).slice(-TAIL_CHARS * 2);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			output += `\n[shiftwork] timed out after ${timeoutMs} ms`;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ cmd, code: code ?? (signal ? 124 : 1), outputTail: output.slice(-TAIL_CHARS) });
		});
	});
}
