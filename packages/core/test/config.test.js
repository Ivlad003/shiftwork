import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, validateConfig } from "../src/index.js";

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

test("tracker and openspec.verify are validated", async () => {
	const good = await dirs({ model: "a/1", tracker: "openspec", openspec: { verify: ["make check"] } });
	const config = await loadConfig(good.root, good.userDir);
	assert.equal(config.tracker, "openspec");
	assert.deepEqual(config.openspec.verify, ["make check"]);

	const badTracker = await dirs({ model: "a/1", tracker: "jira" });
	await assert.rejects(loadConfig(badTracker.root, badTracker.userDir), /tracker: must be "scratch" or "openspec"/);

	const badVerify = await dirs({ model: "a/1", openspec: { verify: "npm test" } });
	await assert.rejects(loadConfig(badVerify.root, badVerify.userDir), /openspec\.verify: must be an array of shell commands/);

	const badField = await dirs({ model: "a/1", openspec: { strict: true } });
	await assert.rejects(loadConfig(badField.root, badField.userDir), /openspec\.strict: unknown openspec field/);
});

test("review is validated: off by default, tier required when enabled, filters are arrays", async () => {
	const off = await dirs({ model: "a/1" });
	assert.deepEqual((await loadConfig(off.root, off.userDir)).review, { enabled: false, when: "resolve" });

	const good = await dirs({
		model: "a/1",
		tiers: { premium: { chain: ["a/1"] } },
		review: { enabled: true, tier: "premium", features: ["f"], types: ["code"] },
	});
	assert.deepEqual((await loadConfig(good.root, good.userDir)).review, {
		enabled: true,
		tier: "premium",
		when: "resolve",
		features: ["f"],
		types: ["code"],
	});

	for (const [project, message] of [
		[{ model: "a/1", review: { enabled: true } }, /review\.tier: required when review\.enabled is true/],
		[{ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: { enabled: true, tier: "quick" } }, /review\.tier: unknown tier "quick"/],
		[{ model: "a/1", review: { enabled: "yes" } }, /review\.enabled: must be true or false/],
		[{ model: "a/1", review: { when: "land" } }, /review\.when: must be one of resolve/],
		[{ model: "a/1", review: { strict: true } }, /review\.strict: unknown review field/],
		[{ model: "a/1", review: { features: "f" } }, /review\.features: must be an array of feature names/],
		[{ model: "a/1", review: { types: "code" } }, /review\.types: must be an array of ticket types/],
		[{ model: "a/1", review: "always" }, /review: must be an object/],
	]) {
		const bad = await dirs(project);
		await assert.rejects(loadConfig(bad.root, bad.userDir), message);
	}
});

test("parallel and concurrency are validated: > 1 needs worktree.enabled, caps are positive integers", async () => {
	const defaults = await dirs({ model: "a/1" });
	assert.equal((await loadConfig(defaults.root, defaults.userDir)).parallel, 1);

	const good = await dirs({ model: "a/1", worktree: { enabled: true }, parallel: 2, concurrency: { a: 1, "claude:anthropic": 3 } });
	const config = await loadConfig(good.root, good.userDir);
	assert.equal(config.parallel, 2);
	assert.deepEqual(config.concurrency, { a: 1, "claude:anthropic": 3 });

	for (const [project, message] of [
		[{ model: "a/1", parallel: 2 }, /parallel: parallel > 1 requires worktree\.enabled/],
		[{ model: "a/1", worktree: { enabled: false }, parallel: 2 }, /parallel: parallel > 1 requires worktree\.enabled/],
		[{ model: "a/1", parallel: 0 }, /parallel: must be a positive integer/],
		[{ model: "a/1", parallel: "2" }, /parallel: must be a positive integer/],
		[{ model: "a/1", worktree: { enabled: true }, parallel: 2, concurrency: { a: 0 } }, /concurrency\.a: must be a positive integer/],
		[{ model: "a/1", worktree: { enabled: true }, parallel: 2, concurrency: { a: 1.5 } }, /concurrency\.a: must be a positive integer/],
		[{ model: "a/1", worktree: { enabled: true }, parallel: 2, concurrency: "a" }, /concurrency: must be an object of provider → max shifts at once/],
	]) {
		const bad = await dirs(project);
		await assert.rejects(loadConfig(bad.root, bad.userDir), message);
	}
});

test("unlimited on a tier and a model profile normalizes to budget field names", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] }, standard: { chain: ["a/2"] } } };
	const config = validateConfig({
		...base,
		tiers: { quick: { chain: ["a/1"], unlimited: ["turns", "time"] }, standard: { chain: ["a/2"] } },
		models: { "a/1": { unlimited: true } },
	});
	assert.deepEqual(config.tiers.quick.unlimited, ["maxTurns", "maxWallMin"]);
	assert.equal(config.tiers.standard.unlimited, undefined, "absent when not set");
	assert.deepEqual(config.models["a/1"].unlimited, ["maxTokens", "maxCostUsd", "maxTurns", "maxWallMin", "maxContextPct", "stallTurns"]);

	assert.throws(
		() => validateConfig({ ...base, tiers: { quick: { chain: ["a/1"], unlimited: ["speed"] } } }),
		/tiers\.quick\.unlimited: unknown limit "speed"/,
	);
	assert.throws(
		() => validateConfig({ ...base, models: { "a/1": { unlimited: "yes" } } }),
		/models\.a\/1\.unlimited: must be true or a list of limits/,
	);
});

test("github is validated: defaults when absent, full block passes, bad values fail with their path", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] }, plan: { chain: ["a/2"] } } };
	assert.deepEqual(validateConfig({ ...base }).github, { authors: [], pollMin: 5, autoClose: true, push: false });

	const full = validateConfig({
		...base,
		github: {
			repo: "ivlad003/shiftwork",
			authors: ["octocat"],
			labels: { in: "sw" },
			pollMin: 2,
			autoClose: false,
			push: true,
			planTier: "plan",
		},
	});
	assert.deepEqual(full.github, {
		repo: "ivlad003/shiftwork",
		authors: ["octocat"],
		labels: { in: "sw" },
		pollMin: 2,
		autoClose: false,
		push: true,
		planTier: "plan",
	});

	const partial = validateConfig({ ...base, github: { repo: "ivlad003/shiftwork", labels: { in: "sw" } } });
	assert.equal(partial.github.autoClose, true, "autoClose defaults");
	assert.equal(partial.github.push, false, "push defaults");
	assert.equal(partial.github.pollMin, 5, "pollMin defaults");
	assert.equal(partial.github.planTier, undefined, "planTier stays optional");

	for (const [project, message] of [
		[{ ...base, github: { repo: "shiftwork" } }, /github\.repo: must be "owner\/name"/],
		[{ ...base, github: { repo: "a/b/c" } }, /github\.repo: must be "owner\/name"/],
		[{ ...base, github: { pollMin: -1 } }, /github\.pollMin: must be a number of minutes > 0/],
		[{ ...base, github: { pollMin: "5" } }, /github\.pollMin: must be a number of minutes > 0/],
		[{ ...base, github: { planTier: "nope" } }, /github\.planTier: unknown tier "nope"/],
		[{ ...base, github: { strict: true } }, /github\.strict: unknown github field/],
		[{ ...base, github: { authors: "octocat" } }, /github\.authors: must be an array of GitHub logins/],
		[{ ...base, github: { labels: { in: "" } } }, /github\.labels\.in: must be a label name/],
		[{ ...base, github: { labels: { out: "x" } } }, /github\.labels\.out: unknown labels field/],
		[{ ...base, github: { autoClose: "yes" } }, /github\.autoClose: must be true or false/],
		[{ ...base, github: { push: 1 } }, /github\.push: must be true or false/],
		[{ ...base, github: "on" }, /github: must be an object/],
	]) {
		assert.throws(() => validateConfig(project), message);
	}
});

test("verifyTimeoutMin must be a positive number of minutes", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] } } };
	assert.equal(validateConfig({ ...base, verifyTimeoutMin: 20 }).verifyTimeoutMin, 20);
	assert.equal(validateConfig(base).verifyTimeoutMin, 10);
	assert.throws(() => validateConfig({ ...base, verifyTimeoutMin: 0 }), /verifyTimeoutMin/);
	assert.throws(() => validateConfig({ ...base, verifyTimeoutMin: "20m" }), /verifyTimeoutMin/);
});
