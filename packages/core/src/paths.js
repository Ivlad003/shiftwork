import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Where Shiftwork keeps its own per-repo files: config, worker prompt, run state, cooldowns, locks. */
export const SHIFTWORK_DIR = ".shiftwork";
/** Where those files lived before: pi's project dir, still read in legacy mode. */
export const LEGACY_DIR = ".pi";

export const LEGACY_HINT = 'shiftwork: using legacy .pi/ — run "shiftwork migrate" to move to .shiftwork/';

let hinted = false;
function hintOnce(message) {
	if (hinted) return;
	hinted = true;
	process.stderr.write(`${message}\n`);
}

/**
 * Whether a file name is Shiftwork's own (`shiftwork.json`, `shiftwork-*.json|md`,
 * `shiftwork.lock`, `shiftwork-<name>.lock`), as opposed to pi's (`settings.json`,
 * `skills/`, `prompts/`, …) which stays in `.pi/`.
 */
export function isShiftworkFile(name) {
	return /^shiftwork(\.json|\.lock|-[^/]+\.(json|md|lock))$/.test(name);
}

/** Shiftwork's own files still under `<root>/.pi/`, sorted. */
export function legacyFiles(root) {
	try {
		return readdirSync(join(root, LEGACY_DIR)).filter(isShiftworkFile).sort();
	} catch {
		return [];
	}
}

/**
 * The repo's Shiftwork directory: `<root>/.shiftwork/` when it exists; else `<root>/.pi/`
 * when Shiftwork files are still there (legacy mode — a one-time stderr hint per process
 * points at `shiftwork migrate`); else `<root>/.shiftwork/` for a fresh repo.
 * `warn` replaces the once-per-process stderr hint (tests).
 */
export function stateDir(root, { warn = hintOnce } = {}) {
	const dir = join(root, SHIFTWORK_DIR);
	if (existsSync(dir)) return dir;
	if (legacyFiles(root).length) {
		warn(LEGACY_HINT);
		return join(root, LEGACY_DIR);
	}
	return dir;
}

/** A Shiftwork file under the repo's Shiftwork directory (see `stateDir`). */
export function shiftworkPath(root, name, options) {
	return join(stateDir(root, options), name);
}
