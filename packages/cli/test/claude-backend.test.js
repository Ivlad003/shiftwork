import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createClaudeBackend, createClaudeMapper } from "../src/claude-backend.js";

async function withFakeClaude(script) {
	const binDir = await mkdtemp(join(tmpdir(), "sw-claude-bin-"));
	const claudePath = join(binDir, "claude");
	await writeFile(
		claudePath,
		`#!/usr/bin/env node
const script = ${JSON.stringify(script)};
for (const line of script) console.log(JSON.stringify(line));
`,
	);
	await chmod(claudePath, 0o755);
	return { binDir, cleanup: () => rm(binDir, { recursive: true, force: true }) };
}

async function shiftWith({ script, env = {}, route = { model: "sonnet", thinking: "low" }, skills = { paths: [], preload: [], restricted: false } } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "sw-claude-"));
	const { binDir, cleanup } = await withFakeClaude(script);
	const backend = createClaudeBackend({ command: "claude", env: { PATH: `${binDir}:${process.env.PATH}`, ...env } });
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

const recorded = readFileSync(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

test("a recorded real Claude Code transcript maps to two turns, the reply text, the cost and a clean end", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({ script: recorded });

	const turns = events.filter((e) => e.type === "turn");
	assert.equal(turns.length, 2, "two assistant messages; their repeated lines count once");
	assert.ok(turns[0].usage.input > 10_000, "context includes cache creation and cache reads");
	assert.ok(events.some((e) => e.type === "text" && /done/i.test(e.text)));
	assert.deepEqual(events.find((e) => e.type === "cost"), { type: "cost", costUsd: 0.0257268 });
	assert.ok(events.some((e) => e.type === "context" && e.tokens > 10_000));
	assert.deepEqual(events.at(-1), { type: "end", stopReason: "stop" });
	assert.equal(events.filter((e) => e.type === "end").length, 1);
});

test("a usage-limit error cools claude and is reported as an error event", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [
			{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1790812800 } },
			{ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached", num_turns: 0 },
		],
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /usage limit reached/i);
	const { classifyError } = await import("shiftwork-core");
	const classified = classifyError(error.message);
	assert.equal(classified?.kind, "usage");
	assert.equal(classified?.resetAt?.toISOString(), "2026-10-01T00:00:00.000Z");
	assert.equal(events.at(-1).type, "end");
});

test("a missing claude binary returns an error shift that ends immediately", { timeout: 30_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sw-claude-missing-"));
	const emptyBin = await mkdtemp(join(tmpdir(), "sw-empty-bin-"));
	const backend = createClaudeBackend({ command: "claude", env: { PATH: emptyBin } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "sonnet", thinking: "low", skills: { paths: [], preload: [], restricted: false } },
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

test("preloaded skills are prepended to the system prompt passed to claude", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-claude-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "---\nname: alpha\n---\nAlpha preloaded body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-claude-preload-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-claude-bin-"));
	const claudePath = join(binDir, "claude");
	await writeFile(
		claudePath,
		`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const idx = args.indexOf("--append-system-prompt");
const workerFile = args[idx + 1];
const worker = fs.readFileSync(workerFile, "utf8");
fs.writeFileSync(process.env.SHIFTWORK_RECORD_SYSTEM ?? "missing", worker);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0 }));
`,
	);
	await chmod(claudePath, 0o755);

	const record = join(cwd, "shiftwork-system.md");
	const backend = createClaudeBackend({ command: "claude", env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_SYSTEM: record } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "sonnet", thinking: "low", skills: { paths: [skill], preload: [skill], restricted: true } },
		prompt: "Do the ticket.",
		systemPrompt: "Worker prompt.",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	const system = await readFile(record, "utf8");
	assert.match(system, /Worker prompt\./);
	assert.match(system, /Alpha preloaded body\./);
});

test("restricted skills are delivered as a generated plugin dir with symlinks", { timeout: 30_000 }, async () => {
	const skill = await mkdtemp(join(tmpdir(), "sw-claude-plugin-skill-"));
	await mkdir(skill, { recursive: true });
	await writeFile(join(skill, "SKILL.md"), "Skill body.");

	const cwd = await mkdtemp(join(tmpdir(), "sw-claude-plugin-"));
	const binDir = await mkdtemp(join(tmpdir(), "sw-claude-bin-"));
	const claudePath = join(binDir, "claude");
	await writeFile(
		claudePath,
		`#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const idx = args.indexOf("--plugin-dir");
const pluginDir = args[idx + 1];
const skillDir = fs.readdirSync(pluginDir + "/skills")[0];
fs.writeFileSync(process.env.SHIFTWORK_RECORD_PLUGIN ?? "missing", JSON.stringify({ skillDir, body: fs.readFileSync(pluginDir + "/skills/" + skillDir + "/SKILL.md", "utf8") }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0 }));
`,
	);
	await chmod(claudePath, 0o755);

	const record = join(cwd, "shiftwork-plugin-dir.txt");
	const backend = createClaudeBackend({ command: "claude", env: { PATH: `${binDir}:${process.env.PATH}`, SHIFTWORK_RECORD_PLUGIN: record } });
	const shift = await backend.startShift({
		cwd,
		route: { model: "sonnet", thinking: "low", skills: { paths: [skill], preload: [], restricted: true } },
		prompt: "Do the ticket.",
		systemPrompt: "sys",
	});
	for await (const event of shift.events) {
		if (event.type === "end") break;
	}
	await shift.close?.();

	// The plugin dir is temporary: the fake claude read the skill through it while the shift ran.
	const seen = JSON.parse(await readFile(record, "utf8"));
	assert.deepEqual(seen, { skillDir: basename(skill), body: "Skill body." });
});

test("the Claude mapper counts an assistant message once across its lines and ignores unknown events", () => {
	const map = createClaudeMapper();
	const line = (content) => ({ type: "assistant", message: { id: "m1", model: "claude-haiku", content, usage: { input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 3 } } });
	assert.deepEqual(map({ type: "system", subtype: "thinking_tokens" }), []);
	const first = map(line([{ type: "thinking", thinking: "…" }]));
	const second = map(line([{ type: "text", text: "hi" }]));
	assert.deepEqual(first, [
		{ type: "turn", model: "claude-haiku", usage: { input: 10, output: 3, totalTokens: 13 }, costUsd: 0 },
		{ type: "context", tokens: 10 },
	]);
	assert.deepEqual(second, [{ type: "text", text: "hi" }]);
	assert.deepEqual(map({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), []);
});
