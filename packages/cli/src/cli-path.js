import { mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's `bin/shiftwork.js`. */
export const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "shiftwork.js");

/** Cache dir that holds the `shiftwork` symlink (`XDG_CACHE_HOME/shiftwork/bin` or `~/.cache/shiftwork/bin`). */
export function cacheBinDir(env = process.env) {
	return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "shiftwork", "bin");
}

/**
 * Put this CLI's `bin/shiftwork.js` on PATH as `shiftwork`, so `npx shiftwork`
 * children (`sh -c "shiftwork …"`) find the same binary this process is.
 * Mutates `env` (default `process.env`). Idempotent when `dir` is already first.
 *
 * @returns {{ dir: string, dest: string, bin: string }}
 */
export function ensureShiftworkOnPath({ env = process.env, bin = CLI_BIN } = {}) {
	const dir = cacheBinDir(env);
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, "shiftwork");
	linkShiftwork(dest, bin);
	const path = env.PATH ?? "";
	const parts = path.split(delimiter).filter(Boolean);
	if (parts[0] !== dir) env.PATH = path ? `${dir}${delimiter}${path}` : dir;
	return { dir, dest, bin };
}

function linkShiftwork(dest, bin) {
	try {
		if (readlinkSync(dest) === bin) return;
	} catch {
		// missing, or not a symlink
	}
	const tmp = `${dest}.${process.pid}`;
	try {
		unlinkSync(tmp);
	} catch {
		// no leftover
	}
	symlinkSync(bin, tmp);
	try {
		renameSync(tmp, dest);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// ignore
		}
		throw error;
	}
}
