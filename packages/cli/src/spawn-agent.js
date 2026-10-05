import { spawn } from "node:child_process";
import { registerChild } from "./signal-stop.js";

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_TAIL_CHARS = 8192;

/** Agent groups still running; the Shiftwork process kills what is left of them when it exits. */
const live = new Set();
let exitHookInstalled = false;

function installExitHook() {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	// The last resort: a normal run closes its shifts first, and a signal stop aborts them with
	// the grace period. Whatever is still alive at exit must not outlive Shiftwork.
	process.once("exit", () => {
		for (const entry of live) entry.forceKill();
	});
}

/**
 * Spawn an agent CLI for a shift. Streams stdout line by line (no whole-output buffer) and keeps
 * only a bounded tail of stderr and stdout, for error messages.
 *
 * The agent runs in its own process group (`detached`), so a terminal Ctrl-C reaches Shiftwork's
 * signal-stop handler, which hands off and then aborts the shifts, instead of killing agents
 * mid-edit. `kill()` (and a timeout) sends SIGTERM to the whole group, then SIGKILL after
 * `graceMs` if anything in it is still alive. Groups left at Shiftwork's exit are SIGKILLed.
 * stdin is closed: CLIs such as `opencode run` read piped stdin as extra prompt and wait for EOF.
 *
 * Options: { cwd?, env?, timeoutMs?, graceMs? = 5000, stderrTailChars? = 8192, stdoutTailChars? = 8192,
 *   onLine?(line), onClose?({ code, signal, timedOut }), onError?(error) }
 */
export function spawnAgent(command, args, options = {}) {
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	const stderrTailChars = options.stderrTailChars ?? DEFAULT_TAIL_CHARS;
	const stdoutTailChars = options.stdoutTailChars ?? DEFAULT_TAIL_CHARS;
	let stderr = "";
	let stdoutTail = "";
	let buffer = "";
	let exited = false;
	let timedOut = false;
	let killing = null;
	let timer;

	const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });

	const signalGroup = (signal) => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			// Not a group leader (or no group support): signal the process itself.
			if (!exited) child.kill(signal);
		}
	};
	const groupAlive = () => {
		if (!child.pid) return false;
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch {
			return !exited;
		}
	};
	const entry = {
		forceKill() {
			if (groupAlive()) signalGroup("SIGKILL");
		},
	};

	const kill = () => {
		if (killing) return killing;
		killing = new Promise((resolve) => {
			if (!groupAlive()) return resolve();
			signalGroup("SIGTERM");
			const started = Date.now();
			const poll = setInterval(() => {
				if (!groupAlive()) {
					clearInterval(poll);
					resolve();
				} else if (Date.now() - started >= graceMs) {
					clearInterval(poll);
					signalGroup("SIGKILL");
					resolve();
				}
			}, 50);
		}).finally(forget);
		return killing;
	};

	// Also known to the signal-stop handler, which SIGKILLs registered groups on a forced stop.
	const unregister = registerChild(child.pid);
	const forget = () => {
		live.delete(entry);
		unregister();
	};
	if (child.pid) {
		live.add(entry);
		installExitHook();
	}

	const timeoutMs = options.timeoutMs;
	if (timeoutMs) {
		timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		timer.unref?.();
	}

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-stderrTailChars);
	});
	child.stdout.on("data", (chunk) => {
		stdoutTail = (stdoutTail + chunk).slice(-stdoutTailChars);
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop();
		for (const line of lines) options.onLine?.(line);
	});

	child.on("error", (error) => {
		exited = true;
		clearTimeout(timer);
		forget();
		options.onError?.(error);
	});
	child.on("close", (code, signal) => {
		exited = true;
		clearTimeout(timer);
		if (buffer) {
			const rest = buffer;
			buffer = "";
			options.onLine?.(rest);
		}
		if (!groupAlive()) forget();
		options.onClose?.({ code, signal, timedOut });
	});

	return {
		child,
		pid: child.pid,
		/** SIGTERM to the group, SIGKILL after the grace period; resolves when the group is gone or SIGKILLed. */
		kill,
		get exited() {
			return exited;
		},
		stderrTail: () => stderr,
		stdoutTail: () => stdoutTail,
	};
}

/**
 * Run a short agent call (a probe) to completion with `spawnAgent`, collecting bounded output.
 * Resolves { code, signal, timedOut, stdout, stderr, error? }; never rejects.
 */
export function runAgent(command, args, options = {}) {
	const limit = options.maxOutputChars ?? 1024 * 1024;
	return new Promise((resolve) => {
		const agent = spawnAgent(command, args, {
			...options,
			stderrTailChars: limit,
			stdoutTailChars: limit,
			onClose: ({ code, signal, timedOut }) => resolve({ code, signal, timedOut, stdout: agent.stdoutTail(), stderr: agent.stderrTail() }),
			onError: (error) => resolve({ code: null, signal: null, timedOut: false, stdout: agent.stdoutTail(), stderr: agent.stderrTail(), error }),
		});
	});
}
