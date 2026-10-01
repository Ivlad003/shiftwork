import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * Wrap a backend so every live shift is known: `abortAll()` aborts the shifts that have
 * not closed yet. Used on a signal, so agent processes don't outlive the runner.
 */
export function trackShifts(backend) {
	const live = new Set();
	return {
		...backend,
		async startShift(request) {
			const shift = await backend.startShift(request);
			live.add(shift);
			const forget = (fn) =>
				async (...args) => {
					try {
						return await fn?.apply(shift, args);
					} finally {
						live.delete(shift);
					}
				};
			shift.abort = forget(shift.abort);
			shift.close = forget(shift.close);
			return shift;
		},
		get liveShifts() {
			return live.size;
		},
		async abortAll() {
			await Promise.all([...live].map((shift) => shift.abort().catch(() => {})));
		},
	};
}

/**
 * Turn SIGINT/SIGTERM/SIGHUP into a stop. The first signal writes STOP, so the running
 * shifts hand off and the runner ends as after a STOP file; a second signal, or `graceMs`
 * without the runner finishing, aborts every live shift, kills running verify commands
 * and exits. A STOP file this created is removed again, so it doesn't stop the next run.
 */
export function installSignalStop({ root, abortShifts, killVerify, graceMs = 60_000, proc = process, exit = process.exit, log = console.error }) {
	const stopFile = join(root, "STOP");
	let createdStop = false;
	let received = 0;
	let timer;

	const removeStop = () => {
		if (!createdStop) return;
		createdStop = false;
		rmSync(stopFile, { force: true });
	};

	const force = async (signal) => {
		clearTimeout(timer);
		log(`shiftwork: ${signal}: aborting running shifts and exiting`);
		killVerify?.();
		await abortShifts?.();
		removeStop();
		exit(EXIT_CODES[signal] ?? 1);
	};

	const onSignal = (signal) => {
		received++;
		if (received > 1) {
			force(signal);
			return;
		}
		if (!existsSync(stopFile)) {
			writeFileSync(stopFile, `Stopped by ${signal} at ${new Date().toISOString()}\n`);
			createdStop = true;
		}
		log(`shiftwork: ${signal}: shifts hand off and the runner stops (send it again to stop at once)`);
		timer = setTimeout(() => force(signal), graceMs);
		timer.unref?.();
	};

	const handlers = SIGNALS.map((signal) => [signal, () => onSignal(signal)]);
	for (const [signal, handler] of handlers) proc.on(signal, handler);

	return {
		/** Remove the handlers and a STOP file this created. Call when the run ends. */
		dispose() {
			clearTimeout(timer);
			for (const [signal, handler] of handlers) proc.off(signal, handler);
			removeStop();
		},
	};
}
