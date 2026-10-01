import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openRunState } from "shiftwork-core";
import { collectDryRunLines } from "./dry-run.js";

/** The keys the TUI handles: r run · s stop (with handoff) · d dry-run · f feature filter · q quit. */
export const TUI_KEYS = ["r", "s", "d", "f", "q", "\x03"];

/**
 * The pure key reducer: (state, key) → { state, effects }.
 * State: { run, features, featureFilter, notice, dryRun }. It is never mutated.
 * Effects are data for the executor: { type: "start-runner" | "stop-runner" | "dry-run", feature }
 * or { type: "quit" }. A second `r` while a runner is live is refused with a notice (spec story 28).
 */
export function reduceKey(state, key) {
	switch (key) {
		case "r": {
			if (state.run?.live) {
				return { state: { ...state, notice: `a runner is already working (pid ${state.run.pid})` }, effects: [] };
			}
			return {
				state: { ...state, notice: "starting the runner…" },
				effects: [{ type: "start-runner", feature: state.featureFilter ?? null }],
			};
		}
		case "s": {
			const notice = state.run?.live
				? `STOP file written · runner pid ${state.run.pid} hands off and stops`
				: "STOP file written (no live runner)";
			return { state: { ...state, notice }, effects: [{ type: "stop-runner" }] };
		}
		case "d":
			return {
				state: { ...state, notice: null, dryRun: { pending: true } },
				effects: [{ type: "dry-run", feature: state.featureFilter ?? null }],
			};
		case "f": {
			const order = [null, ...(state.features ?? [])];
			const next = order[(order.indexOf(state.featureFilter ?? null) + 1) % order.length];
			return { state: { ...state, featureFilter: next, notice: next ? `filter: ${next}` : "filter: all features" }, effects: [] };
		}
		case "q":
		case "\x03":
			return { state, effects: [{ type: "quit" }] };
		default:
			return { state, effects: [] };
	}
}

/**
 * Key handling for the interactive TUI: the latest dashboard state goes in through
 * `setDashboard`, keys through `handleKey`, and `view` (featureFilter, notice, dryRun)
 * is merged over the dashboard state for rendering. `onChange` fires after every change.
 * Effects are injectable so tests can drive them with a stub runner.
 */
export function createTuiControls({ root, start, stop, plan, onChange, onQuit } = {}) {
	const effects = {
		"start-runner": start ?? ((root_, effect) => startDetachedRunner(root_, { feature: effect.feature, ticket: effect.ticket })),
		"stop-runner": stop ?? writeStopFile,
		"dry-run": plan ?? ((root_, effect) => collectDryRunLines(root_, { feature: effect.feature })),
	};
	let dashboard = { run: null, tickets: [] };
	let view = { featureFilter: null, notice: null, dryRun: null };
	let quit = onQuit ?? (() => {});

	const emit = () => onChange?.(view);
	const setView = (next) => {
		view = next;
		emit();
	};

	async function execute(effect) {
		try {
			switch (effect.type) {
				case "start-runner": {
					const res = await effects["start-runner"](root, effect);
					setView({
						...view,
						notice: res.started ? `runner started (pid ${res.pid}) · logs: ${relative(root, res.logFile)}` : res.reason,
					});
					break;
				}
				case "stop-runner":
					await effects["stop-runner"](root, effect);
					break; // the reducer already set the notice
				case "dry-run": {
					const lines = await effects["dry-run"](root, effect);
					setView({ ...view, dryRun: { lines } });
					break;
				}
				case "quit":
					quit();
					break;
			}
		} catch (error) {
			setView({ ...view, dryRun: effect.type === "dry-run" ? null : view.dryRun, notice: `${effect.type} failed: ${error.message}` });
		}
	}

	return {
		get view() {
			return view;
		},
		setDashboard(state) {
			dashboard = state ?? { run: null, tickets: [] };
		},
		onQuit(fn) {
			quit = fn;
		},
		/** Feed one key through the reducer and run its effects. Returns the effects it ran. */
		async handleKey(key) {
			const features = [...new Set((dashboard.tickets ?? []).map((t) => t.feature))].sort();
			const { state, effects: list } = reduceKey({ ...view, run: dashboard.run, features }, key);
			setView({ featureFilter: state.featureFilter ?? null, notice: state.notice ?? null, dryRun: state.dryRun ?? null });
			for (const effect of list) await execute(effect);
			return list;
		},
	};
}

/**
 * Start `shiftwork run` detached, like `/shift run`: output goes to logs/runner-<ts>.log,
 * a stale STOP file is removed first, and the run state is claimed at once so the
 * dashboard is live before the runner's own first write. Refused while a runner is live.
 */
export async function startDetachedRunner(root, { feature, ticket, bin } = {}) {
	const runState = openRunState(root);
	const current = await runState.read();
	if (current?.live) {
		return { started: false, reason: `a runner is already working (pid ${current.pid})` };
	}
	const cli = bin ?? process.env.SHIFTWORK_BIN ?? fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));

	// A STOP file left by an earlier stop would end the new run immediately.
	const stopFile = join(root, "STOP");
	const removedStop = existsSync(stopFile);
	if (removedStop) await rm(stopFile, { force: true });

	await mkdir(join(root, "logs"), { recursive: true });
	const logFile = join(root, "logs", `runner-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
	const log = openSync(logFile, "a");
	const args = [cli, "run", ...(feature ? ["--feature", feature] : []), ...(ticket ? ["--ticket", ticket] : [])];
	const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ["ignore", log, log] });
	child.unref();
	await runState.update({
		pid: child.pid,
		running: true,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		stoppedReason: null,
		workers: [],
		summary: { resolved: 0, needsInfo: 0 },
		logFile,
	});
	return { started: true, pid: child.pid, logFile, removedStop };
}

/** Write the STOP file: the runner hands off (ticket 02), releases the ticket and exits. */
export async function writeStopFile(root) {
	await writeFile(join(root, "STOP"), `Stopped from shiftwork tui at ${new Date().toISOString()}\n`);
}
