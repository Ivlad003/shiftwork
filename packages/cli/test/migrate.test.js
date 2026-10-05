import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { migrate } from "../src/migrate.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));

/** A legacy repo: Shiftwork's files plus pi's own settings under `.pi/`. */
async function legacyRepo(runState) {
	const root = await mkdtemp(join(tmpdir(), "sw-migrate-"));
	await mkdir(join(root, ".pi", "skills"), { recursive: true });
	await writeFile(join(root, ".pi", "settings.json"), "{}");
	await writeFile(join(root, ".pi", "shiftwork.json"), '{"model":"a/b"}');
	await writeFile(join(root, ".pi", "shiftwork-worker.md"), "worker");
	await writeFile(join(root, ".pi", "shiftwork-run.json"), JSON.stringify(runState ?? { runners: [{ pid: 1, running: false }] }));
	return root;
}

function capture() {
	const out = [];
	const err = [];
	return { out, err, log: (l) => out.push(l), error: (l) => err.push(l) };
}

test("migrate --dry-run prints the moves and changes nothing", async () => {
	const root = await legacyRepo();
	const io = capture();
	assert.equal(await migrate(["--dry-run", "--dir", root], io), 0);
	assert.deepEqual(io.out.slice(0, 3), [
		"would move .pi/shiftwork-run.json → .shiftwork/shiftwork-run.json",
		"would move .pi/shiftwork-worker.md → .shiftwork/shiftwork-worker.md",
		"would move .pi/shiftwork.json → .shiftwork/shiftwork.json",
	]);
	assert.equal(existsSync(join(root, ".shiftwork")), false);
	assert.equal(existsSync(join(root, ".pi", "shiftwork.json")), true);
});

test("migrate moves Shiftwork's files to .shiftwork/ and leaves pi's own in .pi/", async () => {
	const root = await legacyRepo();
	const io = capture();
	assert.equal(await migrate(["--dir", root], io), 0);
	assert.ok(io.out.includes("moved .pi/shiftwork.json → .shiftwork/shiftwork.json"), io.out.join("\n"));
	assert.equal(await readFile(join(root, ".shiftwork", "shiftwork.json"), "utf8"), '{"model":"a/b"}');
	assert.equal(existsSync(join(root, ".shiftwork", "shiftwork-worker.md")), true);
	assert.equal(existsSync(join(root, ".shiftwork", "shiftwork-run.json")), true);
	assert.equal(existsSync(join(root, ".pi", "shiftwork.json")), false);
	assert.equal(existsSync(join(root, ".pi", "settings.json")), true, "pi's settings stay");
	assert.equal(existsSync(join(root, ".pi", "skills")), true, "pi's skills stay");
});

test("migrate is idempotent and skips files already in .shiftwork/", async () => {
	const root = await legacyRepo();
	await mkdir(join(root, ".shiftwork"));
	await writeFile(join(root, ".shiftwork", "shiftwork.json"), '{"model":"new/one"}');
	const io = capture();
	assert.equal(await migrate(["--dir", root], io), 0);
	assert.ok(io.out.some((l) => /^skip .*shiftwork\.json \(already in \.shiftwork\/\)/.test(l)), io.out.join("\n"));
	assert.equal(await readFile(join(root, ".shiftwork", "shiftwork.json"), "utf8"), '{"model":"new/one"}', "the new file wins");
	assert.equal(existsSync(join(root, ".pi", "shiftwork.json")), true, "the skipped legacy file is left in place");

	const again = capture();
	assert.equal(await migrate(["--dir", root], again), 0);
	assert.ok(!again.out.some((l) => l.startsWith("moved")), again.out.join("\n"));
});

test("migrate on a repo without legacy files has nothing to do", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-migrate-"));
	const io = capture();
	assert.equal(await migrate(["--dir", root], io), 0);
	assert.match(io.out.join("\n"), /nothing to migrate/);
});

test("migrate refuses while a runner is live", async () => {
	const root = await legacyRepo({ runners: [{ pid: process.pid, running: true }] });
	const io = capture();
	assert.equal(await migrate(["--dir", root], io), 1);
	assert.match(io.err.join("\n"), new RegExp(`runner pid ${process.pid} is live`));
	assert.equal(existsSync(join(root, ".pi", "shiftwork.json")), true);
	assert.equal(existsSync(join(root, ".shiftwork")), false);
});

test("shiftwork migrate is wired into the CLI and its help", async () => {
	const root = await legacyRepo();
	const { stdout } = await promisify(execFile)(process.execPath, [bin, "migrate", "--dir", root]);
	assert.match(stdout, /moved \.pi\/shiftwork\.json → \.shiftwork\/shiftwork\.json/);
	const help = await promisify(execFile)(process.execPath, [bin, "help"]);
	assert.match(help.stdout, /shiftwork migrate \[--dry-run\]/);
});
