import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { cacheBinDir, CLI_BIN, ensureShiftworkOnPath } from "../src/cli-path.js";
import { runVerify } from "../src/verify.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));

test("ensureShiftworkOnPath prepends a cache bin whose shiftwork points at this CLI", async () => {
	const cache = await mkdtemp(join(tmpdir(), "sw-clipath-"));
	const env = { PATH: "/usr/bin:/bin", XDG_CACHE_HOME: cache };
	const { dir, dest, bin: linked } = ensureShiftworkOnPath({ env });

	assert.equal(dir, join(cache, "shiftwork", "bin"));
	assert.equal(dir, cacheBinDir(env));
	assert.equal(linked, CLI_BIN);
	assert.equal(env.PATH, `${dir}:/usr/bin:/bin`);
	const found = await promisify(execFile)("sh", ["-c", "command -v shiftwork"], { env, encoding: "utf8" });
	assert.equal(found.stdout.trim(), dest);
});

test("ensureShiftworkOnPath is idempotent when the cache dir is already first", async () => {
	const cache = await mkdtemp(join(tmpdir(), "sw-clipath-"));
	const env = { PATH: "/usr/bin", XDG_CACHE_HOME: cache };
	const first = ensureShiftworkOnPath({ env });
	const pathAfterFirst = env.PATH;
	const second = ensureShiftworkOnPath({ env });
	assert.equal(env.PATH, pathAfterFirst);
	assert.equal(second.dir, first.dir);
});

test("ensureShiftworkOnPath refreshes a symlink that points elsewhere", async () => {
	const cache = await mkdtemp(join(tmpdir(), "sw-clipath-"));
	const dir = join(cache, "shiftwork", "bin");
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, "shiftwork");
	const other = join(cache, "other.js");
	writeFileSync(other, "#!/usr/bin/env node\n");
	symlinkSync(other, dest);
	const env = { PATH: "/usr/bin:/bin", XDG_CACHE_HOME: cache };
	ensureShiftworkOnPath({ env, bin: CLI_BIN });
	const found = await promisify(execFile)("sh", ["-c", "command -v shiftwork && readlink \"$(command -v shiftwork)\""], {
		env,
		encoding: "utf8",
	});
	assert.match(found.stdout, new RegExp(`${CLI_BIN}$`, "m"));
});

test("after ensure, runVerify of shiftwork --version exits 0 with PATH stripped of any other shiftwork", async () => {
	const cache = await mkdtemp(join(tmpdir(), "sw-clipath-"));
	const cwd = await mkdtemp(join(tmpdir(), "sw-clipath-cwd-"));
	const nodeDir = dirname(process.execPath);
	const stripped = [nodeDir, "/usr/bin", "/bin"].join(":");
	const env = { PATH: stripped, XDG_CACHE_HOME: cache };
	ensureShiftworkOnPath({ env });
	const previous = { PATH: process.env.PATH, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
	process.env.PATH = env.PATH;
	process.env.XDG_CACHE_HOME = cache;
	try {
		const gate = await runVerify(["shiftwork --version"], cwd);
		assert.equal(gate.ok, true, gate.results[0]?.outputTail);
		assert.match(gate.results[0].outputTail, /0\.\d+/);
	} finally {
		process.env.PATH = previous.PATH;
		if (previous.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previous.XDG_CACHE_HOME;
	}
});

test("the CLI puts shiftwork on PATH before handling a command", async () => {
	const cache = await mkdtemp(join(tmpdir(), "sw-clipath-"));
	const nodeDir = dirname(process.execPath);
	const stripped = [nodeDir, "/usr/bin", "/bin"].join(":");
	const { stdout } = await promisify(execFile)(process.execPath, [bin, "--version"], {
		env: { ...process.env, PATH: stripped, XDG_CACHE_HOME: cache, PI_CODING_AGENT_DIR: cache },
		encoding: "utf8",
	});
	assert.match(stdout, /0\.\d+/);
	assert.equal(readlinkSync(join(cache, "shiftwork", "bin", "shiftwork")), CLI_BIN);
});
