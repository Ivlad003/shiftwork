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
		await mkdir(join(root, ".shiftwork"));
		await writeFile(join(root, ".shiftwork", "shiftwork.json"), JSON.stringify(project));
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
	await mkdir(join(root, ".shiftwork"));
	await writeFile(join(root, ".shiftwork", "shiftwork.json"), "{ nope");
	await assert.rejects(loadConfig(root, userDir), /\.shiftwork\/shiftwork\.json/);
});

test("a legacy repo's .pi/shiftwork.json is still read until it is migrated", async () => {
	const { root, userDir } = await dirs();
	await mkdir(join(root, ".pi"));
	await writeFile(join(root, ".pi", "shiftwork.json"), JSON.stringify({ model: "a/1", maxAttempts: 7 }));
	assert.equal((await loadConfig(root, userDir)).maxAttempts, 7);
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

test("review is on by default on the strongest configured tier; filters are arrays; `false` and `{ enabled: false }` opt out", async () => {
	// No review block and a full tier ladder: reviews on the strongest configured tier, before landing.
	const ladder = await dirs({ model: "a/1", tiers: { quick: { chain: ["a/1"] }, standard: { chain: ["a/1"] }, premium: { chain: ["a/1"] } } });
	assert.deepEqual((await loadConfig(ladder.root, ladder.userDir)).review, {
		enabled: true,
		tier: "premium",
		when: "before-land",
		maxRounds: 2,
		budget: { maxWallMin: 20, maxTurns: 60 },
	});
	// `when` accepts both orders; `resolve` is `after-land`'s old name and normalizes to it.
	const alias = await dirs({ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: { when: "resolve" } });
	assert.equal((await loadConfig(alias.root, alias.userDir)).review.when, "after-land");
	const when = await dirs({ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: { when: "before-land", maxRounds: 3 } });
	assert.deepEqual((await loadConfig(when.root, when.userDir)).review, {
		enabled: true,
		tier: "premium",
		when: "before-land",
		maxRounds: 3,
		budget: { maxWallMin: 20, maxTurns: 60 },
	});
	// The review's own budget: `review.budget` over its default, a `null` field lifts its default.
	const budgeted = await dirs({
		model: "a/1",
		tiers: { premium: { chain: ["a/1"] } },
		review: { budget: { maxTurns: 40, maxWallMin: null } },
	});
	const lifted = await loadConfig(budgeted.root, budgeted.userDir);
	assert.deepEqual(lifted.review.budget, { maxTurns: 40, maxWallMin: null });
	// `run` re-validates the validated config (with CLI overrides): the null lift must survive
	// that second pass, not silently come back as the 20-minute default.
	assert.deepEqual(validateConfig(lifted).review.budget, { maxTurns: 40, maxWallMin: null });

	// No premium: the strongest of what is configured.
	const standard = await dirs({ model: "a/1", tiers: { quick: { chain: ["a/1"] }, standard: { chain: ["a/1"] } } });
	assert.equal((await loadConfig(standard.root, standard.userDir)).review.tier, "standard");

	// No conventional tier at all: the first tier declared in `tiers`.
	const local = await dirs({ model: "a/1", tiers: { local: { chain: ["a/1"] } } });
	assert.equal((await loadConfig(local.root, local.userDir)).review.tier, "local");

	// No tiers at all: reviews stay off, with the reason why.
	const none = await dirs({ model: "a/1" });
	assert.deepEqual((await loadConfig(none.root, none.userDir)).review, {
		enabled: false,
		when: "before-land",
		maxRounds: 2,
		reason: "no tier to review on; set review.tier",
	});

	// Opt-out forms: both carry the same shape, everything off.
	const falseForm = await dirs({ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: false });
	assert.deepEqual((await loadConfig(falseForm.root, falseForm.userDir)).review, { enabled: false, when: "before-land", maxRounds: 2 });
	const disabledForm = await dirs({ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: { enabled: false } });
	assert.deepEqual((await loadConfig(disabledForm.root, disabledForm.userDir)).review, { enabled: false, when: "before-land", maxRounds: 2 });

	// An explicit tier wins over the default.
	const explicit = await dirs({ model: "a/1", tiers: { quick: { chain: ["a/1"] }, premium: { chain: ["a/1"] } }, review: { tier: "quick" } });
	assert.equal((await loadConfig(explicit.root, explicit.userDir)).review.tier, "quick");

	const good = await dirs({
		model: "a/1",
		tiers: { premium: { chain: ["a/1"] } },
		review: { enabled: true, tier: "premium", features: ["f"], types: ["code"] },
	});
	assert.deepEqual((await loadConfig(good.root, good.userDir)).review, {
		enabled: true,
		tier: "premium",
		when: "before-land",
		maxRounds: 2,
		features: ["f"],
		types: ["code"],
		budget: { maxWallMin: 20, maxTurns: 60 },
	});

	for (const [project, message] of [
		[{ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: { enabled: true, tier: "quick" } }, /review\.tier: unknown tier "quick"/],
		[{ model: "a/1", tiers: { premium: { chain: ["a/1"] } }, review: { tier: "nope" } }, /review\.tier: unknown tier "nope"/],
		[{ model: "a/1", review: { enabled: "yes" } }, /review\.enabled: must be true or false/],
		[{ model: "a/1", review: { when: "land" } }, /review\.when: must be one of before-land, after-land, resolve/],
		[{ model: "a/1", review: { maxRounds: 0 } }, /review\.maxRounds: must be a positive integer/],
		[{ model: "a/1", review: { maxRounds: "2" } }, /review\.maxRounds: must be a positive integer/],
		[{ model: "a/1", review: { maxRounds: 1.5 } }, /review\.maxRounds: must be a positive integer/],
		[{ model: "a/1", review: { strict: true } }, /review\.strict: unknown review field/],
		// `reason` is an output of checkReview only (why reviews are off with no tier), never an operator field.
		[{ model: "a/1", review: { reason: "hi" } }, /review\.reason: unknown review field/],
		[{ model: "a/1", review: { budget: "x" } }, /review\.budget: must be an object/],
		[{ model: "a/1", review: { budget: { maxTurns: -1 } } }, /review\.budget\.maxTurns: must be a non-negative finite number/],
		[{ model: "a/1", review: { features: "f" } }, /review\.features: must be an array of feature names/],
		[{ model: "a/1", review: { types: "code" } }, /review\.types: must be an array of ticket types/],
		[{ model: "a/1", review: "always" }, /review: must be an object, true or false/],
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

test("unlimited on a backend normalizes; unknown backends and limits fail with their path", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] } } };
	const config = validateConfig({ ...base, backends: { claude: { unlimited: ["turns", "time"] }, codex: { unlimited: true } } });
	assert.deepEqual(config.backends.claude.unlimited, ["maxTurns", "maxWallMin"]);
	assert.deepEqual(config.backends.codex.unlimited, [
		"maxTokens",
		"maxCostUsd",
		"maxTurns",
		"maxWallMin",
		"maxContextPct",
		"stallTurns",
	]);
	assert.throws(
		() => validateConfig({ ...base, backends: { nope: { unlimited: true } } }),
		/backends\.nope: unknown backend "nope"; expected one of pi, claude, codex, opencode, grok, cursor/,
	);
	assert.throws(
		() => validateConfig({ ...base, backends: { claude: { unlimited: ["speed"] } } }),
		/backends\.claude\.unlimited: unknown limit "speed"/,
	);
	assert.throws(
		() => validateConfig({ ...base, backends: { claude: { unlimited: true, extra: 1 } } }),
		/backends\.claude\.extra: unknown field; expected unlimited/,
	);
});

test("github is validated: defaults when absent, full block passes, bad values fail with their path", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] }, plan: { chain: ["a/2"] } } };
	assert.equal(validateConfig({ ...base }).github, undefined, "no github block → no github config");
	assert.deepEqual(validateConfig({ ...base, github: { labels: { in: "sw" } } }).github, {
		authors: [],
		labels: { in: "sw", working: "shiftwork:working", needsInfo: "shiftwork:needs-info", done: "shiftwork:done" },
		pollMin: 5,
		autoClose: true,
		push: false,
	}, "a github block fills its own defaults");

	const full = validateConfig({
		...base,
		github: {
			repo: "ivlad003/shiftwork",
			authors: ["octocat"],
			labels: { in: "sw", working: "sw:working", needsInfo: "sw:needs-info", done: "sw:done" },
			pollMin: 2,
			autoClose: false,
			push: true,
			planTier: "plan",
			gh: "/opt/gh",
		},
	});
	assert.deepEqual(full.github, {
		repo: "ivlad003/shiftwork",
		authors: ["octocat"],
		labels: { in: "sw", working: "sw:working", needsInfo: "sw:needs-info", done: "sw:done" },
		pollMin: 2,
		autoClose: false,
		push: true,
		planTier: "plan",
		gh: "/opt/gh",
	});

	const partial = validateConfig({ ...base, github: { repo: "ivlad003/shiftwork", labels: { in: "sw" } } });
	assert.equal(partial.github.autoClose, true, "autoClose defaults");
	assert.equal(partial.github.push, false, "push defaults");
	assert.equal(partial.github.pollMin, 5, "pollMin defaults");
	assert.equal(partial.github.planTier, undefined, "planTier stays optional");
	assert.equal(partial.github.gh, undefined, "gh defaults to gh on PATH");
	assert.deepEqual(
		partial.github.labels,
		{ in: "sw", working: "shiftwork:working", needsInfo: "shiftwork:needs-info", done: "shiftwork:done" },
		"labels.in is required, the others get their defaults",
	);

	const inLabels = { in: "sw" };
	for (const [project, message] of [
		[{ ...base, github: { repo: "shiftwork" } }, /github\.repo: must be "owner\/name"/],
		[{ ...base, github: { repo: "a/b/c" } }, /github\.repo: must be "owner\/name"/],
		// A github block without labels.in: the label that hands an issue to Shiftwork is required.
		[{ ...base, github: { repo: "a/b" } }, /github\.labels\.in: required: the label that hands an issue to Shiftwork \(see docs\/guide\.md "Dark-factory: labels"\)/],
		[{ ...base, github: {} }, /github\.labels\.in: required/],
		[{ ...base, github: { labels: { working: "sw:working" } } }, /github\.labels\.in: required/],
		[{ ...base, github: { pollMin: -1, labels: inLabels } }, /github\.pollMin: must be a number of minutes > 0/],
		[{ ...base, github: { pollMin: "5", labels: inLabels } }, /github\.pollMin: must be a number of minutes > 0/],
		[{ ...base, github: { planTier: "nope", labels: inLabels } }, /github\.planTier: unknown tier "nope"/],
		[{ ...base, github: { strict: true } }, /github\.strict: unknown github field/],
		[{ ...base, github: { authors: "octocat", labels: inLabels } }, /github\.authors: must be an array of GitHub logins/],
		[{ ...base, github: { labels: { in: "" } } }, /github\.labels\.in: must be a label name/],
		[{ ...base, github: { labels: { ...inLabels, working: "" } } }, /github\.labels\.working: must be a label name/],
		[{ ...base, github: { labels: { out: "x" } } }, /github\.labels\.out: unknown labels field/],
		[{ ...base, github: { autoClose: "yes", labels: inLabels } }, /github\.autoClose: must be true or false/],
		[{ ...base, github: { push: 1, labels: inLabels } }, /github\.push: must be true or false/],
		[{ ...base, github: { gh: 5, labels: inLabels } }, /github\.gh: must be a path to the gh binary/],
		[{ ...base, github: "on" }, /github: must be an object/],
	]) {
		assert.throws(() => validateConfig(project), message);
	}
});

test("github.planTier sets routing.plan unless the config already routes plan", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] }, plan: { chain: ["a/2"] } } };
	const routed = validateConfig({ ...base, github: { planTier: "plan", labels: { in: "sw" } } });
	assert.deepEqual(routed.routing.plan, { tier: "plan" });
	assert.deepEqual(routed.routing.code, { tier: "quick" }, "other routes stay");

	const own = validateConfig({
		...base,
		routing: { ...base.routing, plan: { model: "xai/grok-4.7" } },
		github: { planTier: "plan", labels: { in: "sw" } },
	});
	assert.deepEqual(own.routing.plan, { model: "xai/grok-4.7" }, "an existing plan route is kept");

	const plain = validateConfig({ ...base, github: { labels: { in: "sw" } } });
	assert.equal(plain.routing.plan, undefined, "no planTier: no plan route");
});

test("verifyTimeoutMin must be a positive number of minutes", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] } } };
	assert.equal(validateConfig({ ...base, verifyTimeoutMin: 20 }).verifyTimeoutMin, 20);
	assert.equal(validateConfig(base).verifyTimeoutMin, 10);
	assert.throws(() => validateConfig({ ...base, verifyTimeoutMin: 0 }), /verifyTimeoutMin/);
	assert.throws(() => validateConfig({ ...base, verifyTimeoutMin: "20m" }), /verifyTimeoutMin/);
});

test("landRetries defaults to 5; negative or non-integer fails", () => {
	const base = { routing: { code: { tier: "quick" } }, tiers: { quick: { chain: ["a/1"] } } };
	assert.equal(validateConfig(base).landRetries, 5);
	assert.equal(validateConfig({ ...base, landRetries: 0 }).landRetries, 0);
	assert.equal(validateConfig({ ...base, landRetries: 9 }).landRetries, 9);
	assert.throws(() => validateConfig({ ...base, landRetries: -1 }), /landRetries: must be a non-negative integer/);
	assert.throws(() => validateConfig({ ...base, landRetries: 2.5 }), /landRetries: must be a non-negative integer/);
	assert.throws(() => validateConfig({ ...base, landRetries: "5" }), /landRetries: must be a non-negative integer/);
});

test("maxLimitRetries defaults to 10 and must be a positive integer", () => {
	assert.equal(validateConfig({ model: "fake/m1" }).maxLimitRetries, 10);
	assert.equal(validateConfig({ model: "fake/m1", maxLimitRetries: 3 }).maxLimitRetries, 3);
	assert.throws(() => validateConfig({ model: "fake/m1", maxLimitRetries: 0 }), /maxLimitRetries/);
});

test("dual: absent stays absent; true/false and the object form are validated", () => {
	const base = { model: "a/1", tiers: { standard: { chain: ["a/1", "b/2"] }, premium: { chain: ["p/3"] } } };
	assert.equal(validateConfig(base).dual, undefined);
	assert.deepEqual(validateConfig({ ...base, dual: true }).dual, { enabled: true });
	assert.deepEqual(validateConfig({ ...base, dual: false }).dual, { enabled: false });
	const full = { enabled: true, types: ["code"], features: ["f"], tiers: ["standard", "premium"], mergeTier: "premium", budget: { maxTurns: 30 } };
	assert.deepEqual(validateConfig({ ...base, dual: full }).dual, full);
	assert.deepEqual(validateConfig({ ...base, dual: { enabled: true, models: ["a/1", "claude:sonnet"] } }).dual, { enabled: true, models: ["a/1", "claude:sonnet"] });
	// Re-validating a validated config round-trips it.
	assert.deepEqual(validateConfig(validateConfig({ ...base, dual: full })).dual, full);
	for (const [dual, error] of [
		["yes", /dual: must be an object, true or false/],
		[{ enabled: "yes" }, /dual\.enabled: must be true or false/],
		[{ pick: "best" }, /dual\.pick: unknown dual field/],
		[{ models: ["a/1"] }, /dual\.models: must be two model references/],
		[{ models: ["a/1", "nope"] }, /dual\.models\[1\]: expected "provider\/model"/],
		[{ tiers: ["standard", "quick"] }, /dual\.tiers\[1\]: unknown tier "quick"/],
		[{ models: ["a/1", "b/2"], tiers: ["standard", "premium"] }, /dual: set models or tiers, not both/],
		[{ mergeTier: "ultra" }, /dual\.mergeTier: unknown tier "ultra"/],
		[{ types: "code" }, /dual\.types: must be an array of ticket types/],
		[{ features: [""] }, /dual\.features: must be an array of feature names/],
		[{ budget: { maxTurns: -1 } }, /dual\.budget\.maxTurns: must be a non-negative finite number/],
	]) {
		assert.throws(() => validateConfig({ ...base, dual }), error);
	}
});

test("frozen: a list of globs, [] by default; anything else is refused", () => {
	assert.deepEqual(validateConfig({ model: "fake/m1" }).frozen, []);
	assert.deepEqual(validateConfig({ model: "fake/m1", frozen: ["packages/*/test/fixtures/**", "package.json"] }).frozen, [
		"packages/*/test/fixtures/**",
		"package.json",
	]);
	for (const frozen of ["package.json", [1], [""], { a: 1 }]) {
		assert.throws(() => validateConfig({ model: "fake/m1", frozen }), /frozen: must be an array of globs/);
	}
});
