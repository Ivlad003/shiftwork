import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateConfig } from "shiftwork-core";
import { dryRunFrontier, formatDryRunLine } from "../src/dry-run.js";

const bin = fileURLToPath(new URL("../bin/shiftwork.js", import.meta.url));
const exec = async (args, env = {}) => {
	const agentDir = await mkdtemp(join(tmpdir(), "sw-agent-"));
	return promisify(execFile)(process.execPath, [bin, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env } });
};

async function repo(tickets) {
	const root = await mkdtemp(join(tmpdir(), "sw-cli-"));
	for (const [rel, body] of Object.entries(tickets)) {
		const [feature, file] = rel.split("/");
		await mkdir(join(root, ".scratch", feature, "issues"), { recursive: true });
		await writeFile(join(root, ".scratch", feature, "issues", file), body);
	}
	return root;
}

const t = (n, title, extra = "") => `# ${n}: ${title}\n\n**Blocked by:** None (can start immediately)\n\n**Status:** ready-for-agent\n${extra}\n`;

test("init writes config, worker prompt and pi compaction settings, and keeps them on re-run", async () => {
	const root = await repo({});
	const { stdout: first } = await exec(["init", "--dir", root, "--model", "anthropic/m1"]);
	assert.match(first, /allowInPlace: true/);
	const config = JSON.parse(await readFile(join(root, ".pi", "shiftwork.json"), "utf8"));
	assert.equal(config.allowInPlace, false);
	assert.deepEqual(config.tiers.quick.chain, ["anthropic/m1"]);
	assert.match(await readFile(join(root, ".pi", "shiftwork-worker.md"), "utf8"), /Shiftwork worker/);
	assert.equal(JSON.parse(await readFile(join(root, ".pi", "settings.json"), "utf8")).compaction.reserveTokens, 16384);

	await writeFile(join(root, ".pi", "shiftwork.json"), "{\"model\":\"mine/kept\"}");
	const { stdout } = await exec(["init", "--dir", root]);
	assert.match(stdout, /kept .*shiftwork\.json/);
	assert.equal(await readFile(join(root, ".pi", "shiftwork.json"), "utf8"), "{\"model\":\"mine/kept\"}");
});

test("init keeps other pi settings", async () => {
	const root = await repo({});
	await mkdir(join(root, ".pi"));
	await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
	await exec(["init", "--dir", root, "--model", "a/b"]);
	const settings = JSON.parse(await readFile(join(root, ".pi", "settings.json"), "utf8"));
	assert.equal(settings.theme, "dark");
	assert.ok(settings.compaction);
});

test("run --no-budget lifts every limit and --no-limit only the named ones", async () => {
	const root = await repo({ "f/01-git.md": t("01", "Commit it", "**Type:** git\n**Budget:** $2 · 10 turns") });
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);

	const all = await exec(["run", "--dry-run", "--dir", root, "--no-budget"]);
	assert.match(all.stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low {2}budget=- /);

	const some = await exec(["run", "--dry-run", "--dir", root, "--no-limit", "turns,time"]);
	assert.match(some.stdout, /budget=\$2 · 60% ctx · 5 stall /);

	await assert.rejects(exec(["run", "--dry-run", "--dir", root, "--no-limit", "speed"]), /unknown limit "speed"/);
});

test("run --dry-run prints each frontier ticket's route and spends nothing", async () => {
	const root = await repo({
		"f/01-git.md": t("01", "Commit it", "**Type:** git"),
		"f/02-code.md": t("02", "Build it"),
		"g/01-other.md": t("01", "Elsewhere", "**Type:** docs"),
	});
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);

	const { stdout } = await exec(["run", "--dry-run", "--dir", root, "--feature", "f"]);

	assert.match(stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low {2}budget=\$8 · 40 turns · 45 min · 60% ctx · 5 stall/);
	assert.match(stdout, /f\/02 {2}type=code \(default\) {2}tier=standard {2}model=prov\/model-a {2}thinking=medium {2}budget=\$1\.5 · 3000000 tok · 60 turns · 45 min · 8 stall/);
	assert.doesNotMatch(stdout, /g\/01/);
});

test("run refuses a config with CHANGE-ME placeholders, naming the field", async () => {
	const root = await repo({ "f/01-a.md": t("01", "A") });
	await exec(["init", "--dir", root]);
	await assert.rejects(exec(["run", "--dry-run", "--dir", root]), (error) => /tiers\.quick\.chain\[0\]: replace the CHANGE-ME/.test(error.stderr));
});

test("a dry run shows type (jev) for classified tickets", async () => {
	const config = validateConfig({
		defaultType: "code",
		thinking: "medium",
		routing: { git: { tier: "quick", thinking: "low" }, code: { tier: "standard" } },
		tiers: {
			quick: { chain: ["prov/model-a"], thinking: "low" },
			standard: { chain: ["prov/model-a"] },
		},
	});
	const lines = [];
	await dryRunFrontier({
		tickets: [
			{ feature: "f", number: "01", title: "Commit it", type: "git", skills: [], verify: [], blockedBy: [] },
			{ feature: "f", number: "02", title: "Build it", skills: [], verify: [], blockedBy: [] },
		],
		config,
		classifyTicket: async () => ({ type: "git", complexity: "standard" }),
		log: (line) => lines.push(line),
	});
	assert.match(lines[0], /f\/01 {2}type=git {2}tier=quick/);
	assert.match(lines[1], /f\/02 {2}type=git \(jev\) {2}tier=quick {2}model=prov\/model-a {2}thinking=low/);
	assert.equal(formatDryRunLine({ feature: "f", number: "02", title: "Build it" }, { type: "git", typeSource: "jev", tier: "quick", model: "prov/model-a", thinking: "low" }), "f/02  type=git (jev)  tier=quick  model=prov/model-a  thinking=low  budget=-  Build it");
});

test("formatDryRunLine: a CLI model keeps its backend prefix", () => {
	const route = { type: "code", tier: "standard", backend: "claude", model: "sonnet", ref: "claude:sonnet", thinking: "medium" };
	assert.equal(formatDryRunLine({ feature: "f", number: "03", type: "code", title: "Build it" }, route), "f/03  type=code  tier=standard  model=claude:sonnet  thinking=medium  budget=-  Build it");
});

test("formatDryRunLine shows the effective budget", () => {
	assert.equal(
		formatDryRunLine(
			{ feature: "f", number: "01", title: "Build it", type: "code" },
			{ type: "code", tier: "standard", model: "prov/m", thinking: "medium", budget: { maxCostUsd: 1, maxTurns: 10, maxContextPct: 70 } },
		),
		"f/01  type=code  tier=standard  model=prov/m  thinking=medium  budget=$1 · 10 turns · 70% ctx  Build it",
	);
});

test("run --dry-run shows whether a ticket would be reviewed and on which tier", async () => {
	const root = await repo({
		"f/01-git.md": t("01", "Commit it", "**Type:** git"),
		"f/02-code.md": t("02", "Build it"),
	});
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);

	// No review block: reviews are on by default, on the strongest configured tier, before each ticket lands.
	const on = await exec(["run", "--dry-run", "--dir", root]);
	assert.match(on.stdout, /shiftwork: review · premium for every ticket/);
	assert.match(on.stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low {2}budget=[^\n]* {2}review=premium \(before land\) {2}Commit it/);
	assert.match(on.stdout, /f\/02 {2}type=code \(default\) {2}tier=standard {2}model=prov\/model-a {2}thinking=medium {2}budget=[^\n]* {2}review=premium \(before land\) {2}Build it/);

	// Filters narrow the reviews to some tickets only.
	const path = join(root, ".pi", "shiftwork.json");
	const config = JSON.parse(await readFile(path, "utf8"));
	config.review = { enabled: true, tier: "premium", types: ["git"] };
	await writeFile(path, JSON.stringify(config));

	const { stdout } = await exec(["run", "--dry-run", "--dir", root]);

	assert.match(stdout, /shiftwork: review · premium for types git/);
	assert.match(stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low {2}budget=[^\n]* {2}review=premium \(before land\) {2}Commit it/);
	assert.match(stdout, /f\/02 {2}type=code \(default\) {2}tier=standard {2}model=prov\/model-a {2}thinking=medium {2}budget=[^\n]* {2}review=no {2}Build it/);

	// `when: "after-land"` (or its old name "resolve") reviews after the landing instead.
	config.review = { enabled: true, tier: "premium", when: "after-land" };
	await writeFile(path, JSON.stringify(config));

	const after = await exec(["run", "--dry-run", "--dir", root]);

	assert.match(after.stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low {2}budget=[^\n]* {2}review=premium \(after land\) {2}Commit it/);
	assert.match(after.stdout, /f\/02 {2}type=code \(default\) {2}tier=standard {2}model=prov\/model-a {2}thinking=medium {2}budget=[^\n]* {2}review=premium \(after land\) {2}Build it/);
});

test("run --no-review turns the review column off for that run", async () => {
	const root = await repo({ "f/01-git.md": t("01", "Commit it", "**Type:** git") });
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);

	const { stdout } = await exec(["run", "--dry-run", "--dir", root, "--no-review"]);

	assert.match(stdout, /shiftwork: review off \(--no-review\)/);
	assert.match(stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low {2}budget=[^\n]* {2}Commit it/);
	assert.doesNotMatch(stdout, /review=/);
});

test("run says at start that reviews are off in the config", async () => {
	const root = await repo({ "f/01-git.md": t("01", "Commit it", "**Type:** git") });
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);
	const path = join(root, ".pi", "shiftwork.json");
	const config = JSON.parse(await readFile(path, "utf8"));
	config.review = false;
	await writeFile(path, JSON.stringify(config));

	const { stdout } = await exec(["run", "--dry-run", "--dir", root]);

	assert.match(stdout, /shiftwork: review off \(config\)/);
	assert.doesNotMatch(stdout, /review=/);
});

test("formatDryRunLine shows the review tier, no, or nothing when reviews are off", () => {
	const route = { type: "code", tier: "standard", model: "prov/m", thinking: "low" };
	const line = "type=code  tier=standard  model=prov/m  thinking=low  budget=-";
	assert.equal(
		formatDryRunLine({ feature: "f", number: "01", title: "Build it", type: "code" }, route, "premium"),
		`f/01  ${line}  review=premium  Build it`,
	);
	assert.equal(
		formatDryRunLine({ feature: "f", number: "02", title: "Build it", type: "code" }, route, "no"),
		`f/02  ${line}  review=no  Build it`,
	);
	assert.equal(
		formatDryRunLine({ feature: "f", number: "03", title: "Build it", type: "code" }, route),
		`f/03  ${line}  Build it`,
	);
});
