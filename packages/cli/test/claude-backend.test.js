import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createClaudeBackend, mapClaudeEvent } from "../src/claude-backend.js";

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

test("a fake claude binary drives a success run to text, turn, usage and end", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [
			{ type: "text", text: "Implemented." },
			{ type: "usage", input_tokens: 10, output_tokens: 5, cost_usd: 0.0123 },
			{ type: "done" },
		],
	});

	assert.ok(events.some((e) => e.type === "text" && e.text === "Implemented."));
	const turn = events.find((e) => e.type === "turn");
	assert.ok(turn);
	assert.deepEqual(turn.usage, { input: 10, output: 5, totalTokens: 15 });
	assert.equal(turn.costUsd, 0.0123);
	assert.equal(events.at(-1).type, "end");
});

test("a usage-limit error cools claude and is reported as an error event", { timeout: 30_000 }, async () => {
	const { events } = await shiftWith({
		script: [
			{ type: "error", message: "Usage limit reached. Resets at 2026-10-01T00:00:00Z." },
			{ type: "done" },
		],
	});

	const error = events.find((e) => e.type === "error");
	assert.ok(error);
	assert.match(error.message, /Usage limit reached/);
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
console.log(JSON.stringify({ type: "done" }));
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
fs.writeFileSync(process.env.SHIFTWORK_RECORD_PLUGIN ?? "missing", pluginDir);
console.log(JSON.stringify({ type: "done" }));
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

	const pluginDir = await readFile(record, "utf8");
	const link = join(pluginDir, "skills", basename(skill));
	const target = await readFile(join(link, "SKILL.md"), "utf8");
	assert.equal(target, "Skill body.");
});

test("mapClaudeEvent ignores unknown events and maps usage to a turn", () => {
	assert.deepEqual(mapClaudeEvent({ type: "ping" }), []);
	const [turn] = mapClaudeEvent({ type: "usage", input_tokens: 3, output_tokens: 2, cost_usd: 0.5 });
	assert.deepEqual(turn, { type: "turn", usage: { input: 3, output: 2, totalTokens: 5 }, costUsd: 0.5 });
	const [text] = mapClaudeEvent({ type: "text", text: "hi" });
	assert.deepEqual(text, { type: "text", text: "hi" });
	const [context] = mapClaudeEvent({ type: "context", tokens: 800, context_window: 8000 });
	assert.equal(context.type, "context");
	assert.equal(context.tokens, 800);
	assert.equal(context.contextWindow, 8000);
	const [end] = mapClaudeEvent({ type: "done", stop_reason: "end_turn" });
	assert.deepEqual(end, { type: "end", stopReason: "end_turn" });
});

const live = process.env.SHIFTWORK_LIVE_CLAUDE === "1";
(live ? test : test.skip)("live claude answers a tiny prompt", { timeout: 120_000 }, async () => {
	const backend = createClaudeBackend();
	const ok = await backend.probe("sonnet");
	if (!ok) {
		console.log("Claude Code not installed or rate-limited; skipping live check");
		return;
	}
	const cwd = await mkdtemp(join(tmpdir(), "sw-claude-live-"));
	const shift = await backend.startShift({
		cwd,
		route: { model: "sonnet", thinking: "low", skills: { paths: [], preload: [], restricted: false } },
		prompt: "Reply with exactly: OK",
		systemPrompt: "You are a helpful assistant.",
	});
	const events = [];
	for await (const event of shift.events) {
		events.push(event);
		if (event.type === "end") break;
	}
	await shift.close?.();
	assert.ok(events.some((e) => e.type === "text" && /OK/.test(e.text)));
	assert.equal(events.at(-1)?.type, "end");
});
