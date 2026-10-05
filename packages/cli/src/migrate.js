import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LEGACY_DIR, legacyFiles, SHIFTWORK_DIR } from "shiftwork-core";

/**
 * `shiftwork migrate [--dry-run] [--dir <path>]` (GitHub #14): move Shiftwork's own files
 * (`shiftwork.json`, `shiftwork-*.json|md`, locks) from `.pi/` to `.shiftwork/`. pi's own
 * files (`settings.json`, `skills/`, `prompts/`, …) stay in `.pi/`. A file already in
 * `.shiftwork/` is skipped, never overwritten. Refused (exit 1) while a runner is live.
 * Returns the exit code.
 */
export async function migrate(argv, { log = console.log, error = console.error } = {}) {
	const { values } = parseArgs({ args: argv, options: { dir: { type: "string" }, "dry-run": { type: "boolean" } } });
	const root = resolve(values.dir ?? process.cwd());
	const dryRun = Boolean(values["dry-run"]);

	const live = liveRunnerPids(root);
	if (live.length) {
		error(`shiftwork migrate: runner pid ${live.join(", ")} is live; stop it first ("shiftwork stop --wait")`);
		return 1;
	}

	const files = legacyFiles(root);
	if (!files.length) {
		log(`nothing to migrate: no Shiftwork files under ${LEGACY_DIR}/`);
		return 0;
	}
	if (!dryRun) await mkdir(join(root, SHIFTWORK_DIR), { recursive: true });
	let moved = 0;
	for (const name of files) {
		const from = `${LEGACY_DIR}/${name}`;
		const to = `${SHIFTWORK_DIR}/${name}`;
		if (existsSync(join(root, to))) {
			log(`skip   ${from} (already in ${SHIFTWORK_DIR}/)`);
			continue;
		}
		if (dryRun) {
			log(`would move ${from} → ${to}`);
			continue;
		}
		await rename(join(root, from), join(root, to));
		log(`moved ${from} → ${to}`);
		moved++;
	}
	if (!dryRun) log(`${moved} file${moved === 1 ? "" : "s"} moved; pi's own files stay in ${LEGACY_DIR}/`);
	return 0;
}

/** Live runner pids recorded in either run-state file (`.pi/` or `.shiftwork/`). */
function liveRunnerPids(root) {
	const pids = new Set();
	for (const dir of [LEGACY_DIR, SHIFTWORK_DIR]) {
		let state;
		try {
			state = JSON.parse(readFileSync(join(root, dir, "shiftwork-run.json"), "utf8"));
		} catch {
			continue;
		}
		const runners = Array.isArray(state?.runners) ? state.runners : state ? [state] : [];
		for (const r of runners) if (r?.running && r.pid && isAlive(r.pid)) pids.add(r.pid);
	}
	return [...pids];
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
