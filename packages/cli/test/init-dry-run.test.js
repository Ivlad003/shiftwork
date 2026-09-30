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

test("run --dry-run prints each frontier ticket's route and spends nothing", async () => {
	const root = await repo({
		"f/01-git.md": t("01", "Commit it", "**Type:** git"),
		"f/02-code.md": t("02", "Build it"),
		"g/01-other.md": t("01", "Elsewhere", "**Type:** docs"),
	});
	await exec(["init", "--dir", root, "--model", "prov/model-a"]);

	const { stdout } = await exec(["run", "--dry-run", "--dir", root, "--feature", "f"]);

	assert.match(stdout, /f\/01 {2}type=git {2}tier=quick {2}model=prov\/model-a {2}thinking=low/);
	assert.match(stdout, /f\/02 {2}type=code \(default\) {2}tier=standard {2}model=prov\/model-a {2}thinking=medium/);
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
	assert.equal(formatDryRunLine({ feature: "f", number: "02", title: "Build it" }, { type: "git", typeSource: "jev", tier: "quick", model: "prov/model-a", thinking: "low" }), "f/02  type=git (jev)  tier=quick  model=prov/model-a  thinking=low  Build it");
});
