import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The default command runner: `exec(args) → stdout`. `args` is a full argv
 * (binary first), run in `cwd`. One buffer for `gh` and `git` — paginated
 * issue lists and long logs. Callers inject their own `exec` in tests.
 *
 * @param {string} [cwd]
 * @returns {(args: string[]) => Promise<string>}
 */
export function execIn(cwd) {
	return async (args) => (await run(args[0], args.slice(1), { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
