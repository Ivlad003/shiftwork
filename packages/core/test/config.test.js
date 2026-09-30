import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/index.js";

async function dirs(project, user) {
	const root = await mkdtemp(join(tmpdir(), "sw-cfg-"));
	const userDir = await mkdtemp(join(tmpdir(), "sw-cfg-user-"));
	if (project) {
		await mkdir(join(root, ".pi"));
		await writeFile(join(root, ".pi", "shiftwork.json"), JSON.stringify(project));
	}
	if (user) await writeFile(join(userDir, "shiftwork.json"), JSON.stringify(user));
	return { root, userDir };
}

test("project config is merged over user config; arrays are replaced, objects merged", async () => {
	const { root, userDir } = await dirs(
		{ tiers: { quick: { chain: ["b/2"] } }, maxAttempts: 5 },
		{ thinking: "low", defaultTier: "quick", tiers: { quick: { chain: ["a/1"], thinking: "minimal" } }, routing: { git: { tier: "quick" } } },
	);

	const config = await loadConfig(root, userDir);

	assert.deepEqual(config.tiers.quick, { chain: ["b/2"], thinking: "minimal" });
	assert.equal(config.thinking, "low");
	assert.equal(config.maxAttempts, 5);
	assert.equal(config.routing.git.tier, "quick");
});

test("an invalid project file names the file and the field", async () => {
	const { root, userDir } = await dirs({ tiers: { quick: { chain: "x/1" } } });
	await assert.rejects(loadConfig(root, userDir), /shiftwork\.json.*tiers\.quick\.chain: must be a non-empty array/s);
});

test("broken JSON names the file", async () => {
	const { root, userDir } = await dirs();
	await mkdir(join(root, ".pi"));
	await writeFile(join(root, ".pi", "shiftwork.json"), "{ nope");
	await assert.rejects(loadConfig(root, userDir), /\.pi\/shiftwork\.json/);
});
