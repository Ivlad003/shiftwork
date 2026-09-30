import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCooldowns } from "../src/index.js";

test("cooldowns survive a new openCooldowns (runner restart)", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-cd-"));
	const until = new Date(Date.now() + 60_000).toISOString();
	await openCooldowns(root).add("anthropic", until, "rate");

	const again = openCooldowns(root);
	const active = await again.active();
	assert.equal(active.length, 1);
	assert.equal(active[0].provider, "anthropic");
	assert.equal(active[0].kind, "rate");
	assert.equal(active[0].until, until);
	assert.equal(again.path, join(root, ".pi", "shiftwork-state.json"));
});

test("active() hides expired cooldowns", async () => {
	const root = await mkdtemp(join(tmpdir(), "sw-cd-"));
	const store = openCooldowns(root);
	await store.add("openai", new Date("2020-01-01T00:00:00Z"), "quota");
	assert.deepEqual(await store.active(new Date("2026-01-01")), []);
});
