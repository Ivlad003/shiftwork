import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isShiftworkFile, LEGACY_DIR, legacyFiles, SHIFTWORK_DIR, shiftworkPath, stateDir } from "../src/paths.js";

const tmp = () => mkdtemp(join(tmpdir(), "shiftwork-paths-"));
const quiet = { warn: () => {} };

test("a fresh repo resolves to .shiftwork/", async () => {
	const root = await tmp();
	assert.equal(SHIFTWORK_DIR, ".shiftwork");
	assert.equal(stateDir(root, quiet), join(root, ".shiftwork"));
	assert.equal(shiftworkPath(root, "shiftwork.json", quiet), join(root, ".shiftwork", "shiftwork.json"));
});

test("a repo with only pi's own files under .pi/ is still fresh", async () => {
	const root = await tmp();
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "settings.json"), "{}");
	assert.equal(stateDir(root, quiet), join(root, ".shiftwork"));
});

test("a legacy repo (Shiftwork files under .pi/) resolves to .pi/ and hints", async () => {
	const root = await tmp();
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "shiftwork-run.json"), "{}");
	const hints = [];
	assert.equal(stateDir(root, { warn: (m) => hints.push(m) }), join(root, LEGACY_DIR));
	assert.match(hints[0], /legacy \.pi\/.*shiftwork migrate/);
});

test("an existing .shiftwork/ wins over legacy files", async () => {
	const root = await tmp();
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "shiftwork.json"), "{}");
	await mkdir(join(root, ".shiftwork"));
	assert.equal(stateDir(root, quiet), join(root, ".shiftwork"));
});

test("the legacy hint goes to stderr once per process", async () => {
	const root = await tmp();
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "shiftwork.json"), "{}");
	const paths = fileURLToPath(new URL("../src/paths.js", import.meta.url));
	const script = `const { stateDir } = await import(${JSON.stringify(paths)}); stateDir(${JSON.stringify(root)}); stateDir(${JSON.stringify(root)});`;
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(run.stdout, "");
	assert.equal(run.stderr.match(/shiftwork migrate/g)?.length, 1);
});

test("Shiftwork's own files are told apart from pi's", async () => {
	for (const name of ["shiftwork.json", "shiftwork-worker.md", "shiftwork-run.json", "shiftwork-state.json", "shiftwork-github.json", "shiftwork.lock", "shiftwork-land.lock"]) {
		assert.ok(isShiftworkFile(name), name);
	}
	for (const name of ["settings.json", "skills", "prompts", "agent", "shiftworkish.txt"]) assert.ok(!isShiftworkFile(name), name);
	const root = await tmp();
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "settings.json"), "{}");
	await writeFile(join(root, ".pi", "shiftwork.json"), "{}");
	assert.deepEqual(legacyFiles(root), ["shiftwork.json"]);
});
