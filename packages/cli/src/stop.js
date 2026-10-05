import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openRunState } from "shiftwork-core";

export const USAGE = `Usage: shiftwork stop [--dark-factory] [--wait [sec]] [--force] [--dir <path>]

Stop the live runner: write STOP so its shifts hand off and it exits. Nothing is written
when no runner is live (a stale STOP would block the next start).

  --dark-factory   Stop only a dark-factory runner; exit 1 while a plain run is live
  --wait [sec]     Poll until the runner has stopped (default 120 s), then remove the
                   STOP file written here; exit 1 on timeout
  --force          Also send SIGTERM to the runner pids
  --dir <path>     The repo (default: the current directory)
  -h, --help       Show this help`;

/** How long `--wait` waits for the runner to stop when no seconds are given. */
export const DEFAULT_WAIT_SEC = 120;
const POLL_MS = 500;

/**
 * `shiftwork stop [--dark-factory] [--wait [sec]] [--force] [--dir <path>]` (GitHub #17):
 * write the STOP file when a runner is live, so its shifts hand off and it exits, as `s`
 * in the TUI does. With no live runner nothing is written — a stale STOP would block the
 * next start. `--dark-factory` stops only a dark-factory runner: STOP ends every runner of
 * the repo, so it refuses (exit 1) while a plain run is live. `--force` also sends SIGTERM
 * to the runner pids (signal-stop turns it into a stop and, 60 s later, aborts the shifts).
 * `--wait` polls the run state until no runner is live, then removes the STOP file it wrote;
 * exit 1 when the runner is still live after the timeout.
 * Returns the exit code.
 */
export async function stop(argv, { log = console.log, error = console.error, kill = (pid, signal) => process.kill(pid, signal), sleep = defaultSleep, pollMs = POLL_MS } = {}) {
	let values;
	try {
		({ values } = parseArgs({
			args: normalizeWait(argv),
			options: {
				dir: { type: "string" },
				"dark-factory": { type: "boolean" },
				wait: { type: "string" },
				force: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (e) {
		error(`shiftwork stop: ${e.message}\n${USAGE}`);
		return 1;
	}
	if (values.help) {
		log(USAGE);
		return 0;
	}
	const root = resolve(values.dir ?? process.cwd());
	const darkFactory = Boolean(values["dark-factory"]);
	let waitSec = null;
	if (values.wait !== undefined) {
		waitSec = values.wait === "" ? DEFAULT_WAIT_SEC : Number(values.wait);
		if (!Number.isFinite(waitSec) || waitSec < 0) {
			error(`shiftwork stop: --wait takes a number of seconds, not "${values.wait}"`);
			return 1;
		}
	}

	const runState = openRunState(root);
	const live = await liveRunners(runState);
	if (!live.length) {
		log(darkFactory ? "No dark-factory runner is running: nothing to stop (STOP not written)" : "No runner is running: nothing to stop (STOP not written)");
		return 0;
	}
	if (darkFactory) {
		const plain = live.filter((r) => r.mode !== "dark-factory");
		if (plain.length) {
			const which = plain.map((r) => `runner pid ${r.pid} (${modeOf(r)})`).join(", ");
			const alsoDf = plain.length < live.length;
			error(
				alsoDf
					? `shiftwork stop: ${which} is live next to the dark-factory runner, and STOP would stop it too: nothing written (shiftwork stop stops them all)`
					: `shiftwork stop: no dark-factory runner is live, ${which} is: nothing written (shiftwork stop stops it)`,
			);
			return 1;
		}
	}

	const stopFile = join(root, "STOP");
	const existed = existsSync(stopFile);
	if (!existed) await writeFile(stopFile, `Stopped from shiftwork stop at ${new Date().toISOString()}\n`);
	for (const r of live) {
		log(`${existed ? "STOP file already there" : "STOP file written"} · runner pid ${r.pid} (${modeOf(r)}) hands off and stops`);
	}
	if (values.force) {
		for (const r of live) {
			try {
				kill(r.pid, "SIGTERM");
				log(`SIGTERM sent to runner pid ${r.pid}`);
			} catch (e) {
				error(`shiftwork stop: could not signal runner pid ${r.pid}: ${e.message}`);
			}
		}
	}

	if (waitSec === null) {
		if (!existed) log("Delete STOP before the next run, or use --wait to remove it once the runner has stopped");
		return 0;
	}
	const deadline = Date.now() + waitSec * 1000;
	for (;;) {
		if (!(await liveRunners(runState)).length) {
			// A STOP left behind would end the next run at once; remove only the one written here.
			if (!existed) await rm(stopFile, { force: true });
			log(`Runner stopped${existed ? "" : " · STOP file removed"}`);
			return 0;
		}
		const left = deadline - Date.now();
		if (left <= 0) break;
		await sleep(Math.min(pollMs, left));
	}
	error(`shiftwork stop: the runner is still live after ${waitSec} s (STOP stays; --force sends SIGTERM)`);
	return 1;
}

async function liveRunners(runState) {
	const run = await runState.read();
	return (run?.runners ?? []).filter((r) => r.live);
}

const modeOf = (runner) => runner.mode ?? "run";

/** `--wait` takes optional seconds: `--wait`, `--wait 30` and `--wait=30` all parse as a string option. */
function normalizeWait(argv) {
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--wait") {
			const next = argv[i + 1];
			if (next !== undefined && /^\d+(\.\d+)?$/.test(next)) {
				out.push(`--wait=${next}`);
				i++;
			} else out.push("--wait=");
		} else out.push(argv[i]);
	}
	return out;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
