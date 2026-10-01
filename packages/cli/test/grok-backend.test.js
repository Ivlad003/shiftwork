import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createGrokBackend, createGrokMapper } from "../src/grok-backend.js";

async function withFakeGrok(script) {
	const binDir = await mkdtemp(join(tmpdir(), "sw-grok-bin-"));
	const grokPath = join(binDir, "grok");
	await writeFile(
		grokPath,
		`#!/usr/bin/env node
const script = ${JSON.stringify(script)};
for (const line of script) console.log(JSON.stringify(line));
`,
	);
	await chmod(grokPath, 0o755);
	return { binDir, cleanup: () => rm(binDir, { recursive: true, force: true }) };
}

async function shiftWith({ script, env = {}, route = { model: "grok-4.7" }, skills = { paths: [], preload: [], restricted: false } } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-"));
	const { binDir, cleanup } = await withFakeGrok(script);
	const backend = createGrokBackend({ command: "grok", env: { PATH: `${binDir}:${process.env.PATH}`, ...env } });
	const shift = await backend.startShift({
		cwd,
		route: { ...route, skills },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	for await (const event of shift.events) {
		events.push(event);
		if (event.type === "end") break;
	}
	await shift.close?.();
	await cleanup();
	return { cwd, events, shift };
}

const recorded = readFileSync(new URL("./fixtures/grok-stream.jsonl", import.meta.url), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

test("a recorded real Grok transcript maps to two turns, the reply text, the cost and a clean end", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({ script: recorded });

	const turns = events.filter((e) => e.type === "turn");
	assert.equal(turns.length, 2, "one turn per assistant message (usage event), not per line");
	assert.deepEqual(turns[0].usage, { input: 20636, output: 127, totalTokens: 20763 }, "input includes cache, output includes reasoning");
	assert.deepEqual(turns[1].usage, { input: 20748, output: 39, totalTokens: 20787 });
	assert.ok(events.some((e) => e.type === "text" && /create `hello\.txt`/.test(e.text)), "first assistant message reassembled from chunks");
	assert.ok(events.some((e) => e.type === "text" && /DONE/.test(e.text)));
	assert.deepEqual(events.find((e) => e.type === "cost"), { type: "cost", costUsd: 0.01633972 }, "cost reported once, at the end");
	assert.ok(events.some((e) => e.type === "context" && e.tokens === 20636));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	assert.equal(events.filter((e) => e.type === "end").length, 1);
});

test("a plan-limit error cools grok and is reported as an error event", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [{ type: "error", message: "You hit your weekly limit. Upgrade to a higher tier for more usage." }],
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /weekly limit/i);
	const { classifyError } = await import("shiftwork-core");
	assert.equal(classifyError(error.message)?.kind, "usage");
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" }, "grok exits 0 even on a fatal error");
});

test("a missing grok binary returns an error shift that ends immediately", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-missing-"));
	const emptyBin = await mkdtemp(join(tmpdir(), "sw-empty-bin-"));
	const backend = createGrokBackend({ command: "grok", env: { PATH: emptyBin } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "grok-4.7", skills: { paths: [], preload: [], restricted: false } },
		prompt: "Do the ticket.",
		systemPrompt: "You are a test worker.",
	});
	const events = [];
	for await (const event of shift.events) {
		events.push(event);
		if (event.type === "end") break;
	}

	assert.ok(events.some((e) => e.type === "error" && /command not found/.test(e.message)));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "error" });
	assert.ok(shift.warnings.some((w) => /not available/.test(w)));
});

/** Runs a shift against a fake grok that records its arguments; returns the `-p` prompt, the `--rules` text and all args. */
async function recordedRun({ cwd, skills = { paths: [], preload: [], restricted: false }, systemPrompt = "Worker prompt.", prompt = "Do the ticket.", thinking, model = "grok-4.7", modelsCache }) {
	const binDir = await mkdtemp(join(tmpdir(), "sw-grok-bin-"));
	const grokPath = join(binDir, "grok");
	await writeFile(
		grokPath,
		`#!/usr/bin/env node
require("fs").writeFileSync(process.env.SHIFTWORK_RECORD_ARGS ?? "missing", JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
	);
	await chmod(grokPath, 0o755);

	const record = join(cwd, "shiftwork-args.json");
	const backend = createGrokBackend({ command: "grok", modelsCache, env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_ARGS: record } });
	const shift = await backend.startShift({ cwd, route: { model, skills, thinking }, systemPrompt, prompt });
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();
	await rm(binDir, { recursive: true, force: true });
	const args = JSON.parse(await readFile(record, "utf8"));
	const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
	return { args, prompt: after("-p"), rules: after("--rules") };
}

test("the worker prompt and preloaded skills go to grok's system prompt (--rules); -p is only the ticket", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-grok-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "---\nname: alpha\n---\nAlpha preloaded body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-preload-"));
	const { prompt, rules } = await recordedRun({ cwd, skills: { paths: [skill], preload: [skill], restricted: true } });
	assert.match(rules, /Worker prompt\./);
	assert.match(rules, /Alpha preloaded body\./);
	assert.equal(prompt, "Do the ticket.");
});

test("AGENTS.md in the cwd lands in --rules after the worker prompt", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-agents-"));
	await writeFile(join(cwd, "AGENTS.md"), "The project codeword is PELICAN.");

	const { rules, prompt } = await recordedRun({ cwd });
	const worker = rules.indexOf("Worker prompt.");
	const instructions = rules.indexOf("# Project instructions (AGENTS.md)");
	const codeword = rules.indexOf("The project codeword is PELICAN.");
	assert.ok(worker >= 0 && instructions > worker && codeword > instructions, rules);
	assert.ok(!prompt.includes("PELICAN"), prompt);
});

test("CLAUDE.md is used when AGENTS.md is absent, and a line that is exactly @<path> expands one level deep", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-claude-"));
	await writeFile(join(cwd, "CLAUDE.md"), "@NOTES.md");
	await writeFile(join(cwd, "NOTES.md"), "Nested instructions.");

	const { rules } = await recordedRun({ cwd });
	assert.match(rules, /# Project instructions \(CLAUDE\.md\)/);
	assert.match(rules, /Nested instructions\./);
	assert.ok(!rules.includes("@NOTES.md"), rules);
});

test("a CLAUDE.md @import that is missing is kept as a line, and no instruction files leaves only the worker prompt", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-none-"));
	const bare = await recordedRun({ cwd });
	assert.equal(bare.rules, "Worker prompt.");

	await writeFile(join(cwd, "CLAUDE.md"), "@AGENTS.md");
	const dangling = await recordedRun({ cwd });
	assert.match(dangling.rules, /# Project instructions \(CLAUDE\.md\)\n\n@AGENTS\.md/);
});

test("thinking becomes --reasoning-effort, clamped to the levels the model offers", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-effort-"));
	const modelsCache = join(cwd, "models_cache.json");
	const menu = (ids) => ({ info: { supports_reasoning_effort: true, reasoning_efforts: ids.map((id) => ({ id, value: id })) } });
	await writeFile(modelsCache, JSON.stringify({ models: { "grok-4.7": menu(["xhigh", "high", "medium", "low"]), "grok-4.5": menu(["high", "medium", "low"]) } }));
	const effort = async (thinking, model = "grok-4.7") => {
		const { args } = await recordedRun({ cwd, thinking, model, modelsCache });
		return args.includes("--reasoning-effort") ? args[args.indexOf("--reasoning-effort") + 1] : undefined;
	};
	assert.equal(await effort("medium"), "medium");
	assert.equal(await effort("minimal"), "low");
	assert.equal(await effort("off"), "low");
	assert.equal(await effort("max"), "xhigh");
	assert.equal(await effort("xhigh", "grok-4.5"), "high");
	assert.equal(await effort("medium", "grok-unknown"), undefined, "a model not in the cache gets grok's default");
	assert.equal(await effort(undefined), undefined);
});

test("restricted skills are delivered as symlinks in .agents/skills and excluded from git", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-grok-link-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "Skill body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-grok-links-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-grok-bin-"));
	const grokPath = join(binDir, "grok");
	await writeFile(
		grokPath,
		`#!/usr/bin/env node
console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
	);
	await chmod(grokPath, 0o755);

	const { execFileSync } = await import("node:child_process");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });

	const backend = createGrokBackend({ command: "grok", env: { PATH: `${binDir}:${process.env.PATH}` } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "grok-4.7", skills: { paths: [skill], preload: [], restricted: true } },
		prompt: "Do the ticket.",
		systemPrompt: "sys",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	const symlinkPath = join(cwd, ".agents", "skills", basename(skill));
	assert.ok(existsSync(symlinkPath), "symlink exists in .agents/skills");
	assert.equal(await readFile(join(symlinkPath, "SKILL.md"), "utf8"), "Skill body.");
	const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf8");
	assert.match(exclude, /^\.agents\/skills\/$/m);
});

test("the Grok mapper counts one turn per usage event, flushes text and ignores noise", () => {
	const map = createGrokMapper();
	assert.deepEqual(map({ type: "available_commands", tools: ["write"], commands: [] }), []);
	assert.deepEqual(map({ type: "tool_call", toolCallId: "t1", toolName: "write" }), []);
	assert.deepEqual(map({ type: "text", data: "Hel" }), []);
	assert.deepEqual(map({ type: "text", data: "lo" }), []);
	assert.deepEqual(map({ type: "usage", usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, reasoning_tokens: 2 } }), [
		{ type: "text", text: "Hello" },
		{ type: "turn", model: undefined, usage: { input: 160, output: 7, totalTokens: 167 }, costUsd: 0 },
		{ type: "context", tokens: 160 },
	]);
	assert.deepEqual(map({ type: "error", message: "You hit your weekly limit." }), [{ type: "error", message: "You hit your weekly limit." }]);
	assert.deepEqual(map({ type: "end", stopReason: "end_turn", num_turns: 1, total_cost_usd: 0.01 }), [
		{ type: "cost", costUsd: 0.01 },
		{ type: "end", stopReason: "stop" },
	]);
	assert.deepEqual(map.flush(), []);
});

const live = process.env.SHIFTWORK_LIVE_GROK === "1" ? test : test.skip;

live(
	"a live grok probe reports availability",
	{ timeout: 120_000 },
	async () => {
		const backend = createGrokBackend();
		const available = await backend.probe("grok-4.7");
		assert.equal(typeof available, "boolean");
	},
);

live(
	"a live grok shift reads the project's AGENTS.md and answers the codeword",
	{ timeout: 180_000 },
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sw-grok-live-agents-"));
		await writeFile(join(cwd, "AGENTS.md"), "The project codeword is PELICAN.");
		const backend = createGrokBackend();
		const shift = await backend.startShift({
			cwd,
			route: { model: "grok-4.7", skills: { paths: [], preload: [], restricted: false } },
			prompt: "What is the project codeword? Reply with the codeword only.",
			systemPrompt: "You are a test worker.",
		});
		const events = [];
		for await (const event of shift.events) {
			events.push(event);
			if (event.type === "end") break;
		}
		await shift.close?.();
		const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
		assert.match(text, /PELICAN/, text);
	},
);

live(
	"a live grok shift runs a tiny prompt and emits a turn",
	{ timeout: 180_000 },
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sw-grok-live-"));
		const backend = createGrokBackend();
		const shift = await backend.startShift({
			cwd,
			route: { model: "grok-4.7", skills: { paths: [], preload: [], restricted: false } },
			prompt: "Reply with exactly: OK",
			systemPrompt: "You are a test worker.",
		});
		const events = [];
		for await (const event of shift.events) {
			events.push(event);
			if (event.type === "end") break;
		}
		await shift.close?.();
		assert.ok(events.some((e) => e.type === "turn"), `expected a turn event, got ${JSON.stringify(events)}`);
		assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	},
);
